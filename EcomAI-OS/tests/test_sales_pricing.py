"""Regression tests for how a sales record is priced.

Revenue is ``units_sold × the price that sale was made at``. The adapter used to
read only the row's own ``price``, so a sale that recorded no price produced
``None`` and rendered as ₹0 — a total that looked like the tenant sold nothing
for, rather than like the file was missing a column. Meanwhile the forecaster
already fell back to the product's catalog price for exactly these rows, so the
table and the model disagreed about the same sale.

One rule is tested here, used by the table, the summary and the model: the row's
own price when it has one, else the product's catalog price, else absent.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import v2
from backend.tenant import TenantWorkspace

SECRET = "test-" + secrets.token_urlsafe(48)
client = TestClient(app)

# 5 units at 799 is 3995: the example a tenant would check by hand.
PRICED_ROW = {"date": "2026-09-01", "units_sold": 5, "price": 799.0}


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setattr(v2, "_WORKSPACES", {})


def _b64(value: dict) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode("utf-8")
    ).rstrip(b"=").decode("ascii")


def _token(subject: str) -> str:
    now = time.time()
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": subject, "iat": now, "exp": now + 3600})
    signature = hmac.new(
        SECRET.encode("utf-8"), f"{header}.{payload}".encode("ascii"), hashlib.sha256
    ).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode()}"


def _workspace(unit_price=799.0, product_id="P001"):
    ws = TenantWorkspace("price-user")
    ws.add_products([{
        "product_id": product_id,
        "product_name": "Widget",
        "category": "Electronics",
        "current_stock": 10,
        "lead_time_days": 4,
        "unit_price": unit_price,
    }])
    return ws


# ---------------------------------------------------------------------------
# The price a record is worth
# ---------------------------------------------------------------------------


def test_a_row_that_states_its_price_is_worth_that_price():
    ws = _workspace(unit_price=500.0)
    ws.upsert_sales_rows([{"product_id": "P001", **PRICED_ROW}])

    row = ws.list_sales()["rows"][0]

    assert row["price"] == 799.0
    assert row["unit_price"] == 799.0
    assert row["units_sold"] == 5
    # 5 x 799
    assert ws.sales_summary()["total_revenue"] == 3995.0


def test_a_row_with_no_price_falls_back_to_the_products_catalog_price():
    """The same fallback the forecaster documents and applies."""

    ws = _workspace(unit_price=799.0)
    ws.upsert_sales_rows([{"product_id": "P001", "date": "2026-09-01", "units_sold": 5}])

    row = ws.list_sales()["rows"][0]

    assert row["price"] is None, "the sales row's own value is still reported as absent"
    assert row["unit_price"] == 799.0
    assert ws.sales_summary()["total_revenue"] == 3995.0


def test_a_priceless_row_and_a_priceless_product_stay_absent_rather_than_zero():
    """No price anywhere is missing information, not a free sale."""

    ws = _workspace(unit_price=0.0)
    ws.upsert_sales_rows([{"product_id": "P001", "date": "2026-09-01", "units_sold": 5}])

    row = ws.list_sales()["rows"][0]

    assert row["unit_price"] is None
    summary = ws.sales_summary()
    assert summary["total_revenue"] == 0.0
    # The units are still counted, and the gap is disclosed rather than hidden.
    assert summary["total_units"] == 5
    assert summary["priced_records"] == 0


def test_zero_units_are_worth_zero_rather_than_absent():
    ws = _workspace(unit_price=799.0)
    ws.upsert_sales_rows([{"product_id": "P001", "date": "2026-09-01", "units_sold": 0, "price": 799.0}])

    row = ws.list_sales()["rows"][0]
    summary = ws.sales_summary()

    assert row["unit_price"] == 799.0
    assert summary["total_revenue"] == 0.0
    assert summary["priced_records"] == 1, "a priced zero-unit row is still a priced record"


def test_several_records_add_up_to_the_summary_total():
    ws = _workspace(unit_price=100.0)
    ws.upsert_sales_rows([
        {"product_id": "P001", "date": "2026-09-01", "units_sold": 5, "price": 799.0},
        {"product_id": "P001", "date": "2026-09-02", "units_sold": 2},
        {"product_id": "P001", "date": "2026-09-03", "units_sold": 3, "price": 250.0},
    ])

    rows = ws.list_sales()["rows"]
    summary = ws.sales_summary()

    assert [row["unit_price"] for row in rows] == [250.0, 100.0, 799.0]
    assert sum(row["units_sold"] * row["unit_price"] for row in rows) == summary["total_revenue"]
    # 3 x 250, plus 2 x 100 (the catalog fallback), plus 5 x 799.
    assert summary["total_revenue"] == 750.0 + 200.0 + 3995.0
    assert summary["priced_records"] == 3
    assert summary["total_records"] == 3


def test_the_table_and_the_summary_can_neither_agree_nor_disagree():
    """The same rule, once: whatever the rows say, the total is their sum."""

    ws = _workspace(unit_price=640.0)
    ws.upsert_sales_rows([
        {"product_id": "P001", "date": "2026-09-01", "units_sold": 4},
        {"product_id": "P001", "date": "2026-09-02", "units_sold": 1, "price": 10.0},
    ])

    rows = ws.list_sales(limit=50)["rows"]
    from_rows = sum(
        row["units_sold"] * row["unit_price"] for row in rows if row["unit_price"] is not None
    )

    assert from_rows == ws.sales_summary()["total_revenue"] == 2570.0


def test_another_products_price_is_not_used():
    """The fallback is that product's own catalog price, not a portfolio average."""

    ws = _workspace(unit_price=799.0)
    ws.add_products([{
        "product_id": "P002",
        "product_name": "Other",
        "category": "Home",
        "current_stock": 5,
        "unit_price": 42.0,
    }])
    ws.upsert_sales_rows([{"product_id": "P002", "date": "2026-09-01", "units_sold": 2}])

    assert ws.list_sales()["rows"][0]["unit_price"] == 42.0


def test_the_api_serves_the_effective_price_to_the_browser():
    _token_user = "price-user"
    headers = {"Authorization": f"Bearer {_token(_token_user)}"}

    def _ingest(record_type, rows):
        return client.post(
            "/api/v2/ingest",
            json={"user_id": _token_user, "record_type": record_type, "rows": rows},
            headers=headers,
        )

    assert _ingest("product", [{
        "product_id": "P001",
        "product_name": "Widget",
        "category": "Electronics",
        "current_stock": 10,
        "lead_time_days": 4,
        "unit_price": 799.0,
    }]).status_code == 200
    assert _ingest("sales", [{"product_id": "P001", "date": "2026-09-01", "units_sold": 5}]).status_code == 200

    records = client.get("/api/v2/sales?user_id=price-user", headers=headers)
    summary = client.get("/api/v2/sales/summary?user_id=price-user", headers=headers)

    assert records.status_code == 200
    row = records.json()["rows"][0]
    assert row["unit_price"] == 799.0
    assert row["price"] is None
    assert summary.status_code == 200
    assert summary.json()["total_revenue"] == 3995.0
    assert summary.json()["priced_records"] == 1
