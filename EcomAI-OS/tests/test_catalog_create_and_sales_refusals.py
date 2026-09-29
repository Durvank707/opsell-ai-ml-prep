"""Regression tests for catalog creation and sales-import refusals.

Two rules a merchant relies on, both of which were quietly broken:

* creating a product that already exists used to *replace* it. The duplicate
  POST answered 200 and wrote a fresh row, discarding the name, supplier, price
  and stock the tenant had under that id. A catalog is the tenant's own
  metadata, so a create that overwrites it is data loss with a success message
  on top;
* a sales file naming products the tenant has not added was refused, but with a
  message that read like a contract error ("ingest the 'product' contract
  first") rather than naming the ids and the fix.

Everything here goes through ``POST /api/v2/ingest``, the only route that writes,
so the assertions are about what a tenant would actually see.
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
from backend.tenant import DuplicateProductError, TenantWorkspace, duplicate_product_message
from backend.routers.v2 import unknown_sales_products_message

SECRET = "test-" + secrets.token_urlsafe(48)
client = TestClient(app)

DUPLICATE_MESSAGE = (
    "Product ID P001 already exists in your catalog. Use a different Product ID "
    "or edit the existing product."
)
PRODUCT = {
    "product_id": "P001",
    "product_name": "Wireless Headphones",
    "category": "Electronics",
    "current_stock": 225,
    "lead_time_days": 4,
    "unit_cost": 1000,
    "unit_price": 1999,
    "safety_stock": 20,
    "supplier": "Acme Audio",
    "description": "Flagship wireless over-ear headset",
}


def _b64(value: dict) -> str:
    encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(encoded).rstrip(b"=").decode("ascii")


def _token(subject: str) -> str:
    now = time.time()
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": subject, "iat": now, "exp": now + 3600})
    signing_input = f"{header}.{payload}".encode("ascii")
    signature = hmac.new(SECRET.encode("utf-8"), signing_input, hashlib.sha256).digest()
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


def _ingest(body, *, user="dup-user"):
    return client.post(
        "/api/v2/ingest",
        json=body,
        headers={"Authorization": f"Bearer {_token(user)}"},
    )


def _create(product_id, **overrides):
    return _ingest({
        "user_id": "dup-user",
        "record_type": "product",
        "rows": [{**PRODUCT, "product_id": product_id, **overrides}],
    })


# ---------------------------------------------------------------------------
# Duplicate Product ID
# ---------------------------------------------------------------------------


def test_creating_the_same_product_id_twice_is_refused():
    assert _create("P001").status_code == 200

    response = _create("P001")

    assert response.status_code == 422
    assert response.json()["detail"] == DUPLICATE_MESSAGE


def test_a_refused_duplicate_leaves_the_original_untouched():
    """The bug: the second POST answered 200 and replaced the row."""

    _create("P001")

    response = _ingest({
        "user_id": "dup-user",
        "record_type": "product",
        "rows": [{
            "product_id": "P001",
            "product_name": "Renamed By Mistake",
            "category": "Home",
            "current_stock": 0,
            "lead_time_days": 30,
            "unit_cost": 1,
            "unit_price": 2,
            "safety_stock": 0,
        }],
    })

    assert response.status_code == 422
    stored = v2._WORKSPACES["dup-user"].products["P001"]
    assert stored.product_name == "Wireless Headphones"
    assert stored.category == "Electronics"
    assert stored.current_stock == 225
    assert stored.unit_price == 1999
    assert stored.unit_cost == 1000
    assert stored.supplier == "Acme Audio"
    assert stored.description == "Flagship wireless over-ear headset"


def test_a_differently_cased_duplicate_is_still_the_same_product():
    _create("P001")

    response = _create("p001")

    assert response.status_code == 422
    assert "p001" in response.json()["detail"]
    assert list(v2._WORKSPACES["dup-user"].products) == ["P001"]


def test_a_batch_with_one_existing_id_is_refused_whole():
    """No half-applied file: the new row is not written either."""

    _create("P001")

    response = _ingest({
        "user_id": "dup-user",
        "record_type": "product",
        "rows": [
            {**PRODUCT, "product_id": "P002", "product_name": "Desk Lamp"},
            {**PRODUCT, "product_id": "P001", "product_name": "Wireless Headphones"},
        ],
    })

    assert response.status_code == 422
    assert "P001" in response.json()["detail"]
    products = v2._WORKSPACES["dup-user"].products
    assert set(products) == {"P001"}


def test_another_tenant_may_hold_the_same_product_id():
    first = client.post(
        "/api/v2/ingest",
        json={"user_id": "tenant-a", "record_type": "product", "rows": [PRODUCT]},
        headers={"Authorization": f"Bearer {_token('tenant-a')}"},
    )
    second = client.post(
        "/api/v2/ingest",
        json={"user_id": "tenant-b", "record_type": "product", "rows": [PRODUCT]},
        headers={"Authorization": f"Bearer {_token('tenant-b')}"},
    )

    assert first.status_code == 200
    assert second.status_code == 200, "a different tenant's P001 is not a conflict"
    # Each workspace holds its own row; neither write reached the other.
    assert v2._WORKSPACES["tenant-a"].products["P001"] is not v2._WORKSPACES["tenant-b"].products["P001"]
    assert v2._WORKSPACES["tenant-a"].products["P001"].product_name == "Wireless Headphones"


def test_editing_an_existing_product_is_still_allowed():
    """The create is protected; the deliberate edit path is not."""

    _create("P001")

    response = client.patch(
        "/api/v2/products/P001?user_id=dup-user",
        json={"unit_price": 1799},
        headers={"Authorization": f"Bearer {_token('dup-user')}"},
    )

    assert response.status_code == 200
    assert v2._WORKSPACES["dup-user"].products["P001"].unit_price == 1799


def test_the_workspace_refusal_carries_the_ids_it_refused():
    ws = TenantWorkspace("ws-1")
    ws.add_new_products([PRODUCT])

    with pytest.raises(DuplicateProductError) as excinfo:
        ws.add_new_products([PRODUCT, {**PRODUCT, "product_id": "P002"}])

    assert excinfo.value.conflicts == ["P001"]
    assert str(excinfo.value) == duplicate_product_message(["P001"])


def test_the_several_conflict_sentence_lists_every_id():
    message = duplicate_product_message(["P001", "P002"])

    assert message.startswith("Product IDs P001, P002 already exist in your catalog.")
    assert "edit the existing products" in message


def test_the_internal_upsert_path_still_replaces():
    """`add_products` is the seed's and the update path's batch writer.

    Creation goes through `add_new_products`; this stays an upsert so the demo
    seed can be re-run and a re-imported catalog can still be refreshed. The
    test pins that the two paths are genuinely different, so the duplicate
    protection cannot be "fixed" by quietly changing this one.
    """

    ws = TenantWorkspace("ws-1")
    ws.add_products([PRODUCT])

    ws.add_products([{**PRODUCT, "product_name": "Refreshed"}])

    assert ws.products["P001"].product_name == "Refreshed"


# ---------------------------------------------------------------------------
# Unknown product IDs in a sales file
# ---------------------------------------------------------------------------


def _seed_product(product_id="P001"):
    response = _create(product_id)
    assert response.status_code == 200


def _sales(rows):
    return _ingest({"user_id": "dup-user", "record_type": "sales", "rows": rows})


def test_a_sales_file_naming_unknown_products_is_refused_with_the_ids():
    _seed_product()

    response = _sales([
        {"product_id": "P001", "date": "2026-09-01", "units_sold": 5, "price": 799},
        {"product_id": "P999", "date": "2026-09-01", "units_sold": 3, "price": 100},
        {"product_id": "P1000", "date": "2026-09-01", "units_sold": 2, "price": 100},
        {"product_id": "P1001", "date": "2026-09-01", "units_sold": 1, "price": 100},
    ])

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "Sales import contains 3 product IDs that are not in your catalog: "
        "P999, P1000, P1001. Add these products to your catalog first, then "
        "upload the sales data."
    )


def test_a_refused_sales_file_writes_nothing_and_invents_no_product():
    _seed_product()

    response = _sales([
        {"product_id": "P001", "date": "2026-09-01", "units_sold": 5, "price": 799},
        {"product_id": "P999", "date": "2026-09-01", "units_sold": 3, "price": 100},
    ])

    assert response.status_code == 422
    ws = v2._WORKSPACES["dup-user"]
    assert ws.sales_records == {}, "a refused batch must not partially write"
    assert "P999" not in ws.products, "sales must never create catalog rows"
    assert set(ws.products) == {"P001"}


def test_one_unknown_id_reads_as_a_single_product():
    _seed_product()

    response = _sales([{"product_id": "P404", "date": "2026-09-01", "units_sold": 1}])

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "Sales import contains 1 product ID that is not in your catalog: P404. "
        "Add this product to your catalog first, then upload the sales data."
    )


def test_another_tenants_product_is_unknown_here():
    """The check reads this workspace's catalog only."""

    client.post(
        "/api/v2/ingest",
        json={"user_id": "tenant-a", "record_type": "product", "rows": [PRODUCT]},
        headers={"Authorization": f"Bearer {_token('tenant-a')}"},
    )

    response = _sales([{"product_id": "P001", "date": "2026-09-01", "units_sold": 1}])

    assert response.status_code == 422
    assert "P001" in response.json()["detail"]
    assert v2._WORKSPACES["tenant-a"].products  # the other tenant is untouched


def test_a_long_list_of_unknown_ids_is_summarised():
    message = unknown_sales_products_message([f"P{n:03d}" for n in range(1, 26)])

    assert message.startswith("Sales import contains 25 product IDs")
    assert "P010" in message
    assert "and 15 more" in message


def test_a_known_product_still_imports():
    _seed_product()

    response = _sales([
        {"product_id": "P001", "date": "2026-09-01", "units_sold": 5, "price": 799},
        {"product_id": "P001", "date": "2026-09-02", "units_sold": 2},
    ])

    assert response.status_code == 200
    assert response.json()["ingested_rows"] == 2
    assert len(v2._WORKSPACES["dup-user"].sales_records) == 2
