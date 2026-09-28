"""Tests for the onboarding upload templates and their ML ground truth.

New-tenant data onboarding is the entry point to the whole product, so these
tests pin the parts that make it honest:

- the downloadable Products/Sales CSV templates carry EXACTLY the columns the
  respective importers consume — no ML feature columns, no contract-only fields
  the workspace silently ignores;
- the example template rows import cleanly into a brand-new tenant workspace
  (Products first, then Sales), and a tenant that uploads enough history reaches
  the real XGBoost forecaster rather than a silent baseline;
- the templates CSV endpoint is authenticated and refuses unknown record types;
- the "EcomAI-OS automatically creates the forecasting features" copy next to
  the Sales upload maps one-to-one onto the features the serving pipeline
  actually derives (lags, rolling demand statistics, calendar information).
"""

from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import io
import json
import secrets
import time
from datetime import date, timedelta

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend.contracts import (
    PRODUCT_RECORD,
    SALES_RECORD,
    contract_for,
    onboarding_template,
)
from backend.main import app
from backend.routers import v2
from backend.services import MODEL_FEATURES
from backend.tenant import TenantWorkspace
from backend.validation import SEV_ERROR, validate_rows

from src.features.lag_features import create_lag_features
from src.features.rolling_features import create_rolling_features
from src.features.time_features import create_time_features


SECRET = "test-" + secrets.token_urlsafe(48)
client = TestClient(app)

#: ML features the service feeds the model but the customer never supplies:
#: the serving pipeline derives these from ``date`` + ``units_sold`` inside
#: ``forecast_product_demand``. ``price``/``discount``/``promotion`` are
#: customer-supplied inputs and are NOT in this set.
DERIVED_SERVING_FEATURES = {
    "day_of_week",
    "month",
    "is_weekend",
    "lag_1",
    "lag_7",
    "lag_14",
    "lag_28",
    "rolling_mean_7",
    "rolling_mean_14",
    "rolling_mean_28",
    "rolling_std_7",
}

CUSTOMER_SUPPLIED_FEATURES = {"price", "discount", "promotion"}


def _b64(value: dict) -> str:
    encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode("ascii")


def _token(subject: str) -> str:
    now = time.time()
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": subject, "iat": now, "exp": now + 3600})
    signing_input = f"{header}.{payload}".encode("ascii")
    signature = hmac.new(
        SECRET.encode("utf-8"), signing_input, hashlib.sha256
    ).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setattr(v2, "_WORKSPACES", {})


def _template(text: str):
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    header = list(rows[0].keys()) if rows else []
    return header, rows


def _auth(subject: str) -> dict:
    return {"Authorization": f"Bearer {_token(subject)}"}


# ---------------------------------------------------------------------------
# Template columns match each importer exactly
# ---------------------------------------------------------------------------


def test_product_template_columns_are_exactly_the_importer_columns():
    header, _rows = _template(onboarding_template("product"))
    # Exactly the PRODUCT_RECORD canonical field set — what `products`
    # validation actually accepts (reorder_point/forecast_error_std included so
    # a clean download never triggers the "optional field is not mapped"
    # warning).
    assert set(header) == {f.canonical_name for f in PRODUCT_RECORD.fields}
    assert len(header) == len(set(header))
    # No derived ML feature columns.
    assert not DERIVED_SERVING_FEATURES & set(header)


def test_sales_template_columns_are_exactly_the_sales_contract_fields():
    header, _rows = _template(onboarding_template("sales"))
    assert set(header) == {f.canonical_name for f in SALES_RECORD.fields}
    # The seed CSV's redundant derived columns stay out of the upload contract.
    assert not {"day_of_week", "month", "is_weekend", "discount"} & set(header)


def test_neither_template_offers_derived_or_unavailable_ml_columns():
    for record_type in ("product", "sales"):
        header, _rows = _template(onboarding_template(record_type))
        # Lags, rolling statistics and calendar flags are created by the
        # pipeline, never asked of the uploader.
        assert not DERIVED_SERVING_FEATURES & set(header), record_type
        # `discount` is a MODEL_FEATURE but not part of the upload schema.
        assert "discount" not in set(header), record_type


# ---------------------------------------------------------------------------
# Example template rows import cleanly
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("record_type", ["product", "sales"])
def test_template_example_rows_validate_without_errors(record_type):
    header, rows = _template(onboarding_template(record_type))
    assert rows, record_type
    result = validate_rows(rows, contract_for(record_type), columns=header)
    assert result.rejected_rows == 0
    assert result.accepted_rows == len(rows)
    assert result.schema_problems == []
    blocking = [p for p in result.problems if p.severity == SEV_ERROR]
    assert blocking == []
    assert result.warn_count == 0, (
        f"{record_type} template rows should exercise no fallbacks or flags."
    )


def test_fresh_tenant_can_ingest_both_templates_end_to_end():
    user = "onboard-user"
    product_header, product_rows = _template(onboarding_template("product"))
    sales_header, sales_rows = _template(onboarding_template("sales"))

    response = client.post(
        "/api/v2/ingest",
        json={
            "user_id": user,
            "record_type": "product",
            "rows": product_rows,
            "columns": product_header,
        },
        headers=_auth(user),
    )
    assert response.status_code == 200, response.text
    assert response.json()["ingested_rows"] == len(product_rows)

    response = client.post(
        "/api/v2/ingest",
        json={
            "user_id": user,
            "record_type": "sales",
            "rows": sales_rows,
            "columns": sales_header,
        },
        headers=_auth(user),
    )
    assert response.status_code == 200, response.text
    assert response.json()["ingested_rows"] == len(sales_rows)

    ws = v2._WORKSPACES[user]
    assert set(ws.products) == {"P001", "P002"}
    assert len(ws.sales_history_for("P001")) == 3  # two channels on 09-01
    assert len(ws.sales_history_for("P002")) == 2
    assert ws.sales_records[("P001", "2026-09-01", "Online Store")]["units_sold"] == 14


# ---------------------------------------------------------------------------
# Uploaded template-style data proceeds through forecasting
# ---------------------------------------------------------------------------


def test_uploaded_history_reaches_the_real_model_once_sufficient():
    ws = TenantWorkspace("onboard-ml-user")
    _header, product_rows = _template(onboarding_template("product"))
    ws.add_products(product_rows)

    start = date(2025, 1, 1)

    def _days(count):
        return [(start + timedelta(days=i)).isoformat() for i in range(count)]

    rows = [
        {
            "product_id": "P001",
            "date": day,
            "units_sold": 5 + (index % 7),
            "price": 1299.0,
            "category": "Electronics",
            "promotion": False,
            "channel": "Online Store",
        }
        for index, day in enumerate(_days(120))
    ]
    written = ws.upsert_sales_rows(rows)
    assert written == 120

    result = ws.forecast_for("P001", audit=False)
    assert result["eligibility"]["eligible"] is True
    assert result["fallback_used"] == "ml"
    assert result["model_version"] == "xgboost-v1.0.0"
    assert len(result["forecast"]) == 30


def test_sparse_template_history_is_a_labeled_baseline_not_a_failure():
    ws = TenantWorkspace("onboard-cold-user")
    _header, product_rows = _template(onboarding_template("product"))
    ws.add_products(product_rows)
    _sales_header, sales_rows = _template(onboarding_template("sales"))
    added = ws.upsert_sales_rows(sales_rows)
    assert added == len(sales_rows)

    result = ws.forecast_for("P001", audit=False)
    assert result["eligibility"]["eligible"] is False
    assert result["fallback_used"] == "baseline"
    assert result["model_version"] is None
    assert result["warning"]


# ---------------------------------------------------------------------------
# Templates endpoint
# ---------------------------------------------------------------------------


def test_templates_endpoint_requires_auth():
    response = client.get("/api/v2/templates/sales")
    assert response.status_code == 401


def test_templates_endpoint_serves_csv_and_refuses_unknown_types():
    user = "tpl-user"
    response = client.get(
        "/api/v2/templates/sales", params={"user_id": user}, headers=_auth(user)
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert response.text == onboarding_template("sales")
    assert response.text.splitlines()[0].startswith("date,product_id,units_sold")

    response = client.get(
        "/api/v2/templates/product", params={"user_id": user}, headers=_auth(user)
    )
    assert response.status_code == 200
    assert response.text.splitlines()[0].startswith("product_id,product_name")

    response = client.get(
        "/api/v2/templates/inventory", params={"user_id": user}, headers=_auth(user)
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# "Automatic feature engineering" copy matches the serving pipeline
# ---------------------------------------------------------------------------


def test_model_features_split_into_supplied_and_derived_is_exact():
    # The customer never supplies lag/rolling/calendar features: the pipeline
    # creates them. These three sets must tile MODEL_FEATURES exactly, or the
    # onboarding copy (and the templates) are describing a different model.
    assert set(MODEL_FEATURES) == DERIVED_SERVING_FEATURES | CUSTOMER_SUPPLIED_FEATURES
    assert "discount" not in DERIVED_SERVING_FEATURES
    assert "promotion" not in DERIVED_SERVING_FEATURES
    assert "price" not in DERIVED_SERVING_FEATURES


def test_derived_features_the_copy_claims_are_actually_built():
    # Apply the real feature modules to a minimal customer-shaped frame and
    # confirm the features the onboarding copy names ("previous-day sales,
    # weekly history, rolling demand statistics, calendar information") are the
    # ones present in the model's feature set.
    df = pd.DataFrame(
        {
            "product_id": ["P1"] * 60,
            "date": pd.date_range("2025-01-01", periods=60),
            "units_sold": range(60),
        }
    )
    df = create_time_features(df)
    df = create_lag_features(df)
    df = create_rolling_features(df)
    buildable = {col for col in df.columns if col in MODEL_FEATURES}
    assert buildable == DERIVED_SERVING_FEATURES