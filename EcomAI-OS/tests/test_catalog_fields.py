"""Tests for the product catalog fields the UI form writes.

The product form collects a selling price, a supplier and a description. All
three are canonical ``PRODUCT_RECORD`` fields and all three are persisted, which
is the point of these tests: a value the API accepted must survive a restart, and
``unit_price`` in particular is the price a sales row falls back to when it
carries none, so a lost one quietly feeds the forecaster a zero.

The demo seed overlay is covered here too, because without it a seeded tenant
starts with zero stock on every product and every product reads as critically
short.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import hmac
import json
import secrets
import time

import pytest
from fastapi.testclient import TestClient

from backend.config import RAW_INVENTORY_CSV, RAW_SALES_CSV
from backend.contracts import PRODUCT_RECORD
from backend.main import app
from backend.routers import v2
from backend.tenant import (
    TenantWorkspace,
    _seed_product_budget,
    apply_inventory_snapshot,
    seed_canonical_demo,
)

SECRET = "test-" + secrets.token_urlsafe(48)
client = TestClient(app)


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


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setattr(v2, "_WORKSPACES", {})


def _seed(user="catalog-user"):
    ws = TenantWorkspace(user)
    ws.add_product({
        "product_id": "P1",
        "product_name": "Widget",
        "category": "Electronics",
        "current_stock": 10,
        "lead_time_days": 4,
        "unit_cost": 3.5,
    })
    v2._WORKSPACES[user] = ws
    return ws


def _get(path, *, user="catalog-user", params=None):
    query = {"user_id": user}
    query.update(params or {})
    return client.get(
        path, params=query, headers={"Authorization": f"Bearer {_token(user)}"}
    )


def _patch(path, body, *, user="catalog-user"):
    return client.patch(
        f"{path}?user_id={user}",
        json=body,
        headers={"Authorization": f"Bearer {_token(user)}"},
    )


def _post(path, body, *, user="catalog-user"):
    """POST as ``user``, with the body's own ``user_id`` set to the token subject.

    The demo seed takes its tenant from the body rather than the query string,
    so the two have to agree unless a test is specifically checking that they
    do not.
    """

    return client.post(
        path, json={**body, "user_id": user},
        headers={"Authorization": f"Bearer {_token(user)}"},
    )


# ---------------------------------------------------------------------------
# The contract itself
# ---------------------------------------------------------------------------


def test_price_supplier_and_description_are_canonical_product_fields():
    names = {field.canonical_name for field in PRODUCT_RECORD.fields}
    assert {"unit_price", "supplier", "description"} <= names


def test_unit_cost_no_longer_claims_the_unit_price_alias():
    """A price column must map to the price field, not silently to the cost.

    ``unit_cost`` used to list ``unit_price`` as an alias, so a file with a
    ``unit_price`` column had it read as what the product *cost*. Now that
    ``unit_price`` is a field of its own the two cannot be confused.
    """

    cost = next(f for f in PRODUCT_RECORD.fields if f.canonical_name == "unit_cost")
    assert "unit_price" not in cost.aliases


def test_display_fields_are_ignored_by_ml_and_price_is_not():
    by_name = {f.canonical_name: f for f in PRODUCT_RECORD.fields}
    assert by_name["supplier"].ml_requirement == "IGNORED"
    assert by_name["description"].ml_requirement == "IGNORED"
    # The forecaster falls back to this when a sales row carries no price, so it
    # is a real input rather than decoration.
    assert by_name["unit_price"].ml_requirement == "USED"


# ---------------------------------------------------------------------------
# Round-tripping through the API
# ---------------------------------------------------------------------------


def test_persisting_a_product_keeps_its_price_supplier_and_description():
    ws = _seed()
    stored = ws.products["P1"]
    assert stored.unit_price == 0.0
    assert stored.supplier == ""
    assert stored.description == ""


def test_patch_writes_price_supplier_and_description():
    _seed()
    response = _patch(
        "/api/v2/products/P1",
        {
            "unit_price": 12.5,
            "supplier": "Acme Components",
            "description": "Blue widget, 40mm",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["unit_price"] == 12.5
    assert body["supplier"] == "Acme Components"
    assert body["description"] == "Blue widget, 40mm"
    assert body["unit_cost"] == 3.5


def test_product_read_exposes_the_display_fields():
    _seed()
    _patch(
        "/api/v2/products/P1",
        {"unit_price": 9.99, "supplier": "Acme", "description": "note"},
    )
    (row,) = _get("/api/v2/products").json()["products"]
    assert row["unit_price"] == 9.99
    assert row["supplier"] == "Acme"
    assert row["description"] == "note"


def test_a_supplier_longer_than_the_contract_allows_is_refused():
    _seed()
    response = _patch("/api/v2/products/P1", {"supplier": "x" * 500})
    assert response.status_code == 422


def test_a_negative_price_is_refused():
    _seed()
    assert _patch("/api/v2/products/P1", {"unit_price": -1}).status_code == 422


def test_ingest_carries_the_display_fields_into_a_new_catalog_row():
    response = _post(
        "/api/v2/ingest",
        {
            "user_id": "catalog-user",
            "record_type": "product",
            "rows": [
                {
                    "product_id": "P9",
                    "product_name": "Gadget",
                    "category": "Home",
                    "current_stock": 5,
                    "unit_price": 20.0,
                    "unit_cost": 8.0,
                    "supplier": "Globex",
                    "description": "small gadget",
                }
            ],
            "columns": [
                "product_id", "product_name", "category", "current_stock",
                "unit_price", "unit_cost", "supplier", "description",
            ],
        },
    )
    assert response.status_code == 200, response.text
    (row,) = _get("/api/v2/products").json()["products"]
    assert row["product_id"] == "P9"
    assert row["unit_price"] == 20.0
    assert row["supplier"] == "Globex"
    assert row["description"] == "small gadget"


def test_ingest_refuses_a_price_column_with_no_value():
    response = _post(
        "/api/v2/ingest",
        {
            "user_id": "catalog-user",
            "record_type": "product",
            "rows": [
                {
                    "product_id": "P9",
                    "product_name": "Gadget",
                    "current_stock": 5,
                    "unit_price": "not-a-price",
                }
            ],
            "columns": ["product_id", "product_name", "current_stock", "unit_price"],
        },
    )
    assert response.status_code == 422
    assert response.json()["detail"]["rejected_rows"] == 1


# ---------------------------------------------------------------------------
# The inventory snapshot overlay
# ---------------------------------------------------------------------------


def test_snapshot_overlay_fills_stock_lead_time_and_cost():
    catalog = {
        row["product_id"]: {"product_id": row["product_id"]}
        for row in csv.DictReader(RAW_SALES_CSV.open(encoding="utf-8-sig"))
    }
    catalog = {pid: dict(entry) for pid, entry in list(catalog.items())}
    seeded = {pid: entry for pid, entry in catalog.items() if pid in {"P001", "P002"}}
    assert seeded, "the raw store should contain P001/P002"

    applied = apply_inventory_snapshot(seeded)

    assert applied == 2
    assert seeded["P001"]["current_stock"] == "225"
    assert seeded["P001"]["lead_time_days"] == "4"
    assert seeded["P001"]["unit_cost"] == "1000"


def test_snapshot_overlay_never_adds_a_product_the_sales_store_lacks():
    catalog = {"P001": {"product_id": "P001"}}
    assert apply_inventory_snapshot(catalog) == 1
    assert list(catalog) == ["P001"]


def test_snapshot_overlay_of_an_empty_catalog_is_a_no_op():
    catalog: dict = {}
    assert apply_inventory_snapshot(catalog) == 0
    assert catalog == {}


def test_a_missing_snapshot_leaves_the_catalog_alone(monkeypatch, tmp_path):
    from backend import config

    monkeypatch.setattr(config, "RAW_INVENTORY_CSV", tmp_path / "absent.csv")
    catalog = {"P001": {"product_id": "P001"}}
    assert apply_inventory_snapshot(catalog) == 0
    assert catalog == {"P001": {"product_id": "P001"}}


def test_seeded_catalog_carries_real_stock_and_a_price():
    ws = TenantWorkspace("seed-user")
    written = seed_canonical_demo(ws, limit=200)
    assert written > 0
    product = ws.products["P001"]
    assert product.current_stock == 225
    assert product.lead_time_days == 4
    assert product.unit_cost == 1000
    # A product with no price of its own still needs one for the forecaster to
    # fall back to, so the seed takes it from the recorded sales price.
    assert product.unit_price > 0


def test_seeding_leaves_no_product_at_zero_stock():
    """A seeded catalog with no stock would mark every product critically short."""

    ws = TenantWorkspace("seed-user")
    seed_canonical_demo(ws, limit=200)
    snapshot_ids = {row["product_id"] for row in
                    csv.DictReader(RAW_INVENTORY_CSV.open(encoding="utf-8-sig"))}
    covered = {pid: p for pid, p in ws.products.items() if pid in snapshot_ids}
    assert covered
    for product in covered.values():
        assert product.current_stock > 0, product.product_id


# ---------------------------------------------------------------------------
# Seed row budget
#
# The canonical store keeps one contiguous block of days per product, so a
# head-of-file slice hands the whole row budget to the first product and the
# demo tenant gets a one-product catalog. These tests pin the spread.
# ---------------------------------------------------------------------------


def _snapshot_ids():
    with RAW_INVENTORY_CSV.open(encoding="utf-8-sig") as handle:
        return {row["product_id"] for row in csv.DictReader(handle)}


def test_seed_row_budget_reaches_every_product():
    budget = _seed_product_budget(RAW_SALES_CSV, 200)
    assert set(budget) == _snapshot_ids()
    assert all(share > 0 for share in budget.values())


@pytest.mark.parametrize("limit", [1, 5, 7, 20, 200, 1000, 100_000])
def test_seed_row_budget_never_exceeds_the_limit(limit):
    """The budget divides, it does not multiply: rounding up must not overshoot."""

    budget = _seed_product_budget(RAW_SALES_CSV, limit)
    assert sum(budget.values()) <= limit


def test_a_small_budget_is_still_spread_across_the_catalog():
    ws = TenantWorkspace("spread-user")
    written = seed_canonical_demo(ws, limit=20)
    assert written <= 20
    # The old head-of-file behaviour gave 20 rows to P001 and four empty slots.
    assert len(ws.products) == len(_snapshot_ids())
    for pid in ws.products:
        assert ws.sales_history_for(pid), pid


def test_the_default_seed_fills_the_whole_catalog():
    """A demo tenant should show a catalog, not one product and four gaps."""

    ws = TenantWorkspace("default-seed-user")
    written = seed_canonical_demo(ws)
    assert len(ws.products) == len(_snapshot_ids())
    assert written == sum(len(ws.sales_history_for(pid)) for pid in ws.products)


def test_the_default_seed_gives_every_product_a_model_ready_history():
    """Below 180 days the forecaster labels a `baseline` fallback, not the model.

    A demo whose dashboard shows a fallback everywhere teaches the user that
    forecasting does not work, which is the one thing this seed must not do.
    """

    ws = TenantWorkspace("model-seed-user")
    seed_canonical_demo(ws)
    for pid in sorted(ws.products):
        history = ws.sales_history_for(pid)
        assert len(history) >= 180, (pid, len(history))
        result = ws.forecast_for(pid, audit=False)
        assert result["fallback_used"] == "ml", (pid, result["fallback_used"])
        assert result["model_version"].startswith("xgboost"), pid


def test_every_seeded_product_ends_on_the_same_day():
    """Prefixes of equal length must align, or a portfolio forecast is incoherent."""

    ws = TenantWorkspace("aligned-seed-user")
    seed_canonical_demo(ws)
    last_days = {
        ws.sales_history_for(pid)[-1]["date"] for pid in ws.products if
        ws.sales_history_for(pid)
    }
    assert len(last_days) == 1, last_days


# ---------------------------------------------------------------------------
# POST /api/v2/demo/seed
# ---------------------------------------------------------------------------


def test_demo_seed_loads_the_dataset_for_the_calling_tenant():
    response = _post("/api/v2/demo/seed", {}, user="seed-api")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["user_id"] == "seed-api"
    assert body["sales_rows"] > 0
    assert body["products"] > 0
    assert v2._WORKSPACES["seed-api"].products


def test_demo_seed_requires_authentication():
    assert client.post("/api/v2/demo/seed", json={"user_id": "x"}).status_code == 401


def test_demo_seed_refuses_another_tenants_id():
    response = client.post(
        "/api/v2/demo/seed",
        json={"user_id": "someone-else"},
        headers={"Authorization": f"Bearer {_token('owner')}"},
    )
    assert response.status_code == 403


def test_demo_seed_will_not_overwrite_an_existing_catalog():
    _seed(user="busy-user")
    response = _post("/api/v2/demo/seed", {}, user="busy-user")
    assert response.status_code == 409
    assert "overwrite" in response.json()["detail"]


def test_demo_seed_is_scoped_to_the_tenant_that_asked():
    _post("/api/v2/demo/seed", {}, user="first-user")
    _post("/api/v2/demo/seed", {}, user="second-user")
    first = v2._WORKSPACES["first-user"]
    second = v2._WORKSPACES["second-user"]
    assert set(first.products) == set(second.products)
    assert first.user_id == "first-user"
    assert second.user_id == "second-user"


def test_demo_seed_limit_bounds_the_history():
    response = _post("/api/v2/demo/seed", {"limit": 20}, user="limited-user")
    assert response.status_code == 200
    assert response.json()["sales_rows"] <= 20
