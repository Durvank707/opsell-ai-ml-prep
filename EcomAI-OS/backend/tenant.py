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
from itertools import islice
import csv
import math
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

    def hydrate_sales(self) -> int:
        """Load this user's canonical sales rows when Supabase is enabled.

        Hydration is user-scoped, validated, and atomic.  A failed or malformed
        remote read leaves the local workspace unchanged; it never falls back
        to another tenant or marks unverified rows as persisted.
        """

        if self.remote_hydrated:
            return len(self.sales_records)
        from backend.supabase import fetch_sales, supabase_enabled

        if not supabase_enabled():
            return 0

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

        self.remote_hydrated = True
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

        p = ProductRow(
            product_id=pid,
            product_name=product_name,
            category=category,
            unit_price=_optional_nonnegative_number(row, "unit_price", 0.0),
            current_stock=_optional_nonnegative_int(row, "current_stock", 0),
            open_order_qty=_optional_nonnegative_int(row, "open_order_qty", 0),
            expected_arrival_date=arrival,
            lead_time_days=_optional_nonnegative_int(row, "lead_time_days", 7),
            unit_cost=_optional_nonnegative_number(row, "unit_cost", 0.0),
            created_at=_now(),
            updated_at=_now(),
        )
        self.products[pid] = p
        self._audit("product_upserted", pid, {"current_stock": p.current_stock})
        return p

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
            self._audit("sales_upserted", pid, audit_detail)
            written += 1
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
    ) -> Dict[str, Any]:
        """Eligibility-gated forecast with an auditable, labeled fallback.

        A failure in one product's optional ML path is converted to a safe
        baseline result for that product only.  It is never allowed to abort a
        multi-product job, and the failure is recorded without exposing a raw
        traceback.  When ``history`` is supplied it is treated as a transient,
        explicitly validated input for this owned product; it is never used to
        read or copy another tenant's workspace.
        """
        self._check_product(product_id)
        history_warnings: List[Dict[str, Any]] = []
        if history is None:
            history = self.sales_history_for(product_id)
        else:
            history, history_warnings = self._validated_request_history(
                product_id, history
            )
        product_category = self.products[product_id].category
        decision = _eligibility_for_history(
            history,
            model_available=model_available,
            known_categories={product_category},
        )

        if decision.eligible:
            try:
                forecast = _ml_forecast(history)
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
                self._audit("forecast_ml_failed", product_id, {
                    "model_version": MODEL_VERSION,
                    "eligibility": fallback_decision.tier,
                    "fallback_used": "baseline",
                    "confidence": fallback_decision.confidence_label,
                    "decision": fallback_decision.to_dict(),
                })
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
        """Inventory intelligence for one product (user-scoped, decision-transparent)."""
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
        safety_stock = round(1.645 * max(daily_avg * 0.4, 0.5), 2)
        reorder_point = round(lead_time_demand + safety_stock, 2)
        inv_pos = p.inventory_position
        risk = "HIGH" if inv_pos < reorder_point else ("MEDIUM" if inv_pos < reorder_point * 1.4 else "LOW")
        days_covered = round(inv_pos / max(daily_avg, 0.0001), 1)

        result = {
            "product_id": product_id,
            "product_name": p.product_name,
            "category": p.category,
            "unit_price": p.unit_price,
            "current_stock": p.current_stock,
            "open_order_qty": p.open_order_qty,
            "inventory_position": inv_pos,
            "lead_time_days": p.lead_time_days,
            "daily_avg": daily_avg,
            "safety_stock": safety_stock,
            "reorder_point": reorder_point,
            "days_covered": days_covered,
            "stockout_risk": risk,
            "eligibility": decision.to_dict(),
        }
        self._audit("metrics_recomputed", product_id, {"stockout_risk": risk})
        return result

    # -- internal ------------------------------------------------------------

    def _check_product(self, product_id: str) -> None:
        if product_id not in self.products:
            raise TenantIsolationError(
                f"'{product_id}' is not in workspace '{self.user_id}' - "
                "the product either does not exist here or belongs to another "
                "tenant. Nothing was read or written."
            )

    def _audit(self, action: str, product_id: Optional[str] = None,
               detail: Optional[Dict[str, Any]] = None) -> None:
        self.audit.append(AuditEntry(
            id=str(uuid4())[:12],
            user_id=self.user_id,
            action=action,
            product_id=product_id,
            detail=detail or {},
            created_at=_now(),
        ))
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


def _ml_forecast(history: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
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
            horizon=30,
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

_DEMO_SEED_LIMIT = 200


def seed_canonical_demo(ws: "TenantWorkspace", *, limit: int = _DEMO_SEED_LIMIT) -> int:
    """Seed ``ws`` ONLY from the canonical raw sales store (``REPO_ROOT /
    ``data/raw/sales.csv``, byte-verified columns: date, product_id,
    product_name, category, price, discount, promotion, day_of_week, month,
    is_weekend, units_sold).

    This is the ONLY module that ever walks the canonical store to seed a demo
    tenant. It reuses ``TenantWorkspace.add_product`` / ``upsert_sales_row``
    exclusively (never another tenant's rows), returns the number of sales rows
    written, and is a no-op for an empty store. Nothing here invents rows.
    """
    from backend.config import RAW_SALES_CSV

    if limit <= 0 or not RAW_SALES_CSV.exists():
        return 0

    # Seeding is a canonical transaction for this helper: if one raw row is
    # malformed, do not leave a half-seeded product/catalog behind.
    products_before = dict(ws.products)
    sales_before = dict(ws.sales_records)
    audit_before = list(ws.audit)
    written = 0
    required_seed_columns = {
        "date",
        "product_id",
        "product_name",
        "category",
        "price",
        "promotion",
        "units_sold",
    }
    try:
        with RAW_SALES_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row_number, r in enumerate(islice(reader, limit), start=2):
                missing_columns = sorted(
                    column for column in required_seed_columns
                    if r.get(column) is None
                )
                if missing_columns:
                    raise ValueError(
                        f"Demo seed row {row_number} is missing required source "
                        f"columns: {', '.join(missing_columns)}."
                    )
                pid = str(r["product_id"])
                ws.add_product(
                    {
                        "product_id": pid,
                        "product_name": str(r["product_name"]),
                        "category": str(r["category"]),
                    }
                )
                ws.upsert_sales_row(
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
                written += 1
    except Exception:
        ws.products = products_before
        ws.sales_records = sales_before
        ws.audit = audit_before
        raise
    return written
