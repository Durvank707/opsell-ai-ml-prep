"""Canonical data contracts for EcomAI-OS.

Every table in the product — products, sales, inventory, forecasts,
recommendations, simulations — maps into ONE controlled canonical schema
before it reaches the ML layer or any business logic. This module is the single
source of truth for those contracts.

The contract for each canonical field spells out, explicitly:

    canonical_name   The single name used everywhere in code, DB and ML.
    aliases          Column names a user's file may supply for this field.
    data_type        Canonical Python/SQL type.
    required         Whether the field is mandatory for this record type.
    unit             Physical unit ('' when dimensionless).
    min/max          Allowed numeric range (open-ended when None).
    missing_behaviour
                     What the system does when the value is absent; never
                     silently invents values.
    mapping_rule     How a user column maps to this canonical field.
    transformation   Guaranteed normalization applied before storage.
    ml_requirement   Whether the field is REQUIRED / USED / IGNORED by ML.

Fields try to mirror the names already used by the existing ML models
(``src/models/forecasting.py`` reads ``units_sold``, ``models/forecasting.py``
features price, discount, promotion, day_of_week, month, is_weekend, lag_*,
rolling_*; ``src/inventory`` reads current_stock, lead_time_days,
safety_stock, reorder_point, etc.) so that the production contracts are
backward-compatible with the already-trained XGBoost forecaster and the
inventory engine.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Field metadata
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FieldContract:
    """Canonical, per-field contract."""

    canonical_name: str
    aliases: tuple[str, ...] = ()
    data_type: str = "string"          # string | int | float | boolean | date | json
    required: bool = False
    unit: str = ""                     # '' when dimensionless
    min: Optional[float] = None
    max: Optional[float] = None
    missing_behaviour: str = "reject"  # reject | flag | fallback_unknown
    mapping_rule: str = ""
    transformation: str = ""
    ml_requirement: str = "IGNORED"    # REQUIRED | USED | IGNORED
    description: str = ""


def _sales_date_contract() -> FieldContract:  # noqa: D401
    return FieldContract(
        canonical_name="date",
        aliases=("date", "sale_date", "order_date", "transaction_date", "day", "sold_on"),
        data_type="date",
        required=True,
        unit="",
        missing_behaviour="reject",
        mapping_rule="Date column in unambiguous ISO form YYYY-MM-DD (or an ISO datetime); locale/ambiguous forms require explicit user resolution before upload.",
        transformation="Normalized to ISO YYYY-MM-DD",
        ml_requirement="REQUIRED",
        description="Calendar date of the sales record (time feature for models).",
    )


def _sales_units_contract() -> FieldContract:  # noqa: D401
    return FieldContract(
        canonical_name="units_sold",
        aliases=("units_sold", "units", "quantity", "qty", "units_sold_units", "units_s", "sold"),
        data_type="int",
        required=True,
        unit="units",
        min=0,
        missing_behaviour="reject",
        mapping_rule="Whole-number count of individual units sold.",
        transformation="parsed as a whole number; fractional, non-finite, and negative values are rejected",
        ml_requirement="REQUIRED",
        description="Units sold. Zero is valid demand (do not treat as missing).",
    )


def _sales_price_contract() -> FieldContract:  # noqa: D401
    return FieldContract(
        canonical_name="price",
        aliases=("price", "unit_price", "selling_price", "sale_price", "sellingprice"),
        data_type="float",
        required=False,
        unit="currency",
        min=0,
        missing_behaviour="flag",
        mapping_rule="Unit selling price (numerically convertible, e.g. '₹500' or 500.50).",
        transformation="strictly parsed as a finite float; invalid values are flagged",
        ml_requirement="USED",
        description="Unit price; needed for price-elasticity features. May be missing for short history.",
    )


def _sales_category_contract() -> FieldContract:  # noqa: D401
    return FieldContract(
        canonical_name="category",
        aliases=("category", "product_category", "category_name", "productcategory", "cat"),
        data_type="string",
        required=False,
        missing_behaviour="fallback_unknown",
        mapping_rule="Category label. Unknown values must be mapped or labeled, never silently dropped.",
        transformation="label-normalized (strip); unknown or missing labels remain flagged, never substituted",
        ml_requirement="USED",
        description="Product category; used for cross-product features.",
    )


def _sales_promotion_contract() -> FieldContract:  # noqa: D401
    return FieldContract(
        canonical_name="promotion",
        aliases=("promotion", "promo", "promoted", "promo_flag", "is_promotion"),
        data_type="boolean",
        required=False,
        min=0,
        max=1,
        missing_behaviour="fallback_unknown",
        mapping_rule="0/1 or true/false/yes/no flag whether record is a promotion.",
        transformation="normalized to 0/1 when supplied; missing remains missing and is flagged",
        ml_requirement="USED",
        description="Promotion indicator.",
    )


def _product_id_contract() -> FieldContract:  # noqa: D401
    return FieldContract(
        canonical_name="product_id",
        aliases=("product_id", "sku", "product_sku", "item_id", "pid", "id", "productid"),
        data_type="string",
        required=True,
        missing_behaviour="reject",
        mapping_rule="Product/SKU identifier as in the product catalog.",
        transformation="trimmed; identifier casing is preserved",
        ml_requirement="REQUIRED",
        description="Stable product identifier; rows without it are rejected.",
    )


# Canonical record contracts -------------------------------------------------

@dataclass(frozen=True)
class RecordContract:
    """The canonical shape of one record type (sales, product, ...)."""

    record_type: str
    fields: tuple[FieldContract, ...]
    business_key: tuple[str, ...]
    description: str = ""

    def field(self, name: str) -> Optional[FieldContract]:
        for f in self.fields:
            if f.canonical_name == name:
                return f
        return None

    def required_fields(self) -> tuple[FieldContract, ...]:
        return tuple(f for f in self.fields if f.required)


class ValidationProblemCategories:
    """Canonical taxonomy of *why* a row fails validation.

    Single source of truth for problem categories: row health, ingestion
    semantics, and copy all speak the SAME vocabulary (spec §§12-13, §40).
    Nothing is ever silently dropped or labeled with ad-hoc text. Never
    delete/rename — always additive.
    """

    MISSING_REQUIRED = "missing_required"   # before mapping-known aliases
    MISSING_VALUE = "missing_value"
    RANGE = "range"
    DATA_TYPE = "data_type"
    NEGATIVE_UNITS = "negative_units"
    ZERO_UNITS = "zero_units"
    UNKNOWN_CATEGORY = "unknown_category"
    # File/schema problems are reported at row_number=0 and never cause a
    # column to be silently discarded or guessed.
    MISSING_COLUMN = "missing_column"
    EXTRA_COLUMN = "extra_column"
    AMBIGUOUS_COLUMN = "ambiguous_column"
    DUPLICATE = "duplicate"
    EMPTY_FILE = "empty_file"
    OVERSIZED_FILE = "oversized_file"


SALES_RECORD = RecordContract(
    record_type="sales",
    description="One row of canonicalized daily sales history.",
    business_key=("product_id", "date"),
    fields=(
        _product_id_contract(),
        _sales_date_contract(),
        _sales_units_contract(),
        _sales_price_contract(),
        _sales_category_contract(),
        _sales_promotion_contract(),
    ),
)

PRODUCT_RECORD = RecordContract(
    record_type="product",
    description="Canonical product/inventory row feeding the inventory engine.",
    business_key=("product_id",),
    fields=(
        _product_id_contract(),
        FieldContract(
            "product_name",
            aliases=("product_name", "name", "title"),
            data_type="string",
            required=True,
            missing_behaviour="flag",
            ml_requirement="IGNORED",
            description="Display name (not used by ML; needed for UI).",
        ),
        FieldContract(
            "category",
            aliases=("category", "product_category"),
            data_type="string",
            required=False,
            missing_behaviour="fallback_unknown",
            ml_requirement="USED",
        ),
        FieldContract(
            "current_stock",
            aliases=("current_stock", "stock", "on_hand", "available_stock", "currentstock"),
            data_type="int",
            required=True,
            unit="units",
            min=0,
            missing_behaviour="reject",
            transformation="negative interpreted as data problem, not silent backorder",
            ml_requirement="REQUIRED",
            description="Physical on-hand stock. Negative values are flagged, never silently treated as normal inventory.",
        ),
        FieldContract(
            "lead_time_days",
            aliases=("lead_time_days", "lead_time", "replenishment_lead_time", "leadtime"),
            data_type="int",
            required=False,
            unit="days",
            min=0,
            missing_behaviour="flag",
            ml_requirement="REQUIRED",
            description="Supplier lead time. Missing lead time is never assumed; it is flagged and a fallback is applied.",
        ),
        FieldContract(
            "safety_stock",
            aliases=("safety_stock", "safety_stock_units"),
            data_type="float",
            required=False,
            unit="units",
            min=0,
            missing_behaviour="fallback_unknown",
            ml_requirement="USED",
        ),
        FieldContract(
            "reorder_point",
            aliases=("reorder_point", "rop"),
            data_type="float",
            required=False,
            unit="units",
            min=0,
            missing_behaviour="fallback_unknown",
            ml_requirement="USED",
        ),
        FieldContract(
            "open_order_qty",
            aliases=("open_order_qty", "open_orders", "open_po_qty"),
            data_type="int",
            required=False,
            unit="units",
            min=0,
            missing_behaviour="fallback_unknown",
            ml_requirement="IGNORED",
        ),
        FieldContract(
            "unit_cost",
            aliases=("unit_cost", "cost", "unit_price"),
            data_type="float",
            required=False,
            unit="currency",
            min=0,
            missing_behaviour="flag",
            ml_requirement="IGNORED",
        ),
        FieldContract(
            "expected_arrival_date",
            aliases=("expected_arrival_date", "eta", "expected_arrival"),
            data_type="date",
            required=False,
            missing_behaviour="fallback_unknown",
            ml_requirement="IGNORED",
            description="Expected next arrival; drives replenishment timeline.",
        ),
        FieldContract(
            "forecast_error_std",
            aliases=("forecast_error_std", "error_std"),
            data_type="float",
            required=False,
            min=0,
            missing_behaviour="fallback_unknown",
            ml_requirement="USED",
        ),
    ),
)

FORECAST_RECORD = RecordContract(
    record_type="forecast",
    description="Canonical forecast rows with model version + eligibility + confidence.",
    business_key=("product_id", "forecast_date"),
    fields=(
        _product_id_contract(),
        FieldContract("forecast_date", aliases=("date", "day"), data_type="date", required=True, ml_requirement="IGNORED"),
        FieldContract("forecast_units", aliases=("forecast", "units"), data_type="float", required=True, unit="units", min=0, ml_requirement="IGNORED"),
        FieldContract("model_version", aliases=("model",), data_type="string", required=True, ml_requirement="IGNORED", description="Model version that produced this row. Records that predate a retrained model keep their original version — never rewritten silently."),
        FieldContract("eligibility", aliases=("tier",), data_type="string", required=True, ml_requirement="IGNORED"),
        FieldContract("confidence", aliases=("confidence_level",), data_type="string", required=True, ml_requirement="IGNORED"),
        FieldContract("generated_at", aliases=("generated_at_utc",), data_type="date", required=True, ml_requirement="IGNORED"),
    ),
)

RECOMMENDATION_RECORD = RecordContract(
    record_type="recommendation",
    description="Canonical reorder/order recommendation row.",
    business_key=("product_id", "recommended_order_qty"),
    fields=(
        _product_id_contract(),
        FieldContract("recommended_order_qty", data_type="int", required=True, unit="units", min=0, ml_requirement="IGNORED"),
        FieldContract("reorder_required", data_type="boolean", required=True, ml_requirement="IGNORED"),
        FieldContract("reorder_point", data_type="float", required=True, min=0, ml_requirement="IGNORED"),
        FieldContract("safety_stock", data_type="float", required=True, min=0, ml_requirement="IGNORED"),
        FieldContract("inventory_position", data_type="float", required=True, ml_requirement="IGNORED"),
        FieldContract("lead_time_demand", data_type="float", required=True, min=0, ml_requirement="IGNORED"),
        FieldContract("generated_at", data_type="date", required=True, ml_requirement="IGNORED"),
    ),
)

SIMULATION_RECORD = RecordContract(
    record_type="simulation",
    description="Canonical V2 simulation output row.",
    business_key=("simulation_id", "product_id"),
    fields=(
        FieldContract("simulation_id", data_type="string", required=True, ml_requirement="IGNORED"),
        _product_id_contract(),
        FieldContract("policy", data_type="string", required=True, ml_requirement="IGNORED", description="Policy tested (xgboost, baseline, ...)"),
        FieldContract("result", data_type="json", required=True, ml_requirement="IGNORED"),
        FieldContract("generated_at", data_type="date", required=True, ml_requirement="IGNORED"),
    ),
)

ALL_RECORDS: Dict[str, RecordContract] = {
    c.record_type: c
    for c in (SALES_RECORD, PRODUCT_RECORD, FORECAST_RECORD, RECOMMENDATION_RECORD, SIMULATION_RECORD)
}


def contract_for(record_type: str) -> RecordContract:
    """Fetch a canonical contract or raise a clear NameError (fail fast)."""
    if not isinstance(record_type, str):
        raise NameError(
            f"record_type must be a canonical string; got {type(record_type).__name__}. "
            f"Known contracts: {sorted(ALL_RECORDS)}"
        )
    try:
        return ALL_RECORDS[record_type]
    except KeyError:
        raise NameError(
            f"No canonical contract registered for record_type={record_type!r}. "
            f"Known contracts: {sorted(ALL_RECORDS)}"
        )


def parse_date_iso(raw: Any) -> Optional[date]:
    """Parse only an unambiguous ISO date and return it, or ``None``.

    The ingestion contract deliberately does not guess locale order (for
    example ``03/04/2025``).  A date is accepted as exactly ``YYYY-MM-DD`` or
    as a valid ISO datetime whose date component is exactly ``YYYY-MM-DD``.
    Malformed dates, one-digit month/day components, and arbitrary suffixes
    are rejected rather than repaired.
    """
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if not value:
        return None

    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            return None

    # ``datetime.fromisoformat`` validates the complete suffix; the explicit
    # date regex prevents accepting a valid prefix followed by arbitrary text.
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T.+", value):
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            return None
        return parsed.date()
    return None
