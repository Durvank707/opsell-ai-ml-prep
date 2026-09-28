"""V1 replenishment policy: demand forecasting and order sizing are separate.

The Forecast page keeps reporting the next 30 days of expected demand. That
30-day outlook must NOT become the automatic order quantity: the recommended
order is sized from the expected demand over the supplier *lead time* plus
safety stock, and brings the inventory position back toward the reorder point
(target level) rather than toward the whole 30-day forecast.

These tests pin the V1 behavior and guard against reintroducing the old
"order the 30-day forecast" rule.
"""

import base64
import hashlib
import hmac
import json
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.schemas import ForecastRequest
from backend.services import EcomAIService

# Mirrors the hermetic HS256 baseline in tests/conftest.py.
SECRET = "test-only-not-a-real-secret-" + "0" * 32
client = TestClient(app)


def _b64(value: dict) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()


def _token(subject: str = "test-user-1") -> str:
    now = time.time()
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": subject, "iat": now, "exp": now + 3600})
    sig = hmac.new(
        SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256
    ).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


HEADERS = {"Authorization": f"Bearer {_token()}"}


def _service() -> EcomAIService:
    # The V1 service is a singleton shared with the FastAPI app, so patching
    # its inventory_df below is visible to the HTTP endpoints as well.
    return EcomAIService()


def _monthly_forecast(svc: EcomAIService, product_id: str):
    return svc.generate_demand_forecast(
        ForecastRequest(product_id=product_id, horizon=30)
    )


def _patch_inventory(monkeypatch, svc, product_id, *, current_stock, open_order_qty=0):
    df = svc.inventory_df.copy()
    idx = df.index[df["product_id"] == product_id][0]
    df.loc[idx, "current_stock"] = current_stock
    df.loc[idx, "open_order_qty"] = open_order_qty
    monkeypatch.setattr(svc, "inventory_df", df)


# ---------------------------------------------------------------------------
# 1. The 30-day demand forecast itself is unchanged.
# ---------------------------------------------------------------------------


def test_30day_demand_forecast_stays_unchanged():
    svc = _service()
    forecast = _monthly_forecast(svc, "P001")

    assert forecast.horizon == 30
    assert len(forecast.forecast_points) == 30
    total = sum(p.forecast_units for p in forecast.forecast_points)
    assert forecast.total_forecast_units == pytest.approx(total, abs=0.21)
    assert forecast.avg_daily_demand == pytest.approx(total / 30, abs=0.11)

    # Deterministic: the same inputs produce the same 30-day outlook.
    twice = _monthly_forecast(svc, "P001")
    assert [p.forecast_units for p in twice.forecast_points] == [
        p.forecast_units for p in forecast.forecast_points
    ]


# ---------------------------------------------------------------------------
# 2. Replenishment uses lead-time demand rather than the 30-day total.
# ---------------------------------------------------------------------------


def test_v1_reorder_target_is_lead_time_demand_plus_safety():
    """End-to-end through the V1 API: the order-up-to target is LTD + SS.

    This holds whether or not the product currently needs a reorder, so the
    response for a real product proves the horizon is lead time, not 30 days.
    """
    reorder = client.get("/api/inventory/reorder/P001", headers=HEADERS).json()
    forecast = client.post(
        "/api/forecast",
        json={"product_id": "P001", "horizon": 30},
        headers=HEADERS,
    ).json()

    assert forecast["horizon"] == 30
    assert len(forecast["forecast_points"]) == 30
    assert reorder["target_inventory"] == pytest.approx(
        reorder["lead_time_demand"] + reorder["safety_stock"], abs=0.21
    )
    # The target sits strictly below the 30-day outlook + safety stock.
    assert reorder["target_inventory"] < (
        forecast["total_forecast_units"] + reorder["safety_stock"]
    )


def test_recommended_order_is_lead_time_scoped_not_the_30day_total(monkeypatch):
    svc = _service()
    monthly = _monthly_forecast(svc, "P001")
    monthly_total = float(monthly.total_forecast_units)
    safety = svc.get_product_metadata("P001")["safety_stock"]
    assert monthly_total > 0

    # Force a stock-out sized reorder for P001 (lead time 4 days).
    _patch_inventory(monkeypatch, svc, "P001", current_stock=5, open_order_qty=0)
    rec = svc.get_reorder_recommendation("P001")

    assert rec.reorder_required is True
    assert rec.recommended_order_qty > 0
    # Target level = expected demand over the lead time + safety stock ...
    assert rec.target_inventory == pytest.approx(
        rec.lead_time_demand + rec.safety_stock, abs=0.21
    )
    # ... and the order brings the position back up to that target.
    assert abs(
        rec.recommended_order_qty - (rec.target_inventory - rec.inventory_position)
    ) <= 1
    # The order is a fraction of the 30-day demand, not the 30-day demand itself.
    assert rec.recommended_order_qty < monthly_total
    assert rec.recommended_order_qty < (
        monthly_total + safety
    ) - rec.inventory_position


# ---------------------------------------------------------------------------
# 3. Current stock and open orders affect the recommended quantity.
# ---------------------------------------------------------------------------


def test_open_orders_and_stock_drive_the_recommended_quantity(monkeypatch):
    svc = _service()

    _patch_inventory(monkeypatch, svc, "P001", current_stock=5, open_order_qty=0)
    no_pipeline = svc.get_reorder_recommendation("P001")
    assert no_pipeline.reorder_required is True
    assert no_pipeline.recommended_order_qty > 0

    # An inbound open order covers part of the deficit 1:1.
    _patch_inventory(monkeypatch, svc, "P001", current_stock=5, open_order_qty=30)
    with_pipeline = svc.get_reorder_recommendation("P001")
    assert with_pipeline.inventory_position == 35
    assert with_pipeline.recommended_order_qty == (
        no_pipeline.recommended_order_qty - 30
    )
    assert with_pipeline.recommended_order_qty > 0

    # A fully covered pipeline means no reorder at all.
    _patch_inventory(monkeypatch, svc, "P001", current_stock=5, open_order_qty=10_000)
    covered = svc.get_reorder_recommendation("P001")
    assert covered.inventory_position == 10_005
    assert covered.reorder_required is False
    assert covered.recommended_order_qty == 0


# ---------------------------------------------------------------------------
# 4. High demand + sufficient inventory -> no automatic 30-day order.
# ---------------------------------------------------------------------------


def test_high_demand_with_sufficient_stock_gets_no_30day_order(monkeypatch):
    svc = _service()
    # The product with the highest historical average daily demand.
    hot = str(svc.sales_df.groupby("product_id")["units_sold"].mean().idxmax())
    monthly = _monthly_forecast(svc, hot)
    assert monthly.total_forecast_units > 100  # genuinely high demand

    meta = svc.get_product_metadata(hot)
    lead_time = meta["lead_time_days"]
    approx_reorder_point = (
        sum(p.forecast_units for p in monthly.forecast_points[:lead_time])
        + meta["safety_stock"]
    )
    # Stock sits just above the reorder point — enough to cover lead-time demand.
    _patch_inventory(
        monkeypatch, svc, hot, current_stock=int(np.ceil(approx_reorder_point)) + 5
    )

    rec = svc.get_reorder_recommendation(hot)
    assert rec.reorder_required is False
    assert rec.recommended_order_qty == 0
    assert rec.target_inventory < monthly.total_forecast_units + rec.safety_stock