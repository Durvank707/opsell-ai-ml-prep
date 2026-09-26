"""Env-gated, server-only Supabase persistence.

The default application path is the local, per-user :class:`TenantWorkspace`.
When ``USE_SUPABASE`` is explicitly enabled, this module provides a small
stdlib-only PostgREST adapter for the canonical ``public.sales`` table.  It is
intentionally server-side: the service-role key is read from the environment,
used only for server-to-server requests, and never returned through an API
response.

Security invariants
-------------------

* Every remote read and write includes an explicit ``user_id`` predicate or
  ``user_id`` value.  The service role bypasses RLS, so application-side
  scoping is still mandatory.
* Canonical rows are validated before they are sent to the remote store.
* Sales, product metadata, and append-only audit entries have explicit,
  user-scoped adapters. They remain opt-in at the workspace boundary so a
  partially migrated deployment cannot claim a remote write it did not make.
* A failed request never fabricates a successful result or silently falls back
  to a different tenant's data.
* The local ``USE_SUPABASE=false`` path remains a pure pass-through for callers
  that explicitly use ``sync_local_shadow``.

No Supabase SDK is required; the adapter uses ``urllib`` so importing the
backend does not add a heavy or browser-reachable dependency.  The adapter
covers the canonical ``sales``, ``products``, and ``audit_entries`` tables.
Forecasts/recommendations remain derived data and can be added as a later
module. V2 routes use the server-side JWT verifier in ``backend.auth`` and pass
only the signed tenant identity into this adapter; a caller-provided
``user_id`` is never used as the authentication identity.
"""

from __future__ import annotations

import json
import math
import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from backend.config import (
    REPO_ROOT,
    _bounded_env_float,
    _is_valid_supabase_url,
    _load_dotenv_files,
    _looks_like_placeholder,
    _positive_env_int,
)


class SupabasePersistenceError(RuntimeError):
    """A safe, user-facing persistence failure."""


_ALLOWED_TABLES = {"sales", "products", "audit_entries"}
_MAX_ERROR_BODY = 2048


class _NoRedirectHandler(HTTPRedirectHandler):
    """Never forward the service-role header through an HTTP redirect."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


_SUPABASE_OPENER = build_opener(_NoRedirectHandler)


def _urlopen(request: Request, timeout: float):
    """Indirection kept replaceable for transport tests."""

    return _SUPABASE_OPENER.open(request, timeout=timeout)


def _env_use_supabase() -> bool:
    """Read the explicit integration gate without importing a Supabase SDK."""

    _load_dotenv_files()
    raw = os.getenv("USE_SUPABASE", "").strip().lower()
    if raw not in {"", "0", "1", "true", "false", "yes", "no", "on", "off"}:
        raise SupabasePersistenceError(
            "USE_SUPABASE must be one of true/false, 1/0, yes/no, or on/off."
        )
    return raw in {"1", "true", "yes", "on"}


def _service_role_creds() -> Dict[str, str]:
    """Return validated server-only credentials or fail closed."""

    if not _env_use_supabase():
        raise SupabasePersistenceError(
            "Supabase access is disabled. Set USE_SUPABASE=true on the server "
            "before requesting a service-role connection."
        )
    url = os.getenv("SUPABASE_URL", "").strip()
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise SupabasePersistenceError(
            "USE_SUPABASE is on but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY "
            "are not both set in the environment. Refusing to fabricate a "
            "connection to a project we don't have credentials for."
        )
    if (
        not _is_valid_supabase_url(url)
        or _looks_like_placeholder(url)
        or _looks_like_placeholder(key)
    ):
        raise SupabasePersistenceError(
            "USE_SUPABASE is on but the Supabase URL or service-role key is "
            "invalid or still a placeholder. Configure real server-side credentials."
        )
    return {"url": url, "service_role_key": key}


def supabase_enabled() -> bool:
    """True only when ``USE_SUPABASE`` is explicitly enabled."""

    return _env_use_supabase()


def service_role_headers() -> Dict[str, str]:
    """Build PostgREST headers for this server process only.

    The returned mapping contains the secret and must never be serialized into
    an API response or sent to a browser.  It is kept here as a small,
    auditable server boundary rather than being duplicated in route modules.
    """

    creds = _service_role_creds()
    return {
        "apikey": creds["service_role_key"],
        "Authorization": f"Bearer {creds['service_role_key']}",
        "Content-Type": "application/json",
    }


def rls_sql_path() -> str:
    """Return the path to the tenant RLS migration."""

    return str(REPO_ROOT / "supabase" / "migrations" / "0001_rls.sql")


def _request_timeout() -> float:
    return _bounded_env_float(
        "SUPABASE_REQUEST_TIMEOUT_S",
        10.0,
        minimum=0.1,
        maximum=120.0,
    )


def _max_upload_rows() -> int:
    return _positive_env_int("MAX_UPLOAD_ROWS", 250000)


def _audit_batch_size() -> int:
    # Audit rows are small, but a full upload can mean hundreds of thousands of
    # them. Chunking keeps each POST body bounded and keeps a single request
    # from becoming the thing that fails under load.
    return min(500, _max_upload_rows())


def _fetch_page_size() -> int:
    # PostgREST's default/max row window is commonly 1000.  Keeping the page
    # at or below that value avoids server-side silent truncation while the
    # fetch loop below still verifies the complete configured row budget.
    return min(1000, _max_upload_rows())


def _request_url(
    creds: Mapping[str, str], table: str, query: Optional[Mapping[str, Any]]
) -> str:
    if table not in _ALLOWED_TABLES:
        raise SupabasePersistenceError("Unsupported Supabase table.")
    url = str(creds["url"]).rstrip("/") + "/rest/v1/" + quote(table, safe="")
    if query:
        url += "?" + urlencode(
            [(key, str(value)) for key, value in query.items() if value is not None],
            doseq=False,
        )
    return url


def _decode_response(response: Any) -> Any:
    try:
        raw = response.read()
    except (AttributeError, OSError) as exc:
        raise SupabasePersistenceError(
            "Supabase returned an unreadable response; no local change was assumed."
        ) from exc
    if not raw:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise SupabasePersistenceError(
            "Supabase returned invalid JSON; no local change was assumed."
        ) from exc


def _request(
    method: str,
    *,
    table: str,
    query: Optional[Mapping[str, Any]] = None,
    body: Optional[Any] = None,
    prefer: Optional[str] = None,
) -> Any:
    """Issue one bounded PostgREST request and normalize transport errors."""

    creds = _service_role_creds()
    headers = {
        "apikey": creds["service_role_key"],
        "Authorization": f"Bearer {creds['service_role_key']}",
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        try:
            data = json.dumps(
                body,
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise SupabasePersistenceError(
                "Canonical persistence data could not be encoded as JSON."
            ) from exc
        headers["Content-Type"] = "application/json"
    if prefer:
        headers["Prefer"] = prefer

    request = Request(
        _request_url(creds, table, query),
        data=data,
        headers=headers,
        method=method.upper(),
    )
    try:
        with _urlopen(request, timeout=_request_timeout()) as response:
            return _decode_response(response)
    except SupabasePersistenceError:
        raise
    except HTTPError as exc:
        # Do not include the response body: a proxy or PostgREST error can echo
        # request values, and no caller needs that raw text to recover.
        try:
            exc.read(_MAX_ERROR_BODY)
        except (AttributeError, OSError):
            pass
        raise SupabasePersistenceError(
            f"Supabase request failed with HTTP status {exc.code}; no local "
            "change was assumed."
        ) from None
    except (URLError, OSError, TimeoutError) as exc:
        raise SupabasePersistenceError(
            "Supabase could not be reached; no local change was assumed."
        ) from exc


def _validate_user_id(user_id: Any) -> str:
    if user_id is None:
        raise ValueError("user_id is required for Supabase persistence.")
    normalized = str(user_id).strip()
    if not normalized:
        raise ValueError("user_id is required for Supabase persistence.")
    return normalized


def _canonical_sales_payloads(
    user_id: str, rows: Sequence[Mapping[str, Any]]
) -> List[Dict[str, Any]]:
    """Validate rows and convert them to the remote sales wire shape."""

    from backend.contracts import SALES_RECORD
    from backend.validation import SEV_ERROR, validate_rows

    payloads: List[Dict[str, Any]] = []
    seen_business_keys = set()
    for row_number, raw in enumerate(rows, start=1):
        if not isinstance(raw, Mapping):
            raise SupabasePersistenceError(
                f"Sales row {row_number} must be a JSON object."
            )
        if "user_id" in raw and str(raw.get("user_id")) != user_id:
            raise SupabasePersistenceError(
                f"Sales row {row_number} belongs to another user and was refused."
            )
        candidate = {
            key: value
            for key, value in raw.items()
            if key not in {"user_id", "id", "created_at", "updated_at"}
        }
        mapping = {
            field.canonical_name: field.canonical_name
            for field in SALES_RECORD.fields
            if field.canonical_name in candidate
        }
        report = validate_rows(
            [candidate],
            SALES_RECORD,
            mapping=mapping,
            columns=list(candidate),
        )
        if report.rejected_rows or any(
            problem.severity == SEV_ERROR for problem in report.schema_problems
        ):
            raise SupabasePersistenceError(
                f"Sales row {row_number} failed canonical validation; nothing "
                "was written."
            )
        values = report.rows[0].values
        payload: Dict[str, Any] = {"user_id": user_id}
        for field in SALES_RECORD.fields:
            name = field.canonical_name
            if name not in values:
                continue
            value = values[name]
            if name == "date":
                value = value.isoformat() if hasattr(value, "isoformat") else str(value)
            elif name == "units_sold":
                value = int(value)
            elif name == "price":
                value = float(value)
            elif name == "promotion":
                value = bool(value)
            payload[name] = value
        business_key = (payload["product_id"], payload["date"])
        if business_key in seen_business_keys:
            raise SupabasePersistenceError(
                f"Sales rows contain duplicate product/date key {business_key}; "
                "the batch was refused."
            )
        seen_business_keys.add(business_key)
        payloads.append(payload)
    return payloads


def upsert_sales(
    user_id: str, rows: Sequence[Mapping[str, Any]]
) -> List[Dict[str, Any]]:
    """Upsert canonical sales for exactly one user.

    The ``on_conflict`` clause corresponds to the unique index in
    ``0002_sales_upsert.sql``.  A successful HTTP response returns the payloads
    that were sent; failures raise :class:`SupabasePersistenceError` and never
    return a fabricated success value.
    """

    normalized_user = _validate_user_id(user_id)
    try:
        materialized_rows = list(rows)
    except (TypeError, ValueError) as exc:
        raise SupabasePersistenceError(
            "Sales rows must be a finite sequence of JSON objects."
        ) from exc
    if len(materialized_rows) > _max_upload_rows():
        raise SupabasePersistenceError(
            "Sales persistence input exceeds the server upload row limit."
        )
    payloads = _canonical_sales_payloads(normalized_user, materialized_rows)
    if not payloads:
        return []
    _request(
        "POST",
        table="sales",
        query={"on_conflict": "user_id,product_id,date"},
        body=payloads,
        prefer="resolution=merge-duplicates,return=minimal",
    )
    return payloads


def _normalize_remote_rows(
    user_id: str, response: Any
) -> List[Dict[str, Any]]:
    if not isinstance(response, list):
        raise SupabasePersistenceError(
            "Supabase sales response was not a list; no local data was assumed."
        )
    normalized: List[Dict[str, Any]] = []
    for row in response:
        if not isinstance(row, Mapping):
            raise SupabasePersistenceError(
                "Supabase returned a non-object sales row; no local data was assumed."
            )
        if "user_id" not in row:
            raise SupabasePersistenceError(
                "Supabase sales response omitted user_id; it was refused."
            )
        if str(row.get("user_id")) != user_id:
            # A service-role query should still be checked before accepting a
            # response.  This is the application-side tenant boundary.
            raise SupabasePersistenceError(
                "Supabase returned a sales row for another user; it was refused."
            )
        payloads = _canonical_sales_payloads(user_id, [row])
        wire = payloads[0]
        normalized.append(
            {key: value for key, value in wire.items() if key != "user_id"}
        )
    return normalized


def fetch_sales(
    user_id: str, *, product_id: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Fetch all pages belonging to exactly one user.

    Pagination is explicit and capped.  A partial response is never marked as
    a complete hydration merely because the server returned a short page.
    """

    normalized_user = _validate_user_id(user_id)
    max_rows = _max_upload_rows()
    page_size = _fetch_page_size()
    base_query: Dict[str, Any] = {
        "select": "user_id,product_id,date,units_sold,price,category,promotion",
        "user_id": f"eq.{normalized_user}",
        "order": "date.asc,product_id.asc",
    }
    if product_id is not None:
        normalized_product = str(product_id).strip()
        if not normalized_product:
            raise ValueError("product_id cannot be blank.")
        base_query["product_id"] = f"eq.{normalized_product}"

    collected: List[Any] = []
    offset = 0
    # Include one page beyond the configured row budget so an exact multiple
    # of the page size is proved complete by the following empty page. Without
    # that sentinel page, a perfectly full 250,000-row response would look
    # indistinguishable from truncation and be rejected.
    max_pages = (max_rows // page_size) + 3
    for page_number in range(1, max_pages + 1):
        query = dict(base_query)
        query["limit"] = page_size
        query["offset"] = offset
        response = _request("GET", table="sales", query=query)
        if not isinstance(response, list):
            # Reuse the same safe response-shape error as the normalizer.
            return _normalize_remote_rows(normalized_user, response)
        collected.extend(response)
        if len(collected) > max_rows:
            raise SupabasePersistenceError(
                "Supabase sales response exceeds the server row limit; it was not cached."
            )
        if len(response) < page_size:
            break
        offset += len(response)
    else:
        raise SupabasePersistenceError(
            "Supabase sales pagination exceeded the configured row limit; "
            "the response was not cached."
        )

    return _normalize_remote_rows(normalized_user, collected)


# ---------------------------------------------------------------------------
# Optional product and audit persistence
# ---------------------------------------------------------------------------


def _canonical_product_payloads(
    user_id: str, rows: Sequence[Mapping[str, Any]]
) -> List[Dict[str, Any]]:
    """Validate product rows and build an explicit tenant-owned wire shape."""

    from backend.contracts import PRODUCT_RECORD
    from backend.validation import SEV_ERROR, validate_rows

    payloads: List[Dict[str, Any]] = []
    seen: set[Tuple[str, str]] = set()
    for row_number, raw in enumerate(rows, start=1):
        if not isinstance(raw, Mapping):
            raise SupabasePersistenceError(
                f"Product row {row_number} must be a JSON object."
            )
        if "user_id" in raw and str(raw.get("user_id")) != user_id:
            raise SupabasePersistenceError(
                f"Product row {row_number} belongs to another user and was refused."
            )
        candidate = {
            key: value
            for key, value in raw.items()
            if key not in {"user_id", "id", "created_at", "updated_at"}
        }
        mapping = {
            field.canonical_name: field.canonical_name
            for field in PRODUCT_RECORD.fields
            if field.canonical_name in candidate
        }
        report = validate_rows(
            [candidate],
            PRODUCT_RECORD,
            mapping=mapping,
            columns=list(candidate),
        )
        if report.rejected_rows or any(
            problem.severity == SEV_ERROR for problem in report.schema_problems
        ):
            raise SupabasePersistenceError(
                f"Product row {row_number} failed canonical validation; nothing "
                "was written."
            )
        values = report.rows[0].values
        payload: Dict[str, Any] = {"user_id": user_id}
        for field in PRODUCT_RECORD.fields:
            name = field.canonical_name
            if name not in values:
                continue
            value = values[name]
            if name == "expected_arrival_date":
                value = value.isoformat() if hasattr(value, "isoformat") else str(value)
            elif name in {
                "current_stock", "lead_time_days", "open_order_qty"
            }:
                value = int(value)
            elif name in {
                "safety_stock", "reorder_point", "unit_cost", "forecast_error_std"
            }:
                value = float(value)
            payload[name] = value
        key = (user_id, str(payload["product_id"]))
        if key in seen:
            raise SupabasePersistenceError(
                f"Product rows contain duplicate product key {key}; the batch was refused."
            )
        seen.add(key)
        payloads.append(payload)
    return payloads


def upsert_products(
    user_id: str, rows: Sequence[Mapping[str, Any]]
) -> List[Dict[str, Any]]:
    """Upsert canonical product metadata for exactly one user."""

    normalized_user = _validate_user_id(user_id)
    try:
        materialized = list(rows)
    except (TypeError, ValueError) as exc:
        raise SupabasePersistenceError(
            "Product rows must be a finite sequence of JSON objects."
        ) from exc
    if len(materialized) > _max_upload_rows():
        raise SupabasePersistenceError(
            "Product persistence input exceeds the server upload row limit."
        )
    payloads = _canonical_product_payloads(normalized_user, materialized)
    if not payloads:
        return []
    _request(
        "POST",
        table="products",
        query={"on_conflict": "user_id,product_id"},
        body=payloads,
        prefer="resolution=merge-duplicates,return=minimal",
    )
    return payloads


def fetch_products(user_id: str) -> List[Dict[str, Any]]:
    """Fetch and revalidate all product rows for one user."""

    normalized_user = _validate_user_id(user_id)
    max_rows = _max_upload_rows()
    page_size = _fetch_page_size()
    base_query: Dict[str, Any] = {
        "select": (
            "user_id,product_id,product_name,category,current_stock,"
            "lead_time_days,safety_stock,reorder_point,open_order_qty,"
            "unit_cost,expected_arrival_date,forecast_error_std"
        ),
        "user_id": f"eq.{normalized_user}",
        "order": "product_id.asc",
    }
    collected: List[Any] = []
    offset = 0
    max_pages = (max_rows // page_size) + 2
    for _page_number in range(1, max_pages + 1):
        query = dict(base_query)
        query["limit"] = page_size
        query["offset"] = offset
        response = _request("GET", table="products", query=query)
        if not isinstance(response, list):
            raise SupabasePersistenceError(
                "Supabase product response was not a list; no data was assumed."
            )
        collected.extend(response)
        if len(collected) > max_rows:
            raise SupabasePersistenceError(
                "Supabase product response exceeds the server row limit."
            )
        if len(response) < page_size:
            break
        offset += len(response)
    else:
        raise SupabasePersistenceError(
            "Supabase product pagination exceeded the configured row limit."
        )
    return _normalize_product_rows(normalized_user, collected)


def _normalize_product_rows(
    user_id: str, response: Sequence[Mapping[str, Any]]
) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for row in response:
        if not isinstance(row, Mapping):
            raise SupabasePersistenceError(
                "Supabase returned a non-object product row; no data was assumed."
            )
        if "user_id" not in row or str(row.get("user_id")) != user_id:
            raise SupabasePersistenceError(
                "Supabase returned a product row for another user; it was refused."
            )
        wire = _canonical_product_payloads(user_id, [row])[0]
        normalized.append({key: value for key, value in wire.items() if key != "user_id"})
    return normalized


def delete_product(user_id: str, product_id: str) -> int:
    """Delete one product and its sales rows for exactly one user.

    Both deletes are user-scoped by the ``user_id`` filter, so this can only
    ever remove the calling tenant's own rows. Raises rather than reporting a
    partial delete if either table cannot be updated.
    """

    normalized_user = _validate_user_id(user_id)
    normalized_product = str(product_id or "").strip()
    if not normalized_product or len(normalized_product) > 255:
        raise SupabasePersistenceError("Product id is invalid.")

    scope = {"user_id": f"eq.{normalized_user}", "product_id": f"eq.{normalized_product}"}
    for table in ("sales", "products"):
        _request("DELETE", table=table, query=scope, prefer="return=minimal")
    return 1


def _redact_persistence_value(value: Any) -> Any:
    """Keep credential-shaped values out of remote audit JSON."""

    sensitive_markers = (
        "password", "secret", "authorization", "access_token", "refresh_token",
        "api_key", "apikey", "service_role", "bearer", "jwt",
    )
    if isinstance(value, Mapping):
        return {
            str(key): (
                "[redacted]"
                if any(marker in str(key).casefold() for marker in sensitive_markers)
                else _redact_persistence_value(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_redact_persistence_value(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"(?i)\\bBearer\\s+[^\\s,;]+", "Bearer [redacted]", value)
        value = re.sub(
            r"(?i)\\beyJ[A-Za-z0-9_-]{20,}(?:\\.[A-Za-z0-9_-]+){1,2}\\b",
            "[redacted]",
            value,
        )
        return value
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _audit_payload(user_id: str, entry: Any) -> Dict[str, Any]:
    if isinstance(entry, Mapping):
        source: Mapping[str, Any] = entry
        entry_id = source.get("id")
        action = source.get("action")
        product_id = source.get("product_id")
        detail = source.get("detail", {})
        created_at = source.get("created_at")
    else:
        entry_id = getattr(entry, "id", None)
        action = getattr(entry, "action", None)
        product_id = getattr(entry, "product_id", None)
        detail = getattr(entry, "detail", {})
        created_at = getattr(entry, "created_at", None)
    if entry_id is None:
        entry_id = os.urandom(12).hex()
    entry_id = str(entry_id).strip()
    action = str(action or "").strip()
    if not entry_id or len(entry_id) > 128 or not action or len(action) > 128:
        raise SupabasePersistenceError("Audit entry id/action is invalid.")
    if not isinstance(detail, Mapping):
        raise SupabasePersistenceError("Audit entry detail must be a JSON object.")
    detail = _redact_persistence_value(detail)
    if not isinstance(detail, Mapping):
        raise SupabasePersistenceError("Audit entry detail must be a JSON object.")
    if product_id is not None:
        product_id = str(product_id).strip()
        if not product_id or len(product_id) > 255:
            raise SupabasePersistenceError("Audit product_id is invalid.")
    if created_at is None:
        created_at = datetime.now(timezone.utc).isoformat()
    created_at = str(created_at)
    try:
        parsed_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SupabasePersistenceError("Audit created_at is not ISO-8601.") from exc
    if parsed_at.tzinfo is None:
        parsed_at = parsed_at.replace(tzinfo=timezone.utc)
    try:
        json.dumps(detail, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise SupabasePersistenceError("Audit detail is not JSON serializable.") from exc
    return {
        "id": entry_id,
        "user_id": user_id,
        "action": action,
        "product_id": product_id,
        "detail": dict(detail),
        "created_at": parsed_at.astimezone(timezone.utc).isoformat(),
    }


def append_audit_entries(user_id: str, entries: Sequence[Any]) -> List[Dict[str, Any]]:
    """Append a batch of immutable, tenant-owned audit records.

    Every entry is validated and stamped with the same normalized ``user_id``
    before a single request is issued, so a batch can never mix owners. The
    batch is sent in bounded chunks: a large ingest must not build one
    unbounded request body, and a partial chunk failure raises rather than
    reporting a success that did not occur.
    """

    normalized_user = _validate_user_id(user_id)
    try:
        materialized = list(entries)
    except (TypeError, ValueError) as exc:
        raise SupabasePersistenceError(
            "Audit entries must be a finite sequence of records."
        ) from exc
    if not materialized:
        return []

    payloads = [_audit_payload(normalized_user, entry) for entry in materialized]
    seen: set = set()
    for payload in payloads:
        if payload["id"] in seen:
            raise SupabasePersistenceError(
                f"Audit batch contains duplicate entry id {payload['id']!r}; "
                "the batch was refused."
            )
        seen.add(payload["id"])

    chunk_size = _audit_batch_size()
    for start in range(0, len(payloads), chunk_size):
        _request(
            "POST",
            table="audit_entries",
            body=payloads[start:start + chunk_size],
            prefer="return=minimal",
        )
    return payloads


def append_audit_entry(user_id: str, entry: Any) -> Dict[str, Any]:
    """Append one immutable, tenant-owned audit record.

    Thin wrapper over :func:`append_audit_entries` so there is exactly one
    audit write path with one set of validation and redaction rules.
    """

    return append_audit_entries(user_id, [entry])[0]


def fetch_audit_entries(
    user_id: str, *, limit: int = 1000
) -> List[Dict[str, Any]]:
    """Fetch a bounded, user-scoped audit page in chronological order."""

    normalized_user = _validate_user_id(user_id)
    try:
        bounded_limit = max(1, min(int(limit), 1000))
    except (TypeError, ValueError) as exc:
        raise SupabasePersistenceError("Audit limit must be an integer.") from exc
    response = _request(
        "GET",
        table="audit_entries",
        query={
            "select": "id,user_id,action,product_id,detail,created_at",
            "user_id": f"eq.{normalized_user}",
            "order": "created_at.asc",
            "limit": bounded_limit,
        },
    )
    if not isinstance(response, list):
        raise SupabasePersistenceError(
            "Supabase audit response was not a list; no data was assumed."
        )
    normalized: List[Dict[str, Any]] = []
    for row in response:
        if not isinstance(row, Mapping) or str(row.get("user_id")) != normalized_user:
            raise SupabasePersistenceError(
                "Supabase returned an audit row for another user; it was refused."
            )
        normalized.append(_audit_payload(normalized_user, row))
    return normalized


def sync_local_shadow(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Keep the legacy local-shadow behavior safe and explicit.

    With Supabase off this is a pure pass-through.  With Supabase on, callers
    must use :func:`upsert_sales` with an explicit user; this legacy function
    deliberately refuses to guess an identity or claim a remote write.
    """

    if not supabase_enabled():
        return rows
    _service_role_creds()
    raise SupabasePersistenceError(
        "sync_local_shadow requires an explicit user-scoped upsert_sales call "
        "when USE_SUPABASE=true; no rows were invented or written."
    )


def friendly_hint_for(exc: BaseException) -> str:
    """Return a bounded message that cannot expose credentials or tracebacks."""

    if isinstance(exc, SupabasePersistenceError):
        return str(exc)[:300]
    if isinstance(exc, (RuntimeError, OSError)):
        return (
            "Supabase is unexpected here — but no secrets leaked and no row was "
            "silently substituted. Check USE_SUPABASE and your server-side env."
        )
    return "Unexpected failure while talking to Supabase."
