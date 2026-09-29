"""The product forecast endpoint's contract, as the product forecast page reads it.

The individual product forecast view was added on top of this endpoint rather
than beside it, so this file pins the response fields that view depends on:

* a product that has never sold is answered with a labeled cold-start payload —
  no points, ``cold_start`` eligibility and ``insufficient_history`` confidence —
  so the page can say so instead of reporting a trend;
* a product with real history keeps a real answer, with a trend calculated from
  its own demand and the model version that produced the numbers;
* a product outside the tenant is a 404 that reveals nothing about other tenants.

Nothing here changes the forecast: these are characterization tests for the
shape the endpoint already returns, and the fields the UI reads are asserted by
name so a change to any of them is caught here rather than in the browser.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import v2
from backend.tenant import TenantWorkspace

SECRET = "test-" + secrets.token_urlsafe(48)
client = TestClient(app)

START = date(2026, 1, 1)
# The endpoint only ever returns the trailing 60 days of actuals; the product
# forecast page reads the day count out of that window.
ACTUALS_WINDOW = 60


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
        json.dumps(value, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()


def _token(subject: str) -> str:
    now = time.time()
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": subject, "iat": now, "exp": now + 3600})
    sig = hmac.new(
        SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256
    ).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


def _seed(user: str, *, days: int = 200, new_product: bool = True) -> TenantWorkspace:
    """A tenant with one product that sells and, by default, one that never has."""
    ws = TenantWorkspace(user)
    products = [
        {
            "product_id": "P1",
            "product_name": "Wireless Headphones",
            "category": "Electronics",
            "current_stock": 225,
            "lead_time_days": 4,
            "unit_cost": 1000.0,
            "unit_price": 1999.0,
        },
    ]
    if new_product:
        products.append({
            "product_id": "P006",
            "product_name": "Smart Fitness Band",
            "category": "Wearables",
            "current_stock": 120,
            "lead_time_days": 5,
            "unit_cost": 900.0,
            "unit_price": 2499.0,
        })
    ws.add_products(products)
    if days:
        # A rising series, so the reported trend is a real one rather than the
        # "stable" an empty history produces.
        ws.upsert_sales_rows([
            {
                "product_id": "P1",
                "date": (START + timedelta(days=index)).isoformat(),
                "units_sold": 5 + index // 10,
                "price": 1999.0,
                "category": "Electronics",
                "promotion": 0,
                "channel": "Online Store",
            }
            for index in range(days)
        ])
    v2._WORKSPACES[user] = ws
    ws.remote_hydrated = True
    return ws


def _forecast(product_id: str, user: str = "forecast-user"):
    separator = "&" if "?" in product_id else "?"
    return client.get(
        f"/api/v2/forecast/{product_id}{separator}user_id={user}",
        headers={"Authorization": f"Bearer {_token(user)}"},
    )


def test_a_product_with_no_sales_history_is_answered_not_refused():
    """A new product gets a 200 with a labeled cold-start payload.

    Refusing the request would leave the page with nothing to explain, and a
    zero-filled payload without the eligibility decision would leave the reader
    with a forecast that is indistinguishable from a real one.
    """
    _seed("forecast-user")
    response = _forecast("P006")
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["product_id"] == "P006"
    assert body["product_name"] == "Smart Fitness Band"
    assert body["points"] == []
    assert body["actuals"] == []
    assert body["total"] == 0
    assert body["peak_date"] is None
    assert body["peak_units"] is None


def test_a_product_with_no_history_is_labeled_cold_start():
    """The decision the page reads instead of guessing at history.

    ``confidence_label`` and ``tier`` are what let the UI say "no sales
    history" rather than report the ``trend`` the API still returns for an
    empty series.
    """
    _seed("forecast-user")
    body = _forecast("P006").json()

    eligibility = body["eligibility"]
    assert eligibility["eligible"] is False
    assert eligibility["tier"] == "cold_start"
    assert eligibility["tier_label"] == "Cold start"
    assert eligibility["confidence_label"] == "insufficient_history"
    assert eligibility["description"]
    assert body["warning"]
    # No model ran, so no model is named.
    assert body["fallback_used"] == "baseline"
    assert body["model_version"] is None


def test_a_product_with_history_reports_a_real_trend_and_its_model():
    _seed("forecast-user")
    body = _forecast("P1").json()

    assert len(body["points"]) == 30
    assert body["eligibility"]["eligible"] is True
    assert body["eligibility"]["confidence_label"] != "insufficient_history"
    assert body["fallback_used"] == "ml"
    assert body["model_version"]
    # A rising series, so this is a trend read off demand rather than a default.
    assert body["trend"] == "increasing"
    assert body["growth_pct"] > 2
    assert body["total"] == round(sum(p["forecast"] for p in body["points"]), 2)


def test_history_days_are_readable_from_the_actuals_window():
    """The response carries the trailing window, not a total day count.

    The product forecast page therefore reports "60+ days" for a product with
    years of history; this is the assertion that keeps the two in step.
    """
    _seed("forecast-user", days=200)
    body = _forecast("P1").json()

    assert 0 < len(body["actuals"]) <= ACTUALS_WINDOW
    assert all({"date", "units"} <= set(point) for point in body["actuals"])


def test_a_product_outside_the_tenant_is_a_404_that_says_nothing_else():
    """Another tenant's catalog is not this tenant's to forecast.

    The other tenant has a product of its own, so the refusal cannot be a
    side-effect of an empty workspace.
    """
    _seed("forecast-user")
    _seed("someone-else", days=0, new_product=False)

    response = _forecast("P006", user="someone-else")
    assert response.status_code == 404, response.text
    detail = response.json()["detail"]
    assert "P006" in detail
    # The other tenant's product name must not travel with the refusal.
    assert "Smart Fitness Band" not in detail


def test_an_unknown_product_id_is_refused_rather_than_forecast_as_zero():
    _seed("forecast-user")
    response = _forecast("P999")

    assert response.status_code == 404, response.text
    assert "P999" in response.json()["detail"]


def test_the_horizon_is_honoured_for_a_product_with_no_history():
    _seed("forecast-user")
    body = _forecast("P006?horizon=7").json()

    assert body["horizon"] == 7
    assert body["points"] == []
