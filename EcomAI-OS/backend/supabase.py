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
#: A user-facing explanation is a sentence, not a dump. Bounded well below the
#: body cap so it survives being shown in a toast and copied into a support
#: ticket.
_MAX_EXPLANATION = 500


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
        # The body is read, bounded, and *classified* -- never echoed. A proxy
        # or PostgREST error can contain request values, credentials or a stack
        # trace, so the raw text is discarded after its documented error code
        # and field name have been extracted into a safe sentence.
        try:
            error_body = exc.read(_MAX_ERROR_BODY)
        except (AttributeError, OSError):
            error_body = b""
        raise SupabasePersistenceError(
            _explain_http_failure(table, exc.code, error_body)
        ) from None
    except (URLError, OSError, TimeoutError) as exc:
        raise SupabasePersistenceError(
            "Supabase could not be reached; no local change was assumed."
        ) from exc


#: Which migration brings the deployed table up to the canonical payload, named
#: only so the reader knows what to run. The sentences below supply the verb.
_SCHEMA_HINT = (
    "supabase/migrations/0007_full_schema.sql and "
    "supabase/migrations/0008_product_price_and_display_fields.sql"
)
_SALES_SCHEMA_HINT = (
    "supabase/migrations/0007_full_schema.sql and "
    "supabase/migrations/0009_sales_channel.sql"
)

#: PostgREST/Postgres error codes this adapter knows how to explain.
#:
#: Each value is a template. ``{field}`` is a phrase, not a bare name, because
#: not every code states one; ``{table}`` is the table the request was for and
#: ``{hint}`` is the migration that fixes a schema gap. A code that is not
#: listed falls back to a generic sentence, so an unknown failure degrades to a
#: short message rather than to a leaked body.
_ERROR_EXPLANATIONS = {
    # A canonical column has no home in the deployed table: a migration was
    # never applied, or PostgREST's schema cache predates the column.
    "PGRST204": (
        "The database cannot store the {table} row: {field} does not exist on "
        "that table. Run {hint}, then reload the schema cache (run: "
        "NOTIFY pgrst, 'reload schema'; in the Supabase SQL editor). No data "
        "was written."
    ),
    "42703": (
        "The database cannot store the {table} row: {field} does not exist on "
        "that table. Run {hint}, then reload the schema cache (run: "
        "NOTIFY pgrst, 'reload schema'; in the Supabase SQL editor). No data "
        "was written."
    ),
    # The batch disagreed with itself about which columns exist. Now impossible
    # from this adapter (every row carries the full canonical key set), so this
    # names a defect rather than blaming the tenant's file.
    "PGRST103": (
        "The batch of {table} rows was rejected because the rows did not all "
        "carry the same columns. Nothing was written. This is a server-side "
        "defect rather than a problem with your file; please try again."
    ),
    # A unique key the upsert depends on is missing from the table.
    "PGRST201": (
        "The {table} table has no unique key on the columns this upsert needs, "
        "so nothing was written. Run {hint} to create it."
    ),
    # The table itself is absent.
    "42P01": (
        "The {table} table does not exist in the database, so nothing was "
        "written. Run {hint} to create it."
    ),
    # A required (NOT NULL) column was absent or null.
    "23502": (
        "The database rejected the {table} write because {field} was empty, "
        "and that column cannot be empty. Nothing was written."
    ),
    # A value outside the range a CHECK constraint allows, e.g. the
    # current_stock >= 0 check the products table declares.
    "23514": (
        "The database rejected the {table} write because {field} is outside "
        "the range that table allows. Nothing was written."
    ),
    # The row violates the business key the upsert targets. The application
    # refuses an overwrite before it ever reaches this, so reaching it means two
    # writers disagreed; say so instead of echoing the conflicting key values.
    "23505": (
        "The database refused the {table} write because a row with the same "
        "value for {field} already exists. Nothing was overwritten."
    ),
    # The batch wrote fewer rows than it carried: a policy or trigger removed
    # rows the service role should have been able to write.
    "PT008": (
        "The database rejected the {table} write because the batch was "
        "filtered before it was saved, which usually means a Row Level "
        "Security policy is blocking this tenant. Nothing was written."
    ),
    "PGRST116": (
        "The database rejected the {table} write because the batch was "
        "filtered before it was saved, which usually means a Row Level "
        "Security policy is blocking this tenant. Nothing was written."
    ),
    # A value the column cannot hold: a string where a number/date is required.
    "22P02": (
        "The database could not read {field} as the type the {table} table "
        "requires, so the write was refused. Check the number and date formats "
        "in your file. Nothing was written."
    ),
    "22007": (
        "The database could not read {field} as a date in the format the "
        "{table} table expects, so the write was refused. Use YYYY-MM-DD. "
        "Nothing was written."
    ),
    # The service role was refused by the database itself.
    "42501": (
        "The database refused the {table} write for this tenant. Check the Row "
        "Level Security policies on that table. Nothing was written."
    ),
}


def _explain_http_failure(table: str, status: Optional[int], body: Any) -> str:
    """Turn one rejected request into a safe, actionable message.

    The response body is read only for its documented ``code`` and for a column
    name inside the message. The raw text is never included, so a response that
    echoes a request value, a token or a stack trace cannot reach the caller.
    """

    label = f"{table} table"
    hint = _SALES_SCHEMA_HINT if table == "sales" else _SCHEMA_HINT
    code = _error_code(body)
    field = _error_field(body)
    template = _ERROR_EXPLANATIONS.get(code or "")
    if template is not None:
        return template.format(
            table=table, hint=hint, field=_field_phrase(field)
        )[:_MAX_EXPLANATION]
    if status in (401, 403):
        return (
            f"Supabase refused the {label} request (HTTP {status}). The "
            "server's Supabase credentials or the table's Row Level Security "
            "policies rejected it; nothing was written."
        )[:_MAX_EXPLANATION]
    if status == 409:
        return (
            f"Supabase reported a conflict writing the {label} (HTTP 409). "
            "The row conflicts with a record that already exists; nothing was "
            "written."
        )[:_MAX_EXPLANATION]
    if status == 413:
        return (
            "The batch is larger than Supabase accepts in one request. Split "
            "the file into smaller parts and upload them one at a time; nothing "
            "was written."
        )[:_MAX_EXPLANATION]
    if status is not None and 500 <= int(status) < 600:
        return (
            f"Supabase could not complete the {label} request (HTTP {status}). "
            "This is a database-side problem; nothing was written."
        )[:_MAX_EXPLANATION]
    tail = (
        f"The database reported error code {code}, which this server does not "
        "recognise."
        if code
        else "The database returned no usable detail."
    )
    return (
        f"Supabase rejected the {label} request with HTTP status {status}; "
        f"nothing was written. {tail}"
    )[:_MAX_EXPLANATION]


def _field_phrase(field: Optional[str]) -> str:
    """Name a field when the database named one, without inventing one."""

    return f"the '{field}' field" if field else "one of the submitted fields"


def _error_code(body: Any) -> Optional[str]:
    """Read the documented error code from a PostgREST body, if it has one."""

    payload = _error_payload(body)
    if payload is None:
        return None
    code = payload.get("code")
    if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_]{1,16}", code):
        return code
    return None


_IDENTIFIER = r"[A-Za-z_][A-Za-z0-9_]{0,62}"
#: Where each documented Postgres/PostgREST message states the column it is
#: about. Only these shapes are read, and a captured name must be a plain
#: identifier, so an echoed sentence can never become a field name.
_ERROR_FIELD_PATTERNS = (
    # PGRST204: "Could not find the 'x' column of 'products' in the schema cache"
    re.compile(rf"['\"]({_IDENTIFIER})['\"] column"),
    # 42703 / 23502: 'column "x" of relation "y"' (quoting varies by version)
    re.compile(rf"\bcolumn ['\"]?({_IDENTIFIER})['\"]?(?= of relation|\b)"),
    # 23505: "Key (user_id,product_id)=... already exists."
    re.compile(rf"\bKey \(({_IDENTIFIER}(?:, ?{_IDENTIFIER})*)\)="),
)
#: ``products_current_stock_check`` -> ``current_stock``.
_CHECK_CONSTRAINT = re.compile(rf"constraint ['\"]({_IDENTIFIER})_check['\"]")


def _error_payload(body: Any) -> Optional[Dict[str, Any]]:
    """Decode a bounded PostgREST error body into a dict, or nothing."""

    if isinstance(body, (bytes, bytearray)):
        text = body.decode("utf-8", errors="replace")
    elif isinstance(body, str):
        text = body
    else:
        return None
    try:
        payload = json.loads(text)
    except (TypeError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _error_field(body: Any) -> Optional[str]:
    """Find the column or field a PostgREST message names, and only that."""

    payload = _error_payload(body)
    if payload is None:
        return None
    for source in (payload.get("message"), payload.get("details")):
        if not isinstance(source, str):
            continue
        for pattern in _ERROR_FIELD_PATTERNS:
            match = pattern.search(source)
            if match:
                names = [n.strip() for n in match.group(1).split(",")]
                usable = [
                    n for n in names if re.fullmatch(_IDENTIFIER, n.strip("\"' "))
                ]
                if usable:
                    # A composite key names several columns; the last one is
                    # the row's own identifier, which is the one to report.
                    return usable[-1]
        match = _CHECK_CONSTRAINT.search(source)
        if match:
            name = match.group(1)
            parts = name.split("_")
            return "_".join(parts[1:]) if len(parts) > 1 else name
    return None


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

    from backend.contracts import SALES_RECORD, sales_channel_label
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
            if name == "channel":
                # ``channel`` is part of the upsert key, so it is always sent
                # explicitly rather than left to the column default. Otherwise
                # two batches that both omitted the column would still collide
                # correctly, but a batch that supplied it and one that did not
                # would disagree about the key for the same logical row.
                payload[name] = sales_channel_label(values.get(name))
                continue
            # Every canonical field is emitted on every row, and a field the
            # source did not state is sent as an explicit null. See
            # ``_canonical_product_payloads`` for why the key set is uniform.
            value = values.get(name)
            if value is not None:
                if name == "date":
                    value = (
                        value.isoformat()
                        if hasattr(value, "isoformat")
                        else str(value)
                    )
                elif name == "units_sold":
                    value = int(value)
                elif name == "price":
                    value = float(value)
                elif name == "promotion":
                    value = bool(value)
            payload[name] = value
        business_key = (
            payload["product_id"],
            payload["date"],
            payload["channel"],
        )
        if business_key in seen_business_keys:
            raise SupabasePersistenceError(
                f"Sales rows contain duplicate product/date/channel key "
                f"{business_key}; the batch was refused."
            )
        seen_business_keys.add(business_key)
        payloads.append(payload)
    return payloads


def upsert_sales(
    user_id: str, rows: Sequence[Mapping[str, Any]]
) -> List[Dict[str, Any]]:
    """Upsert canonical sales for exactly one user.

    The ``on_conflict`` clause corresponds to the unique index in
    ``0009_sales_channel.sql``.  A successful HTTP response returns the payloads
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
        query={"on_conflict": "user_id,product_id,date,channel"},
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
        "select": (
            "user_id,product_id,date,units_sold,price,category,channel,promotion"
        ),
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


# Canonical product columns the remote schema declares NOT NULL, with the value
# to send when the source did not state one.
#
# `open_order_qty` is `not null default 0` (supabase/migrations/0003 and 0007).
# A Postgres default applies only when a column is *omitted*, and omitting keys
# is precisely what PostgREST refuses in a bulk insert -- the whole batch is
# rejected with "All object keys must match". So the uniform key set has to carry
# the column's own default instead of an explicit null, which is also what the
# tenant means by a catalog row that states no open order.
#
# The one consequence worth stating: re-importing a catalog CSV that omits the
# column resets an existing product's open orders to zero, where omitting the key
# would have left them alone. A file that carries the true figure carries it, and
# the alternative -- a write the database refuses outright -- helps nobody.
_PRODUCT_NOT_NULL_DEFAULTS: Dict[str, Any] = {"open_order_qty": 0}


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
            # Every canonical field is emitted on every row, so the whole batch
            # shares one key set. PostgREST rejects a bulk insert whose objects
            # disagree about their keys ("All object keys must match", HTTP
            # 400), which a mixed batch of rows -- one product with a supplier,
            # another without, or a catalog with a row that left a field blank
            # -- produced for a file that is perfectly valid. An absent optional
            # value is now sent as an explicit null, which is exactly what the
            # nullable column already held; the required columns
            # (product_id, product_name, current_stock) are never null because
            # canonical validation has already refused the row if they were.
            value = values.get(name)
            if value is None and name in _PRODUCT_NOT_NULL_DEFAULTS:
                # ...except where the column will not accept a null, where the
                # schema's own default is the only value a uniform key set can
                # carry. See ``_PRODUCT_NOT_NULL_DEFAULTS``.
                value = _PRODUCT_NOT_NULL_DEFAULTS[name]
            if value is not None:
                if name == "expected_arrival_date":
                    value = (
                        value.isoformat()
                        if hasattr(value, "isoformat")
                        else str(value)
                    )
                elif name in {
                    "current_stock", "lead_time_days", "open_order_qty"
                }:
                    value = int(value)
                elif name in {
                    "safety_stock", "reorder_point", "unit_cost",
                    "forecast_error_std", "unit_price",
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
            "unit_cost,unit_price,supplier,description,expected_arrival_date,"
            "forecast_error_std"
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
