"""Tests for the tenant read/write surface the frontend UI depends on.

Two groups of routes live here. The catalog and sales routes are what the app
cannot render anything without. The intelligence routes (forecast, inventory,
recommendations, simulation) are the read paths behind the forecasting,
inventory, recommendations and simulation pages.

The recurring theme is honesty: a read never records a decision, a fallback is
always labelled as one, and a tenant only ever sees its own rows.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from datetime import date, timedelta
from urllib.error import URLError

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import v2
from backend.tenant import TenantWorkspace


SECRET = "test-" + secrets.token_urlsafe(48)
client = TestClient(app)

PRODUCT = {
    "product_id": "P1",
    "product_name": "Widget",
    "category": "Electronics",
    "current_stock": 10,
    "lead_time_days": 4,
    "unit_cost": 3.5,
}


def _b64(value: dict) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()


def _token(subject: str) -> str:
    now = time.time()
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": subject, "iat": now, "exp": now + 3600})
    sig = hmac.new(SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setattr(v2, "_WORKSPACES", {})


def _get(path, *, user="ui-user", params=None):
    query = {"user_id": user}
    query.update(params or {})
    return client.get(path, params=query, headers={"Authorization": f"Bearer {_token(user)}"})


def _patch(path, body, *, user="ui-user"):
    return client.patch(
        f"{path}?user_id={user}", json=body,
        headers={"Authorization": f"Bearer {_token(user)}"},
    )


def _delete(path, *, user="ui-user"):
    return client.delete(
        f"{path}?user_id={user}", headers={"Authorization": f"Bearer {_token(user)}"}
    )


def _post(path, body, *, user="ui-user"):
    return client.post(
        f"{path}?user_id={user}", json=body,
        headers={"Authorization": f"Bearer {_token(user)}"},
    )


def _seed(user="ui-user"):
    ws = TenantWorkspace(user)
    ws.add_product(PRODUCT)
    ws.upsert_sales_rows([
        {"product_id": "P1", "date": f"2025-05-{d:02d}", "units_sold": d, "price": 10.0}
        for d in range(1, 6)
    ])
    v2._WORKSPACES[user] = ws
    ws.remote_hydrated = True
    return ws


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------


def test_product_list_is_empty_for_a_new_tenant():
    response = _get("/api/v2/products")
    assert response.status_code == 200
    assert response.json()["products"] == []


def test_product_list_returns_catalog_fields_and_derived_metrics():
    _seed()
    response = _get("/api/v2/products")
    assert response.status_code == 200
    (row,) = response.json()["products"]
    assert row["product_id"] == "P1"
    assert row["product_name"] == "Widget"
    assert row["current_stock"] == 10
    assert row["inventory_position"] == 10
    # Derived from the 5 seeded sales rows.
    assert row["history_days"] == 5
    assert row["daily_avg"] == 3.0
    assert row["stockout_risk"] in {"LOW", "MEDIUM", "HIGH"}
    assert "eligibility" in row


def test_product_list_requires_auth():
    assert client.get("/api/v2/products", params={"user_id": "x"}).status_code == 401


def test_product_list_rejects_a_foreign_tenant():
    assert _get("/api/v2/products", user="a", params={"user_id": "b"}).status_code == 403


def test_reading_a_product_needs_a_user_id():
    assert client.get(
        "/api/v2/products/P1", headers={"Authorization": f"Bearer {_token('ui-user')}"}
    ).status_code == 422


def test_get_product_returns_metrics():
    _seed()
    response = _get("/api/v2/products/P1")
    assert response.status_code == 200
    assert response.json()["product_id"] == "P1"


def test_get_unknown_product_is_404():
    _seed()
    assert _get("/api/v2/products/NOPE").status_code == 404


def test_patch_updates_only_the_supplied_fields():
    _seed()
    response = _patch("/api/v2/products/P1", {"current_stock": 42})
    assert response.status_code == 200
    ws = v2._WORKSPACES["ui-user"]
    updated = ws.products["P1"]
    assert updated.current_stock == 42
    # Everything not mentioned is preserved.
    assert updated.product_name == "Widget"
    assert updated.lead_time_days == 4
    assert updated.unit_cost == 3.5


def test_patch_persists_safety_stock_and_metrics_honour_it():
    _seed()
    assert _patch("/api/v2/products/P1", {"safety_stock": 25}).status_code == 200
    ws = v2._WORKSPACES["ui-user"]
    assert ws.products["P1"].safety_stock == 25
    # A tenant-set safety stock is authoritative, not overwritten by the derived one.
    assert _get("/api/v2/products/P1").json()["safety_stock"] == 25


def test_patch_rejects_a_negative_value():
    _seed()
    assert _patch("/api/v2/products/P1", {"current_stock": -1}).status_code == 422
    assert v2._WORKSPACES["ui-user"].products["P1"].current_stock == 10


def test_patch_unknown_product_is_404():
    _seed()
    assert _patch("/api/v2/products/NOPE", {"current_stock": 1}).status_code == 404


def test_patch_records_an_audit_entry():
    _seed()
    _patch("/api/v2/products/P1", {"current_stock": 3})
    ws = v2._WORKSPACES["ui-user"]
    assert any(e.action == "product_upserted" for e in ws.audit)


def test_delete_removes_the_product_and_its_sales():
    _seed()
    ws = v2._WORKSPACES["ui-user"]
    assert len(ws.sales_records) == 5
    response = _delete("/api/v2/products/P1")
    assert response.status_code == 200
    assert response.json()["sales_rows_removed"] == 5
    assert ws.products == {}
    assert ws.sales_records == {}
    assert any(e.action == "product_deleted" for e in ws.audit)


def test_delete_unknown_product_is_404():
    _seed()
    assert _delete("/api/v2/products/NOPE").status_code == 404


def test_listing_products_does_not_write_audit_entries():
    ws = _seed()
    before = len(ws.audit)
    for _ in range(3):
        _get("/api/v2/products")
    assert len(ws.audit) == before, "rendering a list is not a decision"


# ---------------------------------------------------------------------------
# Sales
# ---------------------------------------------------------------------------


def test_sales_list_is_paginated_and_newest_first():
    _seed()
    response = _get("/api/v2/sales", params={"limit": 2})
    body = response.json()
    assert response.status_code == 200
    assert body["total"] == 5
    assert len(body["rows"]) == 2
    assert body["rows"][0]["date"] == "2025-05-05"
    assert body["rows"][0]["product_name"] == "Widget"


def test_sales_list_offset_pages_without_repeating():
    _seed()
    first = _get("/api/v2/sales", params={"limit": 2, "offset": 0}).json()["rows"]
    second = _get("/api/v2/sales", params={"limit": 2, "offset": 2}).json()["rows"]
    assert {r["date"] for r in first}.isdisjoint({r["date"] for r in second})


def test_sales_list_filters_by_product_and_date():
    _seed()
    assert _get("/api/v2/sales", params={"product_id": "P1"}).json()["total"] == 5
    assert _get("/api/v2/sales", params={"product_id": "NOPE"}).status_code == 404
    assert _get(
        "/api/v2/sales", params={"date_from": "2025-05-03"}
    ).json()["total"] == 3
    assert _get(
        "/api/v2/sales", params={"date_to": "2025-05-02"}
    ).json()["total"] == 2


def test_sales_list_search_matches_product_and_category():
    _seed()
    assert _get("/api/v2/sales", params={"search": "P1"}).json()["total"] == 5
    assert _get("/api/v2/sales", params={"search": "nothing"}).json()["total"] == 0


def test_sales_list_for_another_tenants_product_is_404():
    _seed()
    other = TenantWorkspace("other-user")
    other.add_product({**PRODUCT, "product_id": "PZ"})
    v2._WORKSPACES["other-user"] = other
    assert _get("/api/v2/sales", params={"product_id": "PZ"}).status_code == 404


def test_sales_summary_totals():
    _seed()
    body = _get("/api/v2/sales/summary").json()
    assert body["total_records"] == 5
    assert body["total_units"] == 15
    assert body["total_revenue"] == 150.0
    assert body["products_covered"] == 1
    assert body["date_from"] == "2025-05-01"
    assert body["date_to"] == "2025-05-05"


def test_sales_summary_is_empty_not_an_error_for_a_new_tenant():
    body = _get("/api/v2/sales/summary").json()
    assert body["total_records"] == 0
    assert body["date_from"] is None


# ---------------------------------------------------------------------------
# Supabase enabled
# ---------------------------------------------------------------------------


class _Response:
    def __init__(self, payload=None):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self):
        return b"" if self.payload is None else json.dumps(self.payload).encode()


class _Recorder:
    def __init__(self, *, fail_on=None):
        self.requests = []
        self.fail_on = fail_on

    def __call__(self, request, timeout):
        self.requests.append(request)
        table = request.full_url.split("/rest/v1/")[1].split("?")[0]
        if table == self.fail_on:
            raise URLError("connection refused")
        return _Response() if request.method == "POST" else _Response([])

    def calls(self, method, table):
        return [
            r for r in self.requests
            if r.method == method
            and r.full_url.split("/rest/v1/")[1].split("?")[0] == table
        ]


def _enable_supabase(monkeypatch):
    monkeypatch.setenv("USE_SUPABASE", "true")
    monkeypatch.setenv("SUPABASE_URL", "https://mock-project.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")


def test_update_persists_to_supabase(monkeypatch):
    # Seed first, with persistence off, so the only recorded remote call is
    # the update under test.
    _seed()
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    assert _patch("/api/v2/products/P1", {"current_stock": 77}).status_code == 200
    writes = recorder.calls("POST", "products")
    assert len(writes) == 1
    body = json.loads(writes[0].data.decode())
    assert body[0]["current_stock"] == 77
    assert body[0]["user_id"] == "ui-user"


def test_delete_persists_to_supabase_and_is_tenant_scoped(monkeypatch):
    _seed()
    _enable_supabase(monkeypatch)
    recorder = _Recorder()
    monkeypatch.setattr("backend.supabase._urlopen", recorder)

    assert _delete("/api/v2/products/P1").status_code == 200
    deletes = [r for r in recorder.requests if r.method == "DELETE"]
    tables = sorted(r.full_url.split("/rest/v1/")[1].split("?")[0] for r in deletes)
    assert tables == ["products", "sales"]
    for request in deletes:
        # The scope filter must name this tenant and this product, never a
        # blanket delete.
        assert "user_id=eq.ui-user" in request.full_url
        assert "product_id=eq.P1" in request.full_url


def test_failed_delete_surfaces_and_keeps_the_local_product(monkeypatch):
    ws = _seed()
    _enable_supabase(monkeypatch)
    monkeypatch.setattr("backend.supabase._urlopen", _Recorder(fail_on="products"))

    assert _delete("/api/v2/products/P1").status_code == 503
    assert "P1" in ws.products, "a failed remote delete must not drop the local row"
    assert ws.sales_records, "a failed remote delete must not drop sales"


# ---------------------------------------------------------------------------
# Intelligence routes: forecast, inventory, recommendations, simulation
# ---------------------------------------------------------------------------

START = date(2025, 1, 1)

INTELLIGENCE_ROUTES = [
    ("get", "/api/v2/forecast/portfolio"),
    ("get", "/api/v2/forecast/P1"),
    ("get", "/api/v2/inventory/overview"),
    ("get", "/api/v2/inventory/reorder/P1"),
    ("get", "/api/v2/inventory/timeline/P1"),
    ("get", "/api/v2/recommendations"),
]


def _seed_history(user="intel-user", *, days=200):
    """A tenant with enough history for the eligibility gate to allow ML."""
    ws = TenantWorkspace(user)
    ws.add_products([
        {**PRODUCT, "current_stock": 10},
        {**PRODUCT, "product_id": "P2", "product_name": "Gadget",
         "category": "Home", "current_stock": 100_000, "unit_price": 5.0},
    ])
    ws.upsert_sales_rows([
        {
            "product_id": pid,
            "date": (START + timedelta(days=index)).isoformat(),
            "units_sold": 5 + (index % 7),
            "price": 12.0,
        }
        for index in range(days)
        for pid in ("P1", "P2")
    ])
    v2._WORKSPACES[user] = ws
    ws.remote_hydrated = True
    return ws


def _intel(method, path, *, user="intel-user"):
    separator = "&" if "?" in path else "?"
    return getattr(client, method)(
        f"{path}{separator}user_id={user}",
        headers={"Authorization": f"Bearer {_token(user)}"},
    )


@pytest.mark.parametrize("method,path", INTELLIGENCE_ROUTES)
def test_every_intelligence_route_requires_auth(method, path):
    assert getattr(client, method)(f"{path}?user_id=intel-user").status_code == 401


@pytest.mark.parametrize("method,path", INTELLIGENCE_ROUTES)
def test_every_intelligence_route_rejects_a_foreign_tenant(method, path):
    response = client.get(
        f"{path}?user_id=somebody-else",
        headers={"Authorization": f"Bearer {_token('intel-user')}"},
    )
    assert response.status_code == 403


@pytest.mark.parametrize("method,path,expected", [
    ("get", "/api/v2/forecast/portfolio", 200),
    ("get", "/api/v2/inventory/overview", 200),
    ("get", "/api/v2/recommendations", 200),
    # A product that does not exist is a 404, not an empty success.
    ("get", "/api/v2/forecast/P1", 404),
    ("get", "/api/v2/inventory/reorder/P1", 404),
    ("get", "/api/v2/inventory/timeline/P1", 404),
])
def test_every_intelligence_route_serves_a_tenant_with_no_data(
    method, path, expected
):
    """A brand-new account must get an honest answer, never a fake empty page."""
    response = _intel(method, path, user="brand-new")
    assert response.status_code == expected, response.text


def test_product_forecast_route_returns_a_labelled_model_forecast():
    _seed_history()
    body = _intel("get", "/api/v2/forecast/P1", user="intel-user").json()
    assert body["product_id"] == "P1"
    assert body["fallback_used"] == "ml"
    assert body["model_version"] == "xgboost-v1.0.0"
    assert body["eligibility"]["eligible"] is True
    assert len(body["points"]) == 30
    for point in body["points"]:
        assert point["lower"] <= point["forecast"] <= point["upper"]


def test_product_forecast_route_honours_the_horizon():
    _seed_history()
    response = _intel(
        "get", "/api/v2/forecast/P1?horizon=7", user="intel-user"
    )
    assert len(response.json()["points"]) == 7


def test_product_forecast_route_rejects_an_out_of_range_horizon():
    _seed_history()
    assert _intel("get", "/api/v2/forecast/P1?horizon=0",
                  user="intel-user").status_code == 422
    assert _intel("get", "/api/v2/forecast/P1?horizon=5000",
                  user="intel-user").status_code == 422


def test_portfolio_forecast_route_aggregates_the_catalog():
    _seed_history()
    body = _intel("get", "/api/v2/forecast/portfolio", user="intel-user").json()
    assert body["products_in_scope"] == 2
    assert len(body["points"]) == 30
    assert {r["product_id"] for r in body["rows"]} == {"P1", "P2"}
    assert body["total"] == round(sum(r["forecast_total"] for r in body["rows"]), 2)


def test_portfolio_forecast_route_is_not_shadowed_by_the_product_route():
    """/forecast/portfolio must not be parsed as product_id="portfolio"."""
    _seed_history()
    assert _intel("get", "/api/v2/forecast/portfolio",
                  user="intel-user").status_code == 200


def test_inventory_overview_route_shape():
    _seed_history()
    body = _intel("get", "/api/v2/inventory/overview", user="intel-user").json()
    assert body["user_id"] == "intel-user"
    assert body["kpis"]["total_products"] == 2
    assert body["health"]["total"] == 2
    assert {c["category"] for c in body["categories"]} == {"Electronics", "Home"}


def test_reorder_route_applies_supplier_batching():
    _seed_history()
    plain = _intel("get", "/api/v2/inventory/reorder/P1", user="intel-user").json()
    assert plain["reorder_required"] is True
    assert plain["recommended_order_qty"] > 0

    batched = _intel(
        "get", "/api/v2/inventory/reorder/P1?moq=500&pack_size=25", user="intel-user"
    ).json()
    assert batched["recommended_order_qty"] >= 500
    assert batched["recommended_order_qty"] % 25 == 0


def test_timeline_route_projects_both_paths():
    _seed_history()
    body = _intel("get", "/api/v2/inventory/timeline/P1?days=30",
                  user="intel-user").json()
    assert body["product_id"] == "P1"
    assert body["points"]
    assert body["reorder_placed_on"] is not None
    assert body["points"][-1]["stock"] > 0


def test_recommendations_route_returns_ranked_actions():
    _seed_history()
    body = _intel("get", "/api/v2/recommendations", user="intel-user").json()
    assert body["counts"]["all"] == 2
    order = {"critical": 0, "reorder": 1, "monitor": 2, "no_action": 3}
    types = [r["type"] for r in body["items"]]
    assert types == sorted(types, key=lambda t: order[t])
    for item in body["items"]:
        assert item["title"] and item["reason"] and item["action_label"]


def test_recommendations_route_refuses_an_unknown_category():
    """An unmatched filter must not read as "nothing needs attention"."""
    _seed_history()
    response = _intel("get", "/api/v2/recommendations?category=Nonexistent",
                      user="intel-user")
    assert response.status_code == 422


def test_backtest_route_compares_the_model_against_a_baseline():
    _seed_history()
    response = _post("/api/v2/simulation/backtest", {"product_id": "P1"},
                     user="intel-user")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["product_id"] == "P1"
    assert body["duration_days"] > 0
    assert len(body["daily_trajectory"]) == body["duration_days"]
    assert "total_inventory_cost" in body["xgb_metrics"]
    assert "total_inventory_cost" in body["baseline_metrics"]
    assert body["cost_comparison"]["recommended_strategy"] in {"xgboost", "baseline"}


def test_backtest_route_refuses_another_tenants_product():
    _seed_history()
    other = TenantWorkspace("other-intel")
    other.add_product({**PRODUCT, "product_id": "THEIRS"})
    v2._WORKSPACES["other-intel"] = other

    response = _post("/api/v2/simulation/backtest", {"product_id": "THEIRS"},
                     user="intel-user")
    assert response.status_code == 404


def test_backtest_route_rejects_a_reversed_date_range():
    _seed_history()
    response = _post("/api/v2/simulation/backtest", {
        "product_id": "P1", "start_date": "2025-07-19", "end_date": "2025-01-01",
    }, user="intel-user")
    assert response.status_code == 422


def test_backtest_route_records_exactly_one_audit_entry():
    ws = _seed_history()
    before = len(ws.audit)
    assert _post("/api/v2/simulation/backtest", {"product_id": "P1"},
                 user="intel-user").status_code == 200
    assert [e.action for e in ws.audit[before:]] == ["simulation_backtested"]


@pytest.mark.parametrize("method,path", INTELLIGENCE_ROUTES)
def test_reading_the_intelligence_surface_records_no_decisions(method, path):
    """Rendering a page is not a decision: it must not write the audit trail."""
    ws = _seed_history()
    before = len(ws.audit)
    for _ in range(3):
        assert _intel(method, path, user="intel-user").status_code == 200
    assert len(ws.audit) == before


def test_an_unexpected_failure_is_reported_as_a_bug_not_an_outage(monkeypatch):
    """A 503 must mean Supabase, never "something in our code broke"."""
    _seed_history()

    def boom(*_a, **_k):
        raise TypeError("a genuine bug in the backtest path")

    monkeypatch.setattr(TenantWorkspace, "backtest", boom)
    response = _post("/api/v2/simulation/backtest", {"product_id": "P1"},
                     user="intel-user")
    assert response.status_code == 500
    assert "Supabase" not in response.json()["detail"]


def test_a_persistence_failure_is_still_reported_as_503(monkeypatch):
    ws = _seed_history()
    _enable_supabase(monkeypatch)

    def persist(*_a, **_k):
        from backend.supabase import SupabasePersistenceError

        raise SupabasePersistenceError("Supabase could not be reached.")

    monkeypatch.setattr(
        TenantWorkspace, "reorder_recommendation", persist
    )
    assert _intel("get", "/api/v2/inventory/reorder/P1",
                  user="intel-user").status_code == 503
    assert "P1" in ws.products
