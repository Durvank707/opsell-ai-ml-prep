"""Per-user tenant isolation store for EcomAI-OS (§33, §34, §35, §37, §44).

Every business record in the system — products, sales, inventory, forecasts,
recommendations, simulations, audit entries, uploads — carries a ``user_id``
and is scoped to exactly one tenant workspace. There is NO code path that can
read or write another tenant's rows: the registry is keyed by user and every
method operates within that user's workspace.

Design rules (spec-critical):

* A new signup starts with an EMPTY canonical workspace (no cross-tenant
  leakage of the demo data). The demo user ``demo@ecomai.app`` is the only
  workspace that is pre-seeded — via the SAME canonical store walk that new
  users get, never by copying another tenant's rows.
* Row-level security is enforced twice: at the *application* boundary here
  (every query is user-scoped and there is no tenant-agnostic reader) and at
  the *database* boundary when Supabase is enabled (RLS policies applied in
  ``supabase/migrations/0001_rls.sql``). The app must never rely on
  frontend filtering for isolation (§33).
* Audit entries are append-only, per-user, and include enough context to
  answer "why did EcomAI-OS say that?" — product_id, decision/eligibility,
  model version, fallback used, generated_at (§44).
* No cross-user access ever: a key that resolves to another user's row is a
  bug and is raised as ``TenantIsolationError``, never silently coalesced.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
import csv
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from uuid import uuid4

from backend.contracts import (
    ALL_RECORDS,
    SALES_RECORD,
    RecordContract,
    contract_for,
    parse_date_iso,
)
from backend.eligibility import (
    EligibilityDecision,
    ModelEligibilityCheck,
    MODEL_VERSION,
    classify_tier,
    classify_tier_label,
    eligibility_for_history,
)
from backend.validation import (
    RowProblem,
    RowValidationResult,
    SEV_ERROR,
    validate_rows,
)

DEMO_USER_ID = "demo@ecomai.app"
DEMO_EMAIL = "demo@ecomai.app"

# Default demand-forecast horizon, in days. Matches the order-up-to policy
# window the inventory engine is built around.
FORECAST_HORIZON = 30

# Multiplier for the lower/upper band. 1.28 is the ~80% normal interval, the
# same confidence the rest of the application reports.
BAND_Z = 1.28

# Horizon the ML engine runs at when a caller does not ask for a specific one.
DEFAULT_ML_HORIZON = 30


class TenantIsolationError(PermissionError):
    """Raised when code attempts to touch another tenant's row — always a bug."""


@dataclass
class ProductRow:
    """Canonical product record as stored (always user-scoped)."""

    product_id: str
    product_name: str
    category: str
    unit_price: float
    current_stock: int
    open_order_qty: int
    expected_arrival_date: Optional[str] = None
    lead_time_days: int = 7
    unit_cost: float = 0.0
    safety_stock: float = 0.0
    supplier: str = ""
    description: str = ""
    created_at: str = ""
    updated_at: str = ""

    @property
    def inventory_position(self) -> int:
        return self.current_stock + self.open_order_qty


@dataclass
class AuditEntry:
    id: str
    user_id: str
    action: str
    product_id: Optional[str] = None
    detail: Dict[str, Any] = field(default_factory=dict)
    created_at: str = ""


def _text_value(raw: Any, key: str, *, default: Optional[str] = None) -> str:
    """Read a bootstrap text value without silently stringifying junk.

    Empty/absent optional text may use the documented bootstrap default, but a
    supplied boolean/container/non-finite value is malformed metadata rather
    than a value to coerce into a label.
    """
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        if default is None:
            raise ValueError(f"{key} is required.")
        return default
    if isinstance(raw, (dict, list, tuple, set, bool)):
        raise ValueError(f"{key} must be a text value.")
    if isinstance(raw, float) and not math.isfinite(raw):
        raise ValueError(f"{key} must be a finite text value.")
    value = str(raw).strip()
    if not value:
        if default is None:
            raise ValueError(f"{key} is required.")
        return default
    return value


def _optional_nonnegative_number(
    row: Dict[str, Any], key: str, default: float
) -> float:
    """Read a product metadata number without truncating or hiding bad input."""
    raw = row.get(key)
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return float(default)
    if isinstance(raw, bool):
        raise ValueError(f"{key} must be numeric, not boolean.")
    text = str(raw).strip()
    if "_" in text or any(char.isspace() for char in text):
        raise ValueError(f"{key} must be a plain numeric value.")
    try:
        value = float(text)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{key} must be a finite number.") from exc
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{key} must be finite and non-negative.")
    return value


def _optional_nonnegative_int(
    row: Dict[str, Any], key: str, default: int
) -> int:
    value = _optional_nonnegative_number(row, key, default)
    if value != int(value):
        raise ValueError(f"{key} must be a whole number.")
    return int(value)


def _product_row_payload(product: "ProductRow") -> Dict[str, Any]:
    """Render a canonical :class:`ProductRow` for the Supabase products table.

    Only fields that belong to the canonical ``PRODUCT_RECORD`` contract are
    emitted. Unset optional values are omitted rather than sent as ``None`` so
    the adapter's canonical validation applies its own documented
    missing-value behaviour instead of being handed a null -- except for
    ``unit_price``/``unit_cost``, where zero is a real value the tenant set and
    sending nothing would leave a stale price behind.
    """

    payload: Dict[str, Any] = {
        "product_id": product.product_id,
        "product_name": product.product_name,
        "category": product.category,
        "current_stock": int(product.current_stock),
        "lead_time_days": int(product.lead_time_days),
        "open_order_qty": int(product.open_order_qty),
        "unit_cost": float(product.unit_cost),
        "unit_price": float(product.unit_price),
    }
    if product.safety_stock:
        # Only sent when the tenant actually set one; a zero would otherwise
        # overwrite a previously stored safety stock on every re-ingest.
        payload["safety_stock"] = float(product.safety_stock)
    if product.expected_arrival_date:
        payload["expected_arrival_date"] = product.expected_arrival_date
    if product.supplier:
        payload["supplier"] = product.supplier
    if product.description:
        payload["description"] = product.description
    return payload


def _product_row_from_hydrated(row: Dict[str, Any]) -> "ProductRow":
    """Rebuild the local :class:`ProductRow` shape from a validated remote row.

    The remote row has already been revalidated by ``fetch_products`` and
    confirmed to belong to this tenant, so the same documented defaults that
    :meth:`TenantWorkspace.add_product` applies are reused here. This keeps
    hydrated products indistinguishable from locally created ones.
    """

    remote_arrival = row.get("expected_arrival_date")
    if remote_arrival is None or (
        isinstance(remote_arrival, str) and not remote_arrival.strip()
    ):
        arrival = None
    elif isinstance(remote_arrival, datetime):
        arrival = remote_arrival.date().isoformat()
    elif isinstance(remote_arrival, date):
        arrival = remote_arrival.isoformat()
    else:
        parsed_arrival = parse_date_iso(remote_arrival)
        if parsed_arrival is None:
            raise ValueError(
                "A hydrated expected_arrival_date must be an unambiguous ISO date."
            )
        arrival = parsed_arrival.isoformat()

    product_id = str(row["product_id"])
    now = _now()
    return ProductRow(
        product_id=product_id,
        product_name=_text_value(
            row.get("product_name"), "product_name", default=product_id
        ),
        category=_text_value(row.get("category"), "category", default="Unknown"),
        unit_price=_optional_nonnegative_number(row, "unit_price", 0.0),
        current_stock=_optional_nonnegative_int(row, "current_stock", 0),
        open_order_qty=_optional_nonnegative_int(row, "open_order_qty", 0),
        expected_arrival_date=arrival,
        lead_time_days=_optional_nonnegative_int(row, "lead_time_days", 7),
        unit_cost=_optional_nonnegative_number(row, "unit_cost", 0.0),
        safety_stock=_optional_nonnegative_number(row, "safety_stock", 0.0),
        supplier=_text_value(row.get("supplier"), "supplier", default=""),
        description=_text_value(row.get("description"), "description", default=""),
        created_at=now,
        updated_at=now,
    )


@dataclass
class TenantWorkspace:
    """One user's isolated workspace. All state lives under ``user_id``."""

    user_id: str
    email: str = ""
    display_name: str = ""
    products: Dict[str, ProductRow] = field(default_factory=dict)
    sales_records: Dict[Tuple[str, str], Dict[str, Any]] = field(default_factory=dict)  # (product_id, date) → canonical row
    audit: List[AuditEntry] = field(default_factory=list)
    created_at: str = ""
    remote_hydrated: bool = False

    def __post_init__(self) -> None:
        if self.user_id is None:
            raise ValueError("user_id is required for a tenant workspace.")
        self.user_id = str(self.user_id).strip()
        if not self.user_id:
            raise ValueError("user_id is required for a tenant workspace.")
        if not self.email:
            self.email = self.user_id
        if not self.created_at:
            self.created_at = _now()

    def hydrate_from_supabase(self) -> Dict[str, int]:
        """Load every persisted collection for this tenant in one pass.

        Products, sales, and audit history are all durable when
        ``USE_SUPABASE=true``.  Each collection is hydrated through its own
        existing adapter and is rolled back on failure, so a partial read can
        never leave a half-populated workspace that claims to be persisted.

        Every read is scoped to ``self.user_id``, which comes from the verified
        tenant identity.  No other tenant's rows are ever fetched, and the
        ``remote_hydrated`` flag is only set once all three reads succeed.
        """

        if self.remote_hydrated:
            return {
                "products": len(self.products),
                "sales": len(self.sales_records),
                "audit": len(self.audit),
            }
        from backend.supabase import supabase_enabled

        if not supabase_enabled():
            return {"products": 0, "sales": 0, "audit": 0}

        audit = self._hydrate_audit_rows()
        products = self._hydrate_product_rows()
        sales = self._hydrate_sales_rows()
        self.remote_hydrated = True
        # Ordering note: remote history is restored BEFORE the ``*_hydrated``
        # audit events are recorded, so the freshly emitted events append to
        # the end of the restored timeline rather than jumping ahead of it.
        return {"products": products, "sales": sales, "audit": audit}

    def _hydrate_product_rows(self) -> int:
        """Fetch and revalidate this tenant's product rows."""

        from backend.supabase import fetch_products

        products_before = dict(self.products)
        audit_before = list(self.audit)
        try:
            remote_rows = fetch_products(self.user_id)
            for row in remote_rows:
                self._store_hydrated_product_row(row)
        except Exception:
            self.products = products_before
            self.audit = audit_before
            raise

        if remote_rows:
            self._audit(
                "products_hydrated",
                None,
                {"rows": len(remote_rows), "source": "supabase"},
            )
        return len(remote_rows)

    def _store_hydrated_product_row(self, row: Dict[str, Any]) -> None:
        """Cache one already-fetched remote product without re-writing it.

        ``fetch_products`` has already revalidated the row and confirmed the
        remote ``user_id`` matches this workspace, so the record is trusted for
        storage.  It is still stored through :meth:`add_product` semantics
        (identical defaults and bounds) by rebuilding the same local shape.
        """

        if not isinstance(row, dict):
            raise ValueError("A hydrated product row must be a JSON object.")
        # Defence in depth: ``fetch_products`` already refuses a foreign row, so
        # a mismatch here means the adapter's tenant check was bypassed.
        if "user_id" in row and str(row.get("user_id")) != self.user_id:
            raise TenantIsolationError(
                "A hydrated product row belongs to another tenant; it was refused."
            )
        product_id = str(row.get("product_id", "")).strip()
        if not product_id:
            raise ValueError("A hydrated product row is missing product_id.")
        # Keyed by product_id, so re-hydrating an already-known product replaces
        # it instead of appending a duplicate.
        self.products[product_id] = _product_row_from_hydrated(row)

    def _hydrate_audit_rows(self) -> int:
        """Restore this tenant's append-only audit history.

        Hydrated rows are appended directly rather than through :meth:`_audit`
        so restoring history never re-persists it. The remote ``created_at``
        order is preserved as returned, and no re-sorting happens: the next
        locally recorded event appends at the end, which is where it belongs.
        """

        from backend.supabase import fetch_audit_entries

        known_ids = {entry.id for entry in self.audit}
        audit_before = list(self.audit)
        restored = 0
        try:
            remote_rows = fetch_audit_entries(self.user_id)
            for row in remote_rows:
                if not isinstance(row, dict):
                    raise ValueError("A hydrated audit row must be a JSON object.")
                # Defence in depth, as in ``_store_hydrated_product_row``.
                if "user_id" in row and str(row.get("user_id")) != self.user_id:
                    raise TenantIsolationError(
                        "A hydrated audit row belongs to another tenant; "
                        "it was refused."
                    )
                entry_id = str(row.get("id", "")).strip()
                if not entry_id or entry_id in known_ids:
                    # Dedupe by id: a workspace that already recorded this entry
                    # must not gain a second copy of the same decision.
                    continue
                detail = row.get("detail")
                self.audit.append(AuditEntry(
                    id=entry_id,
                    user_id=self.user_id,
                    action=str(row.get("action", "")),
                    product_id=(
                        str(row["product_id"]) if row.get("product_id") else None
                    ),
                    detail=dict(detail) if isinstance(detail, dict) else {},
                    created_at=str(row.get("created_at", "")),
                ))
                known_ids.add(entry_id)
                restored += 1
        except Exception:
            # Same atomicity contract as products and sales: a failed restore
            # leaves the local workspace exactly as it was.
            self.audit = audit_before
            raise

        return restored

    def hydrate_sales(self) -> int:
        """Load this user's canonical sales rows when Supabase is enabled.

        Hydration is user-scoped, validated, and atomic.  A failed or malformed
        remote read leaves the local workspace unchanged; it never falls back
        to another tenant or marks unverified rows as persisted.

        Prefer :meth:`hydrate_from_supabase`, which also restores products and
        audit history.  This method remains for sales-only callers.
        """

        if self.remote_hydrated:
            return len(self.sales_records)
        from backend.supabase import supabase_enabled

        if not supabase_enabled():
            return 0

        rows = self._hydrate_sales_rows()
        self.remote_hydrated = True
        return rows

    def _hydrate_sales_rows(self) -> int:
        """Fetch and store this tenant's sales rows; roll back on failure."""

        from backend.supabase import fetch_sales

        sales_before = dict(self.sales_records)
        audit_before = list(self.audit)
        try:
            remote_rows = fetch_sales(self.user_id)
            for row in remote_rows:
                self._store_hydrated_sales_row(row)
        except Exception:
            self.sales_records = sales_before
            self.audit = audit_before
            raise

        if remote_rows:
            self._audit(
                "sales_hydrated",
                None,
                {"rows": len(remote_rows), "source": "supabase"},
            )
        return len(remote_rows)

    def _store_hydrated_sales_row(self, row: Dict[str, Any]) -> None:
        """Validate and cache one already-fetched remote row without re-writing it."""

        if not isinstance(row, dict):
            raise ValueError("A hydrated sales row must be a JSON object.")
        identity_mapping = {
            field.canonical_name: field.canonical_name
            for field in SALES_RECORD.fields
            if field.canonical_name in row
        }
        report = validate_rows(
            [row],
            SALES_RECORD,
            mapping=identity_mapping,
            columns=list(row),
        )
        if report.rejected_rows or any(
            problem.severity == SEV_ERROR for problem in report.schema_problems
        ):
            raise ValueError("A hydrated Supabase sales row failed validation.")
        stored = self._stored_sales_values(report.rows[0].values)
        self.sales_records[(stored["product_id"], stored["date"])] = stored

    @staticmethod
    def _stored_sales_values(values: Dict[str, Any]) -> Dict[str, Any]:
        """Convert validated canonical values into the local storage shape."""

        pid = str(values["product_id"])
        raw_date = values["date"]
        stored_date = (
            raw_date.isoformat() if hasattr(raw_date, "isoformat") else str(raw_date)
        )
        stored: Dict[str, Any] = {
            "product_id": pid,
            "date": stored_date,
            "units_sold": int(values["units_sold"]),
        }
        for optional in ("price", "category", "promotion"):
            if optional in values:
                value = values[optional]
                if optional == "promotion":
                    value = int(bool(value))
                stored[optional] = value
        return stored

    def add_product(self, row: Dict[str, Any]) -> ProductRow:
        """Add/update product metadata for this tenant.

        This is a catalog bootstrap helper, not the canonical row-ingestion
        path.  It supplies explicit, documented defaults for optional metadata
        so the demo seed can be created from product identity alone; supplied
        numeric/date values are nevertheless checked and never truncated or
        converted through a permissive ``or`` fallback.  Uploaded canonical
        product records go through ``validate_rows(..., PRODUCT_RECORD)``.
        """
        p = self._build_product_row(row)
        # Persist the canonical product BEFORE touching local state, matching
        # the sales convention: a failed remote write must never leave a local
        # record claiming a remote success that did not occur. The payload is
        # built from the validated ProductRow and stamped with this workspace's
        # verified user_id; the adapter overrides any caller-supplied user_id,
        # so a product can never be written into another tenant.
        self._commit_product_rows([p])
        return p

    def _build_product_row(self, row: Dict[str, Any]) -> ProductRow:
        """Validate one raw product dict into a canonical :class:`ProductRow`.

        Raises :class:`ValueError` for a non-object row or an invalid
        product_id/arrival date, so callers can refuse a whole batch before
        anything is written.
        """

        if not isinstance(row, dict):
            raise ValueError("A product row must be a JSON object.")
        pid = _text_value(row.get("product_id"), "product_id")
        product_name = _text_value(
            row.get("product_name"), "product_name", default=pid
        )
        category = _text_value(
            row.get("category"), "category", default="Unknown"
        )

        raw_arrival = row.get("expected_arrival_date")
        if raw_arrival is None or (isinstance(raw_arrival, str) and not raw_arrival.strip()):
            arrival = None
        else:
            if isinstance(raw_arrival, datetime):
                arrival = raw_arrival.date().isoformat()
            elif isinstance(raw_arrival, date):
                arrival = raw_arrival.isoformat()
            else:
                parsed_arrival = parse_date_iso(raw_arrival)
                if parsed_arrival is None:
                    raise ValueError(
                        "expected_arrival_date must be an unambiguous ISO date."
                    )
                arrival = parsed_arrival.isoformat()

        return ProductRow(
            product_id=pid,
            product_name=product_name,
            category=category,
            unit_price=_optional_nonnegative_number(row, "unit_price", 0.0),
            current_stock=_optional_nonnegative_int(row, "current_stock", 0),
            open_order_qty=_optional_nonnegative_int(row, "open_order_qty", 0),
            expected_arrival_date=arrival,
            lead_time_days=_optional_nonnegative_int(row, "lead_time_days", 7),
            unit_cost=_optional_nonnegative_number(row, "unit_cost", 0.0),
            safety_stock=_optional_nonnegative_number(row, "safety_stock", 0.0),
            supplier=_text_value(row.get("supplier"), "supplier", default=""),
            description=_text_value(row.get("description"), "description", default=""),
            created_at=_now(),
            updated_at=_now(),
        )

    def add_products(self, rows: Sequence[Dict[str, Any]]) -> List[ProductRow]:
        """Validate and atomically persist a batch of canonical product rows.

        The batched counterpart to :meth:`add_product`, mirroring
        :meth:`upsert_sales_rows`. Validation happens for every row first, so an
        invalid row anywhere refuses the whole batch instead of leaving a
        half-written catalog behind.
        """

        try:
            materialized = list(rows)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "Product rows must be a sequence of JSON objects."
            ) from exc
        prepared = [self._build_product_row(row) for row in materialized]
        seen: set = set()
        for product in prepared:
            if product.product_id in seen:
                raise ValueError(
                    "A product batch contains duplicate product_id "
                    f"{product.product_id!r}."
                )
            seen.add(product.product_id)
        self._commit_product_rows(prepared)
        return prepared

    def _commit_product_rows(self, prepared: Sequence["ProductRow"]) -> int:
        """Persist a validated product batch, then update the local shadow."""

        if not prepared:
            return 0

        # Same ordering contract as sales and audit: remote first, local second.
        from backend.supabase import supabase_enabled, upsert_products

        if supabase_enabled():
            upsert_products(
                self.user_id, [_product_row_payload(p) for p in prepared]
            )

        pending_audit: List[AuditEntry] = []
        for product in prepared:
            self.products[product.product_id] = product
            pending_audit.append(self._new_audit_entry(
                "product_upserted",
                product.product_id,
                {"current_stock": product.current_stock},
            ))
        self._audit_many(pending_audit)
        return len(prepared)

    def update_product(self, product_id: str, patch: Dict[str, Any]) -> ProductRow:
        """Apply a partial update to one of this tenant's products.

        Only fields the caller actually supplied are changed, so an update can
        never silently reset a value it did not mention. The product must
        already exist in this workspace: this is an update, not an upsert, and
        an unknown id is refused rather than conjuring a catalog row.
        """

        self._check_product(product_id)
        if not isinstance(patch, dict):
            raise ValueError("A product update must be a JSON object.")

        current = self.products[product_id]
        merged: Dict[str, Any] = {
            "product_id": current.product_id,
            "product_name": current.product_name,
            "category": current.category,
            "unit_price": current.unit_price,
            "current_stock": current.current_stock,
            "open_order_qty": current.open_order_qty,
            "expected_arrival_date": current.expected_arrival_date,
            "lead_time_days": current.lead_time_days,
            "unit_cost": current.unit_cost,
            "safety_stock": current.safety_stock,
            "supplier": current.supplier,
            "description": current.description,
        }
        # ``product_id`` is the business key and is deliberately immutable here;
        # renaming a product would orphan its sales history.
        for field in (
            "product_name", "category", "unit_price", "current_stock",
            "open_order_qty", "expected_arrival_date", "lead_time_days",
            "unit_cost", "safety_stock", "supplier", "description",
        ):
            if field in patch:
                merged[field] = patch[field]

        updated = self._build_product_row(merged)
        updated.created_at = current.created_at
        self._commit_product_rows([updated])
        return updated

    def delete_product(self, product_id: str) -> int:
        """Delete one of this tenant's products and its sales history.

        The remote delete happens before local state changes, so a failed
        delete never leaves a product that looks removed but is still durable.
        Sales rows for the product are removed with it: they are meaningless
        without the product they belong to.
        """

        self._check_product(product_id)

        from backend.supabase import delete_product as remote_delete, supabase_enabled

        if supabase_enabled():
            remote_delete(self.user_id, product_id)

        product = self.products.pop(product_id)
        removed_sales = [
            key for key in self.sales_records if key[0] == product_id
        ]
        for key in removed_sales:
            del self.sales_records[key]
        self._audit("product_deleted", product_id, {
            "sales_rows_removed": len(removed_sales),
            "product_name": product.product_name,
        })
        return len(removed_sales)

    def _prepare_sales_row(
        self, row: Dict[str, Any]
    ) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
        """Validate one row and return its local shape without mutating state."""

        if not isinstance(row, dict):
            raise ValueError("A sales row must be a JSON object.")
        # ``units_sold_source`` is an explicit, server-owned provenance field
        # used by the canonical seed.  It is not a sixth contract; excluding it
        # here keeps it from being mistaken for an unvalidated user column.
        validation_row = {
            key: value for key, value in row.items()
            if key != "units_sold_source"
        }
        identity_mapping = {
            field.canonical_name: field.canonical_name
            for field in SALES_RECORD.fields
            if field.canonical_name in validation_row
        }
        product_hint = str(validation_row.get("product_id") or "").strip()
        known_categories = None
        if product_hint in self.products:
            known_categories = {self.products[product_hint].category}
        report = validate_rows(
            [validation_row],
            SALES_RECORD,
            mapping=identity_mapping,
            columns=list(validation_row.keys()),
            known_categories=known_categories,
        )
        schema_errors = [
            problem for problem in report.schema_problems
            if problem.severity == SEV_ERROR
        ]
        if report.rejected_rows or schema_errors:
            problems = schema_errors or report.problems
            details = "; ".join(
                f"{p.field or 'row'}: {p.detail}" for p in problems[:3]
            )
            raise ValueError(
                "Sales row was not stored because validation failed: " + details
            )

        validation_warnings = [
            problem.to_dict() for problem in report.problems
            if problem.severity != SEV_ERROR
        ]
        values = report.rows[0].values
        pid = str(values["product_id"])
        self._check_product(pid)
        stored = self._stored_sales_values(values)
        if "units_sold_source" in row:
            stored["units_sold_source"] = row["units_sold_source"]
        return stored, validation_warnings

    def _commit_sales_rows(
        self,
        prepared: Sequence[Tuple[Dict[str, Any], List[Dict[str, Any]]]],
    ) -> int:
        """Persist a validated batch, then update the local shadow atomically."""

        if not prepared:
            return 0
        keys = [
            (str(stored["product_id"]), str(stored["date"]))
            for stored, _warnings in prepared
        ]
        if len(set(keys)) != len(keys):
            raise ValueError("A sales batch contains duplicate product/date keys.")

        # When enabled, persist only after every row is valid and owned.  A
        # failed remote write happens before local mutation, so the local
        # shadow never claims a remote success that did not occur.
        from backend.supabase import supabase_enabled, upsert_sales

        if supabase_enabled():
            remote_rows = [
                {
                    key: value
                    for key, value in stored.items()
                    if key != "units_sold_source"
                }
                for stored, _warnings in prepared
            ]
            upsert_sales(self.user_id, remote_rows)

        written = 0
        pending_audit: List[AuditEntry] = []
        for stored, validation_warnings in prepared:
            pid = str(stored["product_id"])
            key = (pid, str(stored["date"]))
            existing = self.sales_records.get(key)
            self.sales_records[key] = stored
            audit_detail = {
                "date": stored["date"],
                "units_sold": stored["units_sold"],
                "was_update": existing is not None,
            }
            if validation_warnings:
                # Extra/unknown source columns are intentionally not persisted,
                # but the warning remains auditable rather than disappearing at
                # the storage boundary.
                audit_detail["validation_warnings"] = validation_warnings
            pending_audit.append(
                self._new_audit_entry("sales_upserted", pid, audit_detail)
            )
            written += 1
        # One batched append for the whole ingest instead of one round trip per
        # row. Same ordering contract: if this fails, the error propagates and
        # the caller can treat the batch as unpersisted.
        self._audit_many(pending_audit)
        return written

    def upsert_sales_row(self, row: Dict[str, Any]) -> None:
        """Validate and store one canonical sales row.

        This method is the boundary immediately before persistence.  It does not
        fill missing required values with zero/``Unknown`` and it does not keep
        an invalid date as an arbitrary string: the canonical validator reports
        the blocking problem and the row is refused.  Optional fields are only
        stored when the source actually supplied them.
        """

        stored, validation_warnings = self._prepare_sales_row(row)
        self._commit_sales_rows([(stored, validation_warnings)])

    def upsert_sales_rows(self, rows: Sequence[Dict[str, Any]]) -> int:
        """Validate and atomically persist a batch of canonical sales rows."""

        try:
            materialized = list(rows)
        except (TypeError, ValueError) as exc:
            raise ValueError("Sales rows must be a sequence of JSON objects.") from exc
        prepared = [self._prepare_sales_row(row) for row in materialized]
        return self._commit_sales_rows(prepared)

    def sales_history_for(self, product_id: str) -> List[Dict[str, Any]]:
        """Sorted daily sales rows for one product (user-scoped)."""
        self._check_product(product_id)
        rows = [
            {**r, "date": d}
            for (pid, d), r in self.sales_records.items()
            if pid == product_id
        ]
        rows.sort(key=lambda r: r["date"])
        return rows

    def forecast_for(
        self,
        product_id: str,
        *,
        model_available: bool = True,
        history: Optional[Sequence[Dict[str, Any]]] = None,
        audit: bool = True,
        horizon: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Eligibility-gated forecast with an auditable, labeled fallback.

        A failure in one product's optional ML path is converted to a safe
        baseline result for that product only.  It is never allowed to abort a
        multi-product job, and the failure is recorded without exposing a raw
        traceback.  When ``history`` is supplied it is treated as a transient,
        explicitly validated input for this owned product; it is never used to
        read or copy another tenant's workspace.

        ``audit=False`` is for *read* paths — a dashboard rendering a portfolio
        forecast is not a decision and must not append one audit row per
        product. Suppressed ML failures are still reported on the result as
        ``ml_unavailable`` so the caller can surface or aggregate them instead
        of losing them. ``horizon`` is honoured on the ML path; the baseline
        path always returns its own default-length series because the caller's
        requested window has no effect on a mean.
        """
        self._check_product(product_id)
        history_warnings: List[Dict[str, Any]] = []
        if history is None:
            history = self.sales_history_for(product_id)
        else:
            history, history_warnings = self._validated_request_history(
                product_id, history
            )
        history, derived_warnings = self._enrich_history(product_id, history)
        if derived_warnings:
            history_warnings = [*history_warnings, *derived_warnings]
        requested_horizon = int(horizon) if horizon is not None else None
        product_category = self.products[product_id].category
        decision = _eligibility_for_history(
            history,
            model_available=model_available,
            known_categories={product_category},
        )

        if decision.eligible:
            try:
                forecast = _ml_forecast(history, horizon=requested_horizon)
                if not forecast:
                    raise RuntimeError("The ML forecast engine returned no forecast rows.")
                result = {
                    "product_id": product_id,
                    "forecast": forecast,
                    "eligibility": decision.to_dict(),
                    "model_version": decision.model_version,
                    # An eligible decision means the ML path actually ran;
                    # do not expose the internal limited-history policy label
                    # as though a baseline had been used.
                    "fallback_used": "ml",
                }
                if decision.confidence_label == "limited":
                    result["warning"] = (
                        "The ML forecast is available, but the history is "
                        "limited; treat it as a lower-confidence estimate."
                    )
                if audit:
                    self._audit("forecast_generated", product_id, {
                        "model_version": decision.model_version,
                        "eligibility": decision.tier,
                        "fallback_used": "ml",
                        "confidence": decision.confidence_label,
                        "forecast_rows": len(forecast),
                        "decision": decision.to_dict(),
                    })
                if history_warnings:
                    result["history_warnings"] = history_warnings
                return result
            except Exception:
                # Keep the product useful and make the fallback explicit.  The
                # underlying exception is intentionally not returned to callers.
                fallback_decision = _eligibility_for_history(
                    history,
                    model_available=False,
                    known_categories={product_category},
                )
                result = {
                    "product_id": product_id,
                    "forecast": _baseline_estimate(history),
                    "eligibility": fallback_decision.to_dict(),
                    "model_version": None,
                    "fallback_used": "baseline",
                    "warning": "The ML forecast was unavailable for this product; "
                               "a labeled baseline estimate is shown instead.",
                }
                if audit:
                    self._audit("forecast_ml_failed", product_id, {
                        "model_version": MODEL_VERSION,
                        "eligibility": fallback_decision.tier,
                        "fallback_used": "baseline",
                        "confidence": fallback_decision.confidence_label,
                        "decision": fallback_decision.to_dict(),
                    })
                result["ml_unavailable"] = True
                if history_warnings:
                    result["history_warnings"] = history_warnings
                return result

        # Safe fallback — baseline, labeled (§16/§43) -------------------------
        baseline = _baseline_estimate(history)
        result = {
            "product_id": product_id,
            "forecast": baseline,
            "eligibility": decision.to_dict(),
            "model_version": decision.model_version,
            "fallback_used": decision.fallback_used,
        }
        if not decision.eligible:
            result["warning"] = " ".join(
                decision.reasons
                or ["The model eligibility gate did not pass; a baseline is shown."]
            )
        if history and not baseline:
            result["warning"] = (
                "No baseline estimate was generated because the available "
                "history did not contain a usable positive demand series."
            )
        if audit:
            self._audit("forecast_generated", product_id, {
                "model_version": decision.model_version,
                "eligibility": decision.tier,
                "fallback_used": decision.fallback_used,
                "forecast_rows": len(baseline),
                "decision": decision.to_dict(),
            })
        if history_warnings:
            result["history_warnings"] = history_warnings
        return result

    def _enrich_history(
        self,
        product_id: str,
        history: List[Dict[str, Any]],
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Fill in ML feature inputs the tenant's own records already imply.

        ``category``, ``price`` and ``promotion`` are optional on a sales row,
        but the eligibility gate needs them before it will trust the model. They
        do not need to be invented: the category and price are carried by this
        tenant's own product record, and an unrecorded promotion is a real
        business state ("no promotion ran") rather than missing data.

        The gate itself is left untouched. If the product has no usable category
        the row still goes in without one and the gate still refuses ML -- this
        only stops a well-formed tenant from being permanently locked out of the
        model. Every derived value is reported back so the caller can disclose
        that the forecast rests on it.
        """
        product = self.products[product_id]
        rows: List[Dict[str, Any]] = []
        derived_fields: set = set()

        for row in history:
            enriched = dict(row)
            if not str(enriched.get("category") or "").strip():
                if product.category:
                    enriched["category"] = product.category
                    derived_fields.add("category")
            if enriched.get("price") is None:
                enriched["price"] = product.unit_price
                derived_fields.add("price")
            if enriched.get("promotion") is None:
                enriched["promotion"] = False
                derived_fields.add("promotion")
            rows.append(enriched)

        warnings: List[Dict[str, Any]] = []
        if derived_fields:
            names = ", ".join(sorted(derived_fields))
            warnings.append({
                "code": "ml_features_derived",
                "fields": sorted(derived_fields),
                "message": (
                    f"{names} were taken from the product record rather than "
                    "from each sales row, so the forecast assumes no promotion "
                    "ran and used the listed price. Supply these per sale for "
                    "an exact forecast."
                ),
            })
        return rows, warnings

    def _validated_request_history(
        self,
        product_id: str,
        history: Sequence[Dict[str, Any]],
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        """Validate transient forecast input without persisting or filtering it."""
        supplied = list(history)
        if not supplied:
            return [], []

        declared_columns = sorted({
            str(key)
            for row in supplied
            if isinstance(row, dict)
            for key in row.keys()
        })
        report = validate_rows(
            supplied,
            SALES_RECORD,
            columns=declared_columns or None,
            known_categories={self.products[product_id].category},
        )
        schema_errors = [
            problem for problem in report.schema_problems
            if problem.severity == SEV_ERROR
        ]
        if report.rejected_rows or schema_errors:
            problems = schema_errors or report.problems
            details = "; ".join(
                f"{p.field or 'row'}: {p.detail}" for p in problems[:4]
            )
            raise ValueError(
                "Forecast history was rejected before forecasting: " + details
            )
        history_warnings = [
            problem.to_dict() for problem in report.schema_problems
            if problem.severity != SEV_ERROR
        ]
        if any(p.category == "duplicate" for p in report.problems):
            raise ValueError(
                "Forecast history contains duplicate business keys; choose an "
                "explicit keep/replace policy before forecasting."
            )

        normalized: List[Dict[str, Any]] = []
        for row in report.rows:
            values = dict(row.values)
            row_product = str(values.get("product_id", ""))
            if row_product != product_id:
                raise ValueError(
                    f"Forecast history product_id '{row_product}' does not "
                    f"match requested product '{product_id}'."
                )
            row_date = values.get("date")
            if hasattr(row_date, "isoformat"):
                values["date"] = row_date.isoformat()
            normalized.append(values)

        warnings = [
            problem.to_dict()
            for problem in report.problems
            if problem.severity in {"warn", "info"} and problem.row_number > 0
        ]
        return normalized, history_warnings + warnings

    def recompute_metrics(self, product_id: str) -> Dict[str, Any]:
        """Inventory intelligence for one product (user-scoped, decision-transparent).

        This is the *audited* entry point: it records that metrics were
        recomputed. List endpoints that surface metrics for many products use
        :meth:`product_metrics` instead, because rendering a page is not a
        decision and must not append an audit row per product.
        """
        result = self.product_metrics(product_id)
        self._audit("metrics_recomputed", product_id, {
            "stockout_risk": result["stockout_risk"]
        })
        return result

    def product_metrics(self, product_id: str) -> Dict[str, Any]:
        """Read-only inventory intelligence for one product; writes nothing."""

        self._check_product(product_id)
        p = self.products[product_id]
        history = self.sales_history_for(product_id)
        daily_avg = round(
            sum(r["units_sold"] for r in history) / max(len(history), 1), 2
        )
        decision = _eligibility_for_history(
            history,
            model_available=True,
            known_categories={p.category},
        )
        lead_days = max(p.lead_time_days, 1)
        lead_time_demand = round(daily_avg * lead_days, 2)
        # A tenant-supplied safety stock is authoritative; the derived value is
        # only the fallback for a product that has never set one.
        safety_stock = (
            round(float(p.safety_stock), 2)
            if p.safety_stock
            else round(1.645 * max(daily_avg * 0.4, 0.5), 2)
        )
        reorder_point = round(lead_time_demand + safety_stock, 2)
        inv_pos = p.inventory_position
        risk = "HIGH" if inv_pos < reorder_point else ("MEDIUM" if inv_pos < reorder_point * 1.4 else "LOW")
        days_covered = round(inv_pos / max(daily_avg, 0.0001), 1)

        return {
            "product_id": product_id,
            "product_name": p.product_name,
            "category": p.category,
            "unit_price": p.unit_price,
            "unit_cost": p.unit_cost,
            "supplier": p.supplier,
            "description": p.description,
            "current_stock": p.current_stock,
            "open_order_qty": p.open_order_qty,
            "inventory_position": inv_pos,
            "lead_time_days": p.lead_time_days,
            "daily_avg": daily_avg,
            "lead_time_demand": lead_time_demand,
            "safety_stock": safety_stock,
            "reorder_point": reorder_point,
            "days_covered": days_covered,
            "stockout_risk": risk,
            "expected_arrival_date": p.expected_arrival_date,
            "updated_at": p.updated_at,
            "history_days": len(history),
            "eligibility": decision.to_dict(),
        }

    def list_products(self) -> List[Dict[str, Any]]:
        """Every product in this workspace with its derived metrics attached.

        Per-product metric failures are isolated: a single product that cannot
        be scored is reported with an ``error`` marker instead of failing the
        whole listing.
        """

        rows: List[Dict[str, Any]] = []
        for product_id in sorted(self.products):
            try:
                rows.append(self.product_metrics(product_id))
            except Exception:
                p = self.products[product_id]
                rows.append({
                    "product_id": p.product_id,
                    "product_name": p.product_name,
                    "category": p.category,
                    "unit_price": p.unit_price,
                    "unit_cost": p.unit_cost,
                    "supplier": p.supplier,
                    "description": p.description,
                    "current_stock": p.current_stock,
                    "open_order_qty": p.open_order_qty,
                    "inventory_position": p.inventory_position,
                    "lead_time_days": p.lead_time_days,
                    "expected_arrival_date": p.expected_arrival_date,
                    "updated_at": p.updated_at,
                    "error": "metrics_unavailable",
                })
        return rows

    def list_sales(
        self,
        *,
        product_id: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        search: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> Dict[str, Any]:
        """Paginated, user-scoped sales records for the records table."""

        if product_id is not None:
            self._check_product(product_id)
        needle = (search or "").strip().casefold()
        selected: List[Tuple[str, str, Dict[str, Any]]] = []
        for (pid, day), row in self.sales_records.items():
            if product_id is not None and pid != product_id:
                continue
            if date_from and day < date_from:
                continue
            if date_to and day > date_to:
                continue
            if needle and needle not in f"{pid} {day} {row.get('category', '')}".casefold():
                continue
            selected.append((pid, day, row))
        selected.sort(key=lambda item: (item[1], item[0]), reverse=True)

        total = len(selected)
        page = selected[max(0, offset):max(0, offset) + max(1, limit)]
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "rows": [
                {
                    "product_id": pid,
                    "product_name": self.products[pid].product_name
                    if pid in self.products else pid,
                    **row,
                }
                for pid, day, row in page
            ],
        }

    def sales_summary(self) -> Dict[str, Any]:
        """Portfolio sales totals for the signed-in tenant."""

        total_rows = len(self.sales_records)
        units = 0
        revenue = 0.0
        for row in self.sales_records.values():
            sold = int(row.get("units_sold", 0) or 0)
            units += sold
            price = row.get("price")
            if isinstance(price, (int, float)):
                revenue += sold * float(price)
        dates = sorted({day for (_pid, day) in self.sales_records})
        return {
            "total_records": total_rows,
            "total_units": units,
            "total_revenue": round(revenue, 2),
            "products_covered": len({
                pid for (pid, _day) in self.sales_records
                if pid in self.products
            }),
            "date_from": dates[0] if dates else None,
            "date_to": dates[-1] if dates else None,
        }

    # -- demand forecasting -------------------------------------------------

    def demand_forecast(
        self,
        product_id: str,
        *,
        horizon: Optional[int] = None,
        audit: bool = False,
    ) -> Dict[str, Any]:
        """One product's demand forecast with a confidence band and trend.

        Wraps the eligibility-gated :meth:`forecast_for` (so a labeled
        baseline is used when the ML gate does not pass) and normalizes the
        engine's output into ``{date, forecast, lower, upper}`` points. The band
        width comes from the residual error of the product's *own* history, so a
        volatile product is shown a wider interval than a steady one.
        """
        self._check_product(product_id)
        requested = FORECAST_HORIZON if horizon is None else int(horizon)
        horizon = max(1, min(requested, 180))
        result = self.forecast_for(product_id, horizon=horizon, audit=audit)
        raw_points = result.get("forecast") or []
        history = self.sales_history_for(product_id)
        sigma = _forecast_error_std([r.get("units_sold", 0) for r in history])

        points: List[Dict[str, Any]] = []
        for row in raw_points:
            date = row.get("date")
            if isinstance(date, str):
                date = date[:10]
            else:
                # pandas Timestamp / datetime: keep the calendar date only.
                date = str(date)[:10]
            units = _as_float(
                row.get("forecast_units", row.get("forecast_units_actual", row.get("units_sold")))
            )
            points.append({
                "date": date,
                "forecast": round(max(0.0, units), 2),
                "lower": round(max(0.0, units - BAND_Z * sigma), 2),
                "upper": round(max(0.0, units + BAND_Z * sigma), 2),
            })

        total = round(sum(pt["forecast"] for pt in points), 2)
        actuals = [
            {"date": r["date"], "units": int(r.get("units_sold", 0) or 0)}
            for r in history[-60:]
        ]
        peak = max(points, key=lambda pt: pt["forecast"], default=None)
        trend, growth_pct = _trend_from_history(history)

        return {
            "product_id": product_id,
            "product_name": self.products[product_id].product_name,
            "category": self.products[product_id].category,
            "horizon": horizon,
            "points": points,
            "actuals": actuals,
            "total": total,
            "avg_daily": round(total / horizon, 2) if points else 0.0,
            "peak_date": peak["date"] if peak else None,
            "peak_units": peak["forecast"] if peak else None,
            "trend": trend,
            "growth_pct": growth_pct,
            "error_std": round(sigma, 3),
            "fallback_used": result.get("fallback_used"),
            "model_version": result.get("model_version"),
            "eligibility": result.get("eligibility"),
            "warning": result.get("warning"),
            "ml_unavailable": bool(result.get("ml_unavailable")),
        }

    def portfolio_forecast(
        self,
        *,
        horizon: int = FORECAST_HORIZON,
        category: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Portfolio-wide forecast: summed daily points plus per-product rows.

        Products are evaluated independently, so one ineligible product is
        skipped rather than failing the whole portfolio. Suppressed per-product
        ML failures are aggregated into a single audit entry instead of one
        row per product, so a broken model cannot flood the trail.
        """
        horizon = max(1, min(int(horizon), 180))
        scope = sorted(
            pid for pid in self.products
            if category is None or self.products[pid].category == category
        )

        buckets: List[Dict[str, float]] = [
            {"forecast": 0.0, "lower": 0.0, "upper": 0.0} for _ in range(horizon)
        ]
        rows: List[Dict[str, Any]] = []
        ml_failures: List[str] = []
        for pid in scope:
            try:
                fc = self.demand_forecast(pid, horizon=horizon, audit=False)
            except Exception:
                continue
            if fc["ml_unavailable"]:
                ml_failures.append(pid)
            for index, point in enumerate(fc["points"][:horizon]):
                buckets[index]["forecast"] += point["forecast"]
                buckets[index]["lower"] += point["lower"]
                buckets[index]["upper"] += point["upper"]
            rows.append({
                "product_id": pid,
                "product_name": fc["product_name"],
                "category": fc["category"],
                "current_daily_avg": round(
                    sum(a["units"] for a in fc["actuals"])
                    / max(len(fc["actuals"]), 1),
                    2,
                ),
                "forecast_total": fc["total"],
                "forecast_avg_daily": fc["avg_daily"],
                "change_pct": fc["growth_pct"],
                "trend": fc["trend"],
                "fallback_used": fc["fallback_used"],
            })

        if ml_failures:
            self._audit("forecast_ml_failed", None, {
                "model_version": MODEL_VERSION,
                "affected_products": len(ml_failures),
                "product_ids": ml_failures[:25],
                "fallback_used": "baseline",
            })

        series: List[Dict[str, Any]] = []
        for index, totals in enumerate(buckets):
            if not any(totals.values()):
                continue
            anchor = self._forecast_anchor(horizon)
            shifted = _step_days(anchor, index + 1)
            if not shifted:
                continue
            series.append({
                "date": shifted,
                "forecast": round(totals["forecast"], 2),
                "lower": round(totals["lower"], 2),
                "upper": round(totals["upper"], 2),
            })

        total_units = round(sum(pt["forecast"] for pt in series), 2)
        increasing = sum(1 for r in rows if r["trend"] == "increasing")
        decreasing = sum(1 for r in rows if r["trend"] == "decreasing")
        return {
            "horizon": horizon,
            "scope": "portfolio",
            "category": category,
            "points": series,
            "actuals": self.portfolio_daily_actual(horizon),
            "total": total_units,
            "avg_daily": round(total_units / horizon, 2) if series else 0.0,
            "rows": rows,
            "products_forecast": len(rows),
            "products_in_scope": len(scope),
            "increasing": increasing,
            "decreasing": decreasing,
            "stable": len(rows) - increasing - decreasing,
            "portfolio_trend": (
                "increasing" if increasing > decreasing
                else "decreasing" if decreasing > increasing
                else "stable"
            ),
            "ml_unavailable_count": len(ml_failures),
        }

    def portfolio_daily_actual(self, days: int = FORECAST_HORIZON) -> List[Dict[str, Any]]:
        """Actual daily units summed across the whole catalog, oldest first."""
        window = max(int(days), 1)
        totals: Dict[str, int] = {}
        for (_pid, day), row in self.sales_records.items():
            totals[day] = totals.get(day, 0) + int(row.get("units_sold", 0) or 0)
        recent = sorted(totals.items())[-window:]
        return [{"date": day, "units": units} for day, units in recent]

    def _forecast_anchor(self, horizon: int) -> str:
        """The last day with recorded sales, which forecasts project forward from."""

        history = self.sales_records
        return max((day for (_pid, day) in history), default=None) or _step_days(
            datetime.now(timezone.utc).date().isoformat(), 0
        )

    # -- inventory intelligence ---------------------------------------------

    def _inventory_state(self, product_id: str) -> Dict[str, Any]:
        """The four-bucket health status the UI groups products by.

        Mirrors the existing ``classifyStatus`` rule (critical / low /
        overstocked / healthy) but computed from this tenant's real history and
        any safety stock it has set, never from seeded mock values.
        """

        metrics = self.product_metrics(product_id)
        product = self.products[product_id]
        safety = float(metrics["safety_stock"])
        reorder_point = float(metrics["reorder_point"])
        horizon_forecast = self.demand_forecast(product_id, audit=False)
        total_forecast = float(horizon_forecast["total"])
        target = total_forecast + safety
        stock = float(product.current_stock)

        if stock <= safety:
            status = "critical"
        elif stock <= reorder_point:
            status = "low"
        elif target > 0 and stock > target * 1.35:
            status = "overstocked"
        else:
            status = "healthy"

        metrics.update({
            "status": status,
            "target_stock": round(target, 2),
            "forecast_total": round(total_forecast, 2),
            "forecast_avg_daily": horizon_forecast["avg_daily"],
            "trend": horizon_forecast["trend"],
            "growth_pct": horizon_forecast["growth_pct"],
            "forecast_error_std": horizon_forecast["error_std"],
            "fallback_used": horizon_forecast["fallback_used"],
            "eligibility": horizon_forecast["eligibility"],
        })
        return metrics

    def inventory_overview(self) -> Dict[str, Any]:
        """Portfolio KPIs, health distribution and category breakdown."""

        products: List[Dict[str, Any]] = []
        for product_id in sorted(self.products):
            try:
                products.append(self._inventory_state(product_id))
            except Exception:
                continue

        buckets = {name: [] for name in ("critical", "low", "overstocked", "healthy")}
        for row in products:
            buckets.get(row.get("status"), buckets["healthy"]).append(row)

        total_units = sum(int(self.products[r["product_id"]].current_stock) for r in products)
        total_value = sum(
            int(self.products[r["product_id"]].current_stock) * float(r.get("unit_cost") or 0.0)
            for r in products
        )
        at_risk = [r for r in products if r.get("stockout_risk") in {"HIGH", "MEDIUM"}]

        categories: Dict[str, Dict[str, Any]] = {}
        for row in products:
            name = row.get("category") or "Uncategorised"
            entry = categories.setdefault(
                name, {"category": name, "products": 0, "units": 0, "value": 0.0, "critical": 0}
            )
            entry["products"] += 1
            entry["units"] += int(self.products[row["product_id"]].current_stock)
            entry["value"] += int(self.products[row["product_id"]].current_stock) * float(
                row.get("unit_cost") or 0.0
            )
            if row.get("status") == "critical":
                entry["critical"] += 1

        return {
            "user_id": self.user_id,
            "kpis": {
                "total_products": len(products),
                "products_to_reorder": len(buckets["low"]),
                "stockout_risk": len(at_risk),
                "excess_inventory": len(buckets["overstocked"]),
                "inventory_value": round(total_value, 2),
                "total_units": total_units,
            },
            "health": {
                "healthy": len(buckets["healthy"]) + len(buckets["overstocked"]),
                "at_risk": len(buckets["low"]),
                "critical": len(buckets["critical"]),
                "total": len(products),
            },
            "buckets": {name: rows for name, rows in buckets.items()},
            "categories": [
                {**entry, "value": round(entry["value"], 2)}
                for entry in sorted(categories.values(), key=lambda e: e["category"])
            ],
            "ml_unavailable_count": sum(1 for r in products if r.get("fallback_used") == "baseline"),
        }

    def stockout_timeline(
        self, product_id: str, *, days: int = 45
    ) -> Dict[str, Any]:
        """Day-by-day stock depletion for one product, with/without a reorder.

        Both paths are projected from the same demand series: ``with_reorder``
        places a single order at the reorder point, ``without_reorder`` never
        reorders. The divergence is what tells a user whether waiting matters.
        """

        state = self._inventory_state(product_id)
        product = self.products[product_id]
        history = self.sales_history_for(product_id)
        days = max(1, min(int(days), 180))
        forecast = self.demand_forecast(product_id, audit=False)

        anchor = self._forecast_anchor(days)
        recent_units = [int(r.get("units_sold", 0) or 0) for r in history[-7:]]
        past_average = (
            round(sum(recent_units) / len(recent_units), 2) if recent_units else 0.0
        )

        def demand_at(offset: int) -> float:
            if offset < 0:
                index = len(history) + offset
                if -len(history) <= index < 0:
                    return float(history[index].get("units_sold", 0) or 0)
                return past_average
            if offset < len(forecast["points"]):
                return float(forecast["points"][offset]["forecast"])
            return past_average or float(forecast["avg_daily"])

        points: List[Dict[str, Any]] = []
        with_stock = float(product.current_stock)
        without_stock = float(product.inventory_position)
        reordered = False
        reorder_date: Optional[str] = None
        depletion_date: Optional[str] = None

        for offset in range(-7, days):
            day = _step_days(anchor, offset)
            if not day:
                continue
            demand = max(0.0, demand_at(offset))
            if (
                not reordered
                and offset >= 0
                and float(state["inventory_position"]) <= float(state["reorder_point"])
            ):
                reordered = True
                reorder_date = day
                with_stock = float(state["target_stock"])
            with_stock = max(0.0, with_stock - demand)
            without_stock = max(0.0, without_stock - demand)
            if without_stock <= 0 and depletion_date is None and offset >= 0:
                depletion_date = day
            points.append({
                "date": day,
                "stock": round(with_stock, 2),
                "stock_without_reorder": round(without_stock, 2),
                "demand": round(demand, 2),
            })

        return {
            "product_id": product_id,
            "product_name": product.product_name,
            "points": points,
            "current_stock": product.current_stock,
            "inventory_position": product.inventory_position,
            "reorder_point": round(float(state["reorder_point"]), 2),
            "safety_stock": round(float(state["safety_stock"]), 2),
            "target_stock": round(float(state["target_stock"]), 2),
            "status": state["status"],
            "expected_depletion": depletion_date,
            "reorder_placed_on": reorder_date,
            "past_average": past_average,
            "days_of_cover": state.get("days_covered"),
        }

    def reorder_recommendation(
        self,
        product_id: str,
        *,
        moq: int = 0,
        pack_size: int = 1,
    ) -> Dict[str, Any]:
        """Recommended order quantity, using the shared inventory policy."""

        from src.inventory.policy import (
            calculate_recommended_order_qty,
            calculate_target_inventory,
        )
        from src.inventory.reorder import should_reorder

        state = self._inventory_state(product_id)
        product = self.products[product_id]
        position = float(product.inventory_position)
        reorder_point = float(state["reorder_point"])
        reorder_required = bool(should_reorder(position, reorder_point))
        target = float(calculate_target_inventory(state["forecast_total"], state["safety_stock"]))
        quantity = float(
            calculate_recommended_order_qty(
                target_inventory=target,
                inventory_position=position,
                reorder_required=reorder_required,
                moq=max(0, int(moq)),
                pack_size=max(1, int(pack_size)),
            )
        )
        return {
            "product_id": product_id,
            "product_name": product.product_name,
            "reorder_required": reorder_required,
            "recommended_order_qty": int(round(max(0.0, quantity))),
            "reorder_point": round(reorder_point, 2),
            "safety_stock": round(float(state["safety_stock"]), 2),
            "target_inventory": round(target, 2),
            "inventory_position": position,
            "current_stock": product.current_stock,
            "open_order_qty": product.open_order_qty,
            "lead_time_days": product.lead_time_days,
            "moq": max(0, int(moq)),
            "pack_size": max(1, int(pack_size)),
            "status": state["status"],
        }

    def recommendations(self, *, category: Optional[str] = None) -> Dict[str, Any]:
        """Ranked, plain-language inventory actions for the whole catalog.

        Each row is the business decision itself (what to do and why), derived
        from the same real metrics the inventory page shows, so the
        recommendations page can never disagree with the numbers behind it.
        """

        if category is not None and not any(
            p.category == category for p in self.products.values()
        ):
            # Refuse rather than return an empty page that looks like "nothing
            # needs attention" when in fact the filter matched nothing at all.
            raise ValueError(
                f"'{category}' is not a category in this workspace; it cannot "
                "be read as 'no recommendations'."
            )

        items: List[Dict[str, Any]] = []
        for product_id in sorted(self.products):
            try:
                items.append(self._recommendation_row(product_id))
            except Exception:
                continue

        counts = {
            "all": len(items),
            "critical": sum(1 for r in items if r["type"] == "critical"),
            "reorder": sum(1 for r in items if r["type"] == "reorder"),
            "monitor": sum(1 for r in items if r["type"] == "monitor"),
            "no_action": sum(1 for r in items if r["type"] == "no_action"),
        }
        if category:
            items = [r for r in items if r.get("category") == category]

        priority = {"critical": 0, "reorder": 1, "monitor": 2, "no_action": 3}
        items.sort(key=lambda r: (priority.get(r["type"], 4), r["current_stock"]))
        return {"items": items, "counts": counts, "total": len(items)}

    # -- simulation ---------------------------------------------------------

    def backtest(
        self,
        product_id: str,
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        holding_cost_rate: float = 0.20,
        ordering_cost_per_order: float = 500.0,
        stockout_cost_per_unit: float = 1000.0,
        inventory_days: int = 5,
    ) -> Dict[str, Any]:
        """Historical policy backtest for one of this tenant's products.

        Reuses the shared simulation engine unchanged; only the *input data*
        differs from V1 — it is this tenant's own sales history and this
        tenant's own error spread, never the global CSV. The comparison is
        therefore a like-for-like test of the XGBoost policy against a moving
        average baseline on the customer's own demand.
        """

        import pandas as pd

        from src.inventory.config import prepare_product_inventory_config
        from src.inventory.simulation import (
            run_backtest,
            run_baseline_backtest,
        )
        from src.evaluation.metrics import compare_inventory_strategies
        from backend.services import MODEL_FEATURES

        self._check_product(product_id)
        product = self.products[product_id]
        history = self.sales_history_for(product_id)
        if not history:
            raise ValueError(
                f"'{product_id}' has no sales history, so there is nothing to "
                "backtest."
            )

        enriched, _warnings = self._enrich_history(product_id, history)
        frame = pd.DataFrame(enriched)
        frame["date"] = pd.to_datetime(frame["date"])
        frame = frame.sort_values("date").reset_index(drop=True)

        span = frame["date"].max() - frame["date"].min()
        if start_date is None:
            # Backtest over the most recent ~90 days that still has at least a
            # quarter of the series in front of it to train the starting stock.
            backtest_end = frame["date"].max()
            backtest_start = max(
                frame["date"].min() + pd.Timedelta(days=28),
                backtest_end - pd.Timedelta(days=89),
            )
        else:
            backtest_start = pd.Timestamp(start_date)
            backtest_end = pd.Timestamp(end_date) if end_date else frame["date"].max()

        if backtest_end <= backtest_start:
            raise ValueError(
                "The backtest end date must be after its start date."
            )
        if backtest_start < frame["date"].min():
            raise ValueError(
                "The backtest starts before this product's first recorded sale."
            )

        lead_time_days = max(int(product.lead_time_days or 0), 1)
        units = [r.get("units_sold", 0) for r in history]
        config = prepare_product_inventory_config(
            product_id=product_id,
            product_history=frame,
            # The tenant's own residual spread, not the global error table.
            forecast_error_std=_forecast_error_std(units),
            backtest_start=backtest_start,
            lead_time_days=lead_time_days,
            inventory_days=max(1, int(inventory_days)),
        )

        from backend.main import get_service

        model = get_service().model
        xgb_results = run_backtest(
            product_history=frame,
            start_date=backtest_start,
            end_date=backtest_end,
            starting_stock=config["starting_stock"],
            model=model,
            model_features=MODEL_FEATURES,
            safety_stock=config["safety_stock"],
            lead_time_days=lead_time_days,
        )
        baseline_results = run_baseline_backtest(
            product_history=frame,
            start_date=backtest_start,
            end_date=backtest_end,
            starting_stock=config["starting_stock"],
            safety_stock=config["safety_stock"],
            lead_time_days=lead_time_days,
        )

        comparison = compare_inventory_strategies(
            strategy_a_name="xgboost",
            strategy_a_results=xgb_results,
            strategy_b_name="baseline",
            strategy_b_results=baseline_results,
            unit_cost=float(product.unit_cost or 0.0),
            holding_cost_rate=holding_cost_rate,
            ordering_cost_per_order=ordering_cost_per_order,
            stockout_cost_per_unit=stockout_cost_per_unit,
        )

        trajectory: List[Dict[str, Any]] = []
        for index in range(len(xgb_results)):
            xgb_row = xgb_results.iloc[index]
            base_row = baseline_results.iloc[index]
            trajectory.append({
                "date": str(pd.Timestamp(xgb_row["date"]).date()),
                "actual_demand": int(xgb_row["demand"]),
                "xgb_closing_stock": int(xgb_row["closing_stock"]),
                "baseline_closing_stock": int(base_row["closing_stock"]),
                "xgb_order_qty": int(xgb_row["order_qty"]),
                "baseline_order_qty": int(base_row["order_qty"]),
                "xgb_stockout_units": int(xgb_row["stockout_units"]),
                "baseline_stockout_units": int(base_row["stockout_units"]),
                "xgb_inventory_position": int(xgb_row["inventory_position"]),
                "baseline_inventory_position": int(base_row["inventory_position"]),
            })

        return {
            "product_id": product_id,
            "product_name": product.product_name,
            "start_date": str(backtest_start.date()),
            "end_date": str(backtest_end.date()),
            "duration_days": (backtest_end - backtest_start).days + 1,
            "unit_cost": float(product.unit_cost or 0.0),
            "starting_stock": config["starting_stock"],
            "safety_stock": round(float(config["safety_stock"]), 2),
            "forecast_error_std": round(float(config["forecast_error_std"]), 3),
            "lead_time_days": lead_time_days,
            "xgb_metrics": comparison["xgboost"],
            "baseline_metrics": comparison["baseline"],
            "cost_comparison": {
                "recommended_strategy": comparison["recommended_strategy"],
                "expected_savings": comparison["expected_savings"],
                "cost_difference": comparison["cost_difference"],
            },
            "daily_trajectory": trajectory,
        }

    def _recommendation_row(self, product_id: str) -> Dict[str, Any]:
        state = self._inventory_state(product_id)
        product = self.products[product_id]
        position = float(product.inventory_position)
        lead_days = max(int(product.lead_time_days or 0), 1)
        forecast = self.demand_forecast(product_id, audit=False)

        projected_lead_demand = round(
            sum(pt["forecast"] for pt in forecast["points"][:lead_days]), 2
        )
        daily_demand = float(forecast["avg_daily"] or state["daily_avg"])
        growth = float(forecast["growth_pct"])
        status = state["status"]

        reorder = self.reorder_recommendation(product_id)
        quantity = int(reorder["recommended_order_qty"])

        if status == "critical":
            kind = "critical"
            title = "Reorder Required"
            reason = (
                f"Projected demand of {projected_lead_demand:g} units during the "
                f"{lead_days}-day lead time exceeds available inventory of "
                f"{position:g} units."
                if projected_lead_demand > position
                else f"Current inventory of {position:g} units is below the "
                     f"safety stock level of {state['safety_stock']:g} units."
            )
            action = "Reorder now"
        elif status == "low":
            kind = "reorder"
            title = "Reorder Recommended"
            reason = (
                f"Inventory of {position:g} units is below the reorder point of "
                f"{state['reorder_point']:g} units, with a {lead_days}-day supplier "
                "lead time."
            )
            action = "Review reorder"
        elif status == "overstocked":
            kind = "reorder"
            title = "Excess Inventory"
            reason = (
                f"Stock of {position:g} units is well above the {lead_days}-day "
                f"target of {state['target_stock']:g} units. Consider a promotion "
                "or slower replenishment."
            )
            action = "Review stock"
        elif growth > 2:
            kind = "monitor"
            title = "Monitor"
            reason = (
                "Inventory is currently sufficient, but demand is increasing. "
                "Keep an eye on stock levels."
            )
            action = "View product"
        else:
            kind = "no_action"
            title = "No Action"
            reason = "Inventory levels are healthy."
            action = "View product"

        return {
            "product_id": product_id,
            "product_name": product.product_name,
            "category": product.category,
            "type": kind,
            "title": title,
            "reason": reason,
            "action_label": action,
            "current_stock": product.current_stock,
            "inventory_position": position,
            "reorder_point": round(float(state["reorder_point"]), 2),
            "safety_stock": round(float(state["safety_stock"]), 2),
            "lead_time_days": lead_days,
            "projected_demand": projected_lead_demand,
            "daily_demand": round(daily_demand, 2),
            "growth_pct": round(growth, 2),
            "recommended_order_qty": quantity,
            "reorder_required": bool(reorder["reorder_required"]),
            "stockout_risk": state["stockout_risk"],
            "status": status,
            "fallback_used": forecast["fallback_used"],
            "eligibility": forecast["eligibility"],
            "last_updated": product.updated_at,
        }

    # -- internal ------------------------------------------------------------

    def _check_product(self, product_id: str) -> None:
        if product_id not in self.products:
            raise TenantIsolationError(
                f"'{product_id}' is not in workspace '{self.user_id}' - "
                "the product either does not exist here or belongs to another "
                "tenant. Nothing was read or written."
            )

    def _new_audit_entry(self, action: str, product_id: Optional[str],
                         detail: Optional[Dict[str, Any]]) -> AuditEntry:
        """Build one tenant-owned audit record without writing it anywhere."""

        return AuditEntry(
            id=str(uuid4())[:12],
            user_id=self.user_id,
            action=action,
            product_id=product_id,
            detail=detail or {},
            created_at=_now(),
        )

    def _audit_many(self, entries: Sequence[AuditEntry]) -> None:
        """Persist and record a batch of audit entries as one unit.

        This is the batched form of :meth:`_audit` and shares its ordering
        contract: the remote write happens first, so if it fails the error
        propagates and *none* of the entries are appended locally. Entries are
        stamped with this workspace's verified user_id, and the adapter refuses
        an entry owned by anyone else. Batching exists only to bound the number
        of round trips for a bulk ingest; it does not relax any check.
        """

        materialized = list(entries)
        if not materialized:
            return
        from backend.supabase import append_audit_entries, supabase_enabled

        if supabase_enabled():
            append_audit_entries(self.user_id, [
                {
                    "id": entry.id,
                    "action": entry.action,
                    "product_id": entry.product_id,
                    "detail": entry.detail,
                    "created_at": entry.created_at,
                }
                for entry in materialized
            ])
        self.audit.extend(materialized)
        return None

    def _audit(self, action: str, product_id: Optional[str] = None,
               detail: Optional[Dict[str, Any]] = None) -> None:
        # Every audit event flows through this one method, so persisting here
        # keeps product, sales, forecast, and metrics history durable without
        # touching any individual call site. As with sales and products, the
        # remote write happens first: if it fails the error propagates and
        # nothing is appended locally, so a decision is never recorded as
        # persisted when it was not. The entry is stamped with this workspace's
        # verified user_id; the adapter refuses an entry owned by anyone else.
        self._audit_many([
            self._new_audit_entry(action, product_id, detail)
        ])
        # Audit history is append-only.  Do not silently discard old decisions
        # just because a tenant has been active for a long time; a production
        # persistence layer can archive them explicitly if retention is needed.
        return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Eligibility and forecast helpers
# ---------------------------------------------------------------------------


def _eligibility_for_history(
    history: List[Dict[str, Any]],
    *,
    model_available: bool,
    known_categories: Optional[set[str]] = None,
) -> EligibilityDecision:
    """Run the full per-product gate pipeline on canonical stored history.

    History tiers use the number of distinct observed sales days, not merely
    the calendar span.  A sparse series therefore cannot qualify for ML just
    because two observations sit far apart, and a duplicate cannot inflate its
    apparent history.
    """
    seen_dates: set[date] = set()
    required_ok = bool(history)
    numeric_ok = True
    quality_errors = 0
    category_ok = True
    feature_ranges_ok = True
    feature_gap: List[str] = []
    model_features = ("price", "promotion", "units_sold")
    category_universe_provided = known_categories is not None
    known_category_keys = {
        str(category).strip().casefold()
        for category in (known_categories or set())
        if str(category).strip()
        and str(category).strip().casefold() not in {"unknown", "uncategorized"}
    }

    for row in history:
        if not isinstance(row, dict):
            required_ok = False
            numeric_ok = False
            quality_errors += 1
            continue

        values = {
            key: row.get(key)
            for key in ("product_id", "date", "units_sold")
        }
        required_ok = required_ok and all(
            value is not None and bool(str(value).strip())
            for value in values.values()
        )

        raw_date = row.get("date")
        if isinstance(raw_date, datetime):
            parsed = raw_date.date()
        elif isinstance(raw_date, date):
            parsed = raw_date
        else:
            parsed = parse_date_iso(raw_date)
        if parsed is None:
            quality_errors += 1
        else:
            if parsed in seen_dates:
                quality_errors += 1
            seen_dates.add(parsed)

        raw_units = row.get("units_sold")
        if isinstance(raw_units, bool):
            numeric_ok = False
            quality_errors += 1
        else:
            try:
                units = float(raw_units)
                if (
                    not math.isfinite(units)
                    or units < 0
                    or units != int(units)
                ):
                    numeric_ok = False
                    quality_errors += 1
            except (TypeError, ValueError, OverflowError):
                numeric_ok = False
                quality_errors += 1

        for feature in ("price", "promotion"):
            if feature not in row or row.get(feature) is None or not str(
                row.get(feature)
            ).strip():
                if feature not in feature_gap:
                    feature_gap.append(feature)

        if "price" in row and row.get("price") is not None:
            try:
                price = float(row["price"])
                if not math.isfinite(price) or price < 0:
                    feature_ranges_ok = False
            except (TypeError, ValueError, OverflowError):
                numeric_ok = False
        if "promotion" in row and row.get("promotion") is not None:
            try:
                promotion = float(row["promotion"])
                if (
                    not math.isfinite(promotion)
                    or promotion not in (0.0, 1.0)
                ):
                    feature_ranges_ok = False
            except (TypeError, ValueError, OverflowError):
                numeric_ok = False

        category = str(row.get("category") or "").strip()
        if (
            not category
            or (
                category_universe_provided
                and category.casefold() not in known_category_keys
            )
        ):
            category_ok = False

    if feature_gap:
        feature_ranges_ok = False
    history_days = len(seen_dates)
    checker = ModelEligibilityCheck(
        model_available=model_available,
        model_features=list(model_features),
        known_categories=known_category_keys or None,
        model_version=MODEL_VERSION,
    )
    return checker.evaluate(
        history_days=history_days,
        required_fields_present=required_ok,
        numeric_types_ok=numeric_ok,
        had_error_problems=quality_errors,
        category_known=category_ok,
        feature_values_in_range=feature_ranges_ok,
        feature_gap=feature_gap,
    )


# ---------------------------------------------------------------------------
# SEPARATE ML + baseline helpers (kept minimal to stay import-light and
# dependency-free so the isolation slice is verifiable without the heavy stack).
# They produce the SAME shapes the real services return; swap via service layer.
# ---------------------------------------------------------------------------

def _baseline_estimate(history: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return a labeled baseline only when every source row is usable.

    A malformed row invalidates the fallback rather than being skipped and
    silently changing the denominator.  The same canonical sales validator used
    at ingestion is therefore run once more here; optional fields may be absent
    (with visible warnings), but required/type/range/date/duplicate problems
    never produce a partial estimate.
    """
    if not history:
        return []

    canonical_rows: List[Dict[str, Any]] = []
    for row in history:
        if not isinstance(row, dict):
            return []
        # Provenance is server-owned metadata, not a business column.
        canonical_rows.append({
            key: value for key, value in row.items()
            if key != "units_sold_source"
        })

    union_columns = sorted({
        str(key)
        for row in canonical_rows
        for key in row.keys()
    })
    identity_mapping = {
        field.canonical_name: field.canonical_name
        for field in SALES_RECORD.fields
        if field.canonical_name in union_columns
    }
    report = validate_rows(
        canonical_rows,
        SALES_RECORD,
        mapping=identity_mapping,
        columns=union_columns or None,
    )
    schema_errors = [
        problem for problem in report.schema_problems
        if problem.severity == SEV_ERROR
    ]
    if report.rejected_rows or schema_errors:
        return []
    if any(problem.category == "duplicate" for problem in report.problems):
        return []

    total = 0.0
    seen_dates: List[date] = []
    product_ids: set[str] = set()
    for validated in report.rows:
        if not validated.accepted:
            return []
        values = validated.values
        raw_date = values.get("date")
        parsed_date = (
            raw_date.date()
            if isinstance(raw_date, datetime)
            else raw_date
            if isinstance(raw_date, date)
            else parse_date_iso(raw_date)
        )
        if parsed_date is None:
            return []
        try:
            units = float(values["units_sold"])
        except (KeyError, TypeError, ValueError, OverflowError):
            return []
        if not math.isfinite(units) or units < 0 or units != int(units):
            return []
        product_id = str(values.get("product_id") or "").strip()
        if not product_id:
            return []
        product_ids.add(product_id)
        seen_dates.append(parsed_date)
        total += units

    if len(product_ids) != 1 or total <= 0:
        return []
    daily_avg = round(total / len(report.rows), 2)
    anchor = max(seen_dates).isoformat()
    product_id = next(iter(product_ids))
    forecast: List[Dict[str, Any]] = []
    for offset in range(1, 31):
        forecast_date = _step_days(anchor, offset)
        if not forecast_date:
            # Never emit a forecast row with an invented/invalid date when the
            # source is at the representable calendar boundary.
            return []
        forecast.append({
            "date": forecast_date,
            "product_id": product_id,
            "forecast_units": daily_avg,
            "source": "baseline",
            "ml": False,
        })
    return forecast


def _step_days(start: str, days: int) -> str:
    """Add ``days`` to an ISO date string; returns '' when it cannot parse.

    Deterministic and never invents: unparseable input yields an empty string,
    and callers treat that as "no date" rather than guessing a replacement.
    """
    try:
        from datetime import date as _Date, timedelta

        y, m, d = (int(part) for part in start.split("-"))
        return (_Date(y, m, d) + timedelta(days=days)).isoformat()
    except (ValueError, TypeError, AttributeError, OverflowError):
        return ""


def _as_float(value: Any, default: float = 0.0) -> float:
    """Best-effort finite float, never raising on unexpected input.

    Used on values that already passed validation or came from a numeric
    engine, so this only guards against ``None``/NaN rather than hiding bad
    data — an unparseable value falls back to ``default``.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(number) or math.isinf(number):
        return default
    return number


def _forecast_error_std(units: Sequence[Any]) -> float:
    """Residual spread of demand around a 7-day rolling mean.

    This is the tenant's own forecast uncertainty: a product whose daily sales
    swing wildly gets a wide confidence band, a steady one gets a narrow band.
    With too little history to measure anything meaningful a conservative
    fraction of the mean is used, so the band is never falsely reported as
    near-zero.
    """
    values = [max(0.0, _as_float(u)) for u in units]
    values = [v for v in values if v > 0]
    if len(values) < 8:
        return round(max(values, default=0.0) * 0.4, 4) if values else 0.0
    window = min(7, max(3, len(values) // 4))
    residuals: List[float] = []
    for index in range(window, len(values)):
        baseline = sum(values[index - window:index]) / window
        residuals.append(values[index] - baseline)
    if len(residuals) < 2:
        return round(max(values) * 0.4, 4)
    mean = sum(residuals) / len(residuals)
    variance = sum((r - mean) ** 2 for r in residuals) / (len(residuals) - 1)
    # Floor the spread at 5% of the mean so a suspiciously perfect history
    # never produces a band of literally zero width.
    floor = 0.05 * (sum(values) / len(values))
    return round(max(math.sqrt(max(variance, 0.0)), floor), 4)


def _trend_from_history(
    history: Sequence[Dict[str, Any]],
) -> Tuple[str, float]:
    """Compare the last 7 days against the 21 before them.

    Returns ``(trend, growth_pct)`` where trend is one of
    ``increasing`` / ``decreasing`` / ``stable`` using the same 2% dead band
    the rest of the application applies to growth.
    """
    units = [
        _as_float(r.get("units_sold")) for r in history if _as_float(r.get("units_sold")) > 0
    ]
    if len(units) < 28:
        if len(units) < 2:
            return "stable", 0.0
        half = len(units) // 2
        recent = sum(units[half:]) / (len(units) - half)
        prior = sum(units[:half]) / half
    else:
        recent = sum(units[-7:]) / 7
        prior = sum(units[-28:-7]) / 21
    if prior <= 0.001:
        return "stable", 0.0
    growth = (recent / prior - 1.0) * 100.0
    if growth > 2:
        return "increasing", round(growth, 2)
    if growth < -2:
        return "decreasing", round(growth, 2)
    return "stable", round(growth, 2)


def _ml_forecast(
    history: List[Dict[str, Any]], *, horizon: Optional[int] = None
) -> List[Dict[str, Any]]:
    """ML adapter for the eligibility-approved path.

    The heavy imports stay local so validation, tenant, and job routes remain
    usable when optional ML resources are unavailable. Any failure is
    surfaced to the caller, which records a labeled baseline fallback.
    """
    from backend.main import get_service

    service = get_service()
    # Reuse the real ML forecast path mirroring services.py's forecast_units names.
    import pandas as pd
    from src.models.forecasting import forecast_product_demand
    from backend.services import MODEL_FEATURES

    try:
        history_df = pd.DataFrame(history)
        if history_df.empty:
            return []
        forecast_df = forecast_product_demand(
            model=service.model,
            product_history=history_df,
            model_features=MODEL_FEATURES,
            horizon=DEFAULT_ML_HORIZON if horizon is None else max(1, int(horizon)),
        )
        if forecast_df is None or getattr(forecast_df, "empty", False):
            raise RuntimeError("The ML forecast engine returned no forecast rows.")
        records = forecast_df.to_dict("records")
        if not records:
            raise RuntimeError("The ML forecast engine returned no forecast rows.")
        return records
    except Exception as exc:  # noqa: BLE001 — convert to a safe product error
        raise RuntimeError(
            "The ML forecast engine is unavailable for this product; no "
            "forecast was fabricated."
        ) from exc


# ---------------------------------------------------------------------------
# Canonical demo seed (additive — the canonical home for "demo user has data,
# every other tenant starts EMPTY and never copies another tenant's rows").
# ---------------------------------------------------------------------------

# The canonical store records 5 products over 731 days each, in one contiguous
# block per product. The default row budget is therefore spread as 200 days per
# product, which is what a demo tenant needs to be worth looking at: 200 days is
# the forecaster's ``preferred_range`` (180-364), so the seeded dashboard shows
# real ML forecasts instead of a labeled ``baseline`` fallback.
_DEMO_SEED_LIMIT = 1000


def apply_inventory_snapshot(catalog: Dict[str, Dict[str, Any]]) -> int:
    """Overlay the canonical inventory snapshot onto a seeded catalog.

    ``data/raw/inventory_snapshot.csv`` carries the stock, lead time and unit
    cost for the same product ids as the sales store. Without it a seeded
    catalog starts at zero stock everywhere, so every product reads as
    critically short and the inventory pages say nothing true about the tenant.

    Only ids already present in ``catalog`` are touched, so the snapshot can
    never add a product the sales store does not have. A missing or unreadable
    snapshot leaves the catalog exactly as it was rather than failing the seed:
    the history is still worth loading, and zero stock is a documented default
    rather than an invented number.
    """

    from backend.config import RAW_INVENTORY_CSV

    if not RAW_INVENTORY_CSV.exists():
        return 0

    applied = 0
    with RAW_INVENTORY_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            pid = str(row.get("product_id") or "").strip()
            entry = catalog.get(pid)
            if entry is None:
                continue
            for column, canonical in (
                ("current_stock", "current_stock"),
                ("open_order_qty", "open_order_qty"),
                ("lead_time_days", "lead_time_days"),
                ("unit_cost", "unit_cost"),
                ("expected_arrival_date", "expected_arrival_date"),
            ):
                value = (row.get(column) or "").strip()
                if not value:
                    continue
                entry[canonical] = value
            applied += 1
    return applied


def _seed_product_budget(path: Path, limit: int) -> Dict[str, int]:
    """Divide ``limit`` sales rows evenly across the products in the raw store.

    The canonical store keeps one contiguous block of days per product, so
    taking the first ``limit`` rows would hand the entire budget to whichever
    product happens to be recorded first and leave the demo tenant with a
    one-product catalog. Each product instead gets ``limit // count`` rows and
    the remainder is handed out in sorted product order, which makes the result
    deterministic for a given ``limit``.

    A product with fewer recorded rows than its share contributes only what it
    has, so the caller may still come in under ``limit`` — the budget is a
    ceiling, never a promise.
    """

    recorded: Dict[str, int] = {}
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        for r in csv.DictReader(handle):
            pid = str(r.get("product_id") or "").strip()
            if pid:
                recorded[pid] = recorded.get(pid, 0) + 1
    if not recorded:
        return {}
    ordered = sorted(recorded)
    share, extra = divmod(limit, len(ordered))
    return {
        pid: min(recorded[pid], share + (1 if index < extra else 0))
        for index, pid in enumerate(ordered)
    }


def seed_canonical_demo(ws: "TenantWorkspace", *, limit: int = _DEMO_SEED_LIMIT) -> int:
    """Seed ``ws`` ONLY from the canonical raw sales store (``REPO_ROOT /
    ``data/raw/sales.csv``, byte-verified columns: date, product_id,
    product_name, category, price, discount, promotion, day_of_week, month,
    is_weekend, units_sold).

    This is the ONLY module that ever walks the canonical store to seed a demo
    tenant. It reuses ``TenantWorkspace.add_products`` / ``upsert_sales_rows``
    exclusively (never another tenant's rows), returns the number of sales rows
    written, and is a no-op for an empty store. Nothing here invents rows.

    The catalog is overlaid with ``data/raw/inventory_snapshot.csv`` (see
    :func:`apply_inventory_snapshot`) so seeded products carry the stock, lead
    time and unit cost the same raw dataset records for them.

    Rows are collected first and committed in one batch per collection. The
    canonical result is identical to a per-row walk, but a seeded demo tenant
    costs a handful of remote requests instead of one per row, which matters
    once Supabase is enabled and each request is a real network round trip.

    ``limit`` is a ceiling on sales rows, never a head-of-file slice: it is
    divided evenly across every product in the store (see
    :func:`_seed_product_budget`) so a demo tenant gets the whole catalog
    instead of one product and four empty slots.
    """
    from backend.config import RAW_INVENTORY_CSV, RAW_SALES_CSV

    if limit <= 0 or not RAW_SALES_CSV.exists():
        return 0

    # Seeding is a canonical transaction for this helper: if one raw row is
    # malformed, do not leave a half-seeded product/catalog behind.
    products_before = dict(ws.products)
    sales_before = dict(ws.sales_records)
    audit_before = list(ws.audit)
    required_seed_columns = {
        "date",
        "product_id",
        "product_name",
        "category",
        "price",
        "promotion",
        "units_sold",
    }
    budget = _seed_product_budget(RAW_SALES_CSV, limit)
    catalog: Dict[str, Dict[str, Any]] = {}
    sales_rows: List[Dict[str, Any]] = []
    try:
        taken: Dict[str, int] = {}
        with RAW_SALES_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row_number, r in enumerate(reader, start=2):
                pid = str(r.get("product_id") or "").strip()
                if not pid:
                    # A row that cannot be attributed to a product cannot be
                    # budgeted, and the canonical store is byte-verified, so
                    # this is corruption rather than something to skip.
                    raise ValueError(
                        f"Demo seed row {row_number} has no product_id."
                    )
                if taken.get(pid, 0) >= budget.get(pid, 0):
                    continue
                missing_columns = sorted(
                    column for column in required_seed_columns
                    if r.get(column) is None
                )
                if missing_columns:
                    raise ValueError(
                        f"Demo seed row {row_number} is missing required source "
                        f"columns: {', '.join(missing_columns)}."
                    )
                # One catalog entry per product, not one per row. The listing
                # price is taken from the row's own recorded price so a product
                # whose sales history carries no price still has a real catalog
                # price for the forecaster to fall back to.
                entry = catalog.setdefault(pid, {
                    "product_id": pid,
                    "product_name": str(r["product_name"]),
                    "category": str(r["category"]),
                    "unit_price": r["price"],
                })
                taken[pid] = taken.get(pid, 0) + 1
                sales_rows.append(
                    {
                        "date": r["date"],
                        "product_id": pid,
                        # Keep the raw CSV cells intact until the canonical sales
                        # validator runs.  Converting here with int()/float()
                        # would silently truncate a malformed seed row before the
                        # strict ingestion boundary sees it.
                        "units_sold": r["units_sold"],
                        "price": r["price"],
                        "promotion": r["promotion"],
                        "category": r["category"],
                    }
                )
                if len(sales_rows) >= limit:
                    break
        if not sales_rows:
            return 0
        apply_inventory_snapshot(catalog)
        # Products first: the sales contract requires the product to exist.
        ws.add_products(list(catalog.values()))
        written = ws.upsert_sales_rows(sales_rows)
    except Exception:
        ws.products = products_before
        ws.sales_records = sales_before
        ws.audit = audit_before
        raise
    return written
