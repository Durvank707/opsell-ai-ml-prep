"""V2 replenishment policy: demand forecasting and order sizing are separate.

Mirrors the V1 policy pinned in tests/test_replenishment_policy.py: the 30-day
forecast remains planning visibility while the recommended order quantity is
``max(0, reorder_point - inventory_position)``, with

    reorder_point = lead_time_demand + safety_stock

where lead_time_demand is the expected demand over the supplier lead time
taken from the first ``lead_time_days`` of the existing ML forecast.
"""

from datetime import date, timedelta

import pytest

from backend.tenant import TenantIsolationError, TenantWorkspace

START = date(2025, 1, 1)


def _days(count: int):
    return [(START + timedelta(days=i)).isoformat() for i in range(count)]


def _product(**overrides):
    row = {
        "product_id": "P1",
        "product_name": "Widget",
        "category": "Electronics",
        "current_stock": 10,
        "lead_time_days": 4,
        "unit_cost": 3.5,
        "unit_price": 12.0,
    }
    row.update(overrides)
    return row


def _workspace(user="v2-intel", *, days=200, products=None):
    """A tenant with enough history for the eligibility gate to allow ML."""
    ws = TenantWorkspace(user)
    targets = products or [_product()]
    ws.add_products(targets)
    ws.upsert_sales_rows([
        {
            "product_id": target["product_id"],
            "date": day,
            "units_sold": 5 + (index % 7),
            "price": target.get("unit_price", 12.0),
        }
        for index, day in enumerate(_days(days))
        for target in targets
    ])
    return ws


# ---------------------------------------------------------------------------
# a. The 30-day demand forecast itself is unchanged.
# ---------------------------------------------------------------------------


def test_30day_forecast_is_unchanged():
    ws = _workspace()
    fc = ws.demand_forecast("P1", audit=False)

    assert fc["horizon"] == 30
    assert len(fc["points"]) == 30
    assert fc["total"] == pytest.approx(
        sum(p["forecast"] for p in fc["points"]), abs=0.06
    )

    # Asking for a reorder must not disturb that outlook.
    ws.reorder_recommendation("P1")
    again = ws.demand_forecast("P1", audit=False)
    assert [p["forecast"] for p in again["points"]] == [
        p["forecast"] for p in fc["points"]
    ]


# ---------------------------------------------------------------------------
# b. Target / reorder point = lead-time demand + safety stock.
# ---------------------------------------------------------------------------


def test_target_and_reorder_point_are_lead_time_demand_plus_safety():
    ws = _workspace()
    rec = ws.reorder_recommendation("P1")
    fc = ws.demand_forecast("P1", audit=False)

    assert rec["lead_time_demand"] > 0
    assert rec["safety_stock"] > 0
    expected = round(rec["lead_time_demand"] + rec["safety_stock"], 2)
    assert rec["reorder_point"] == pytest.approx(expected, abs=0.011)
    assert rec["target_inventory"] == pytest.approx(expected, abs=0.011)
    # The target comes from the lead-time slice of the forecast, NOT the whole
    # 30-day outlook.
    assert rec["target_inventory"] < fc["total"] + rec["safety_stock"]


# ---------------------------------------------------------------------------
# c. Recommended order quantity is based on the inventory position.
# ---------------------------------------------------------------------------


def test_recommended_quantity_is_position_driven():
    ws = _workspace(products=[_product(current_stock=3, lead_time_days=4)])
    rec = ws.reorder_recommendation("P1")

    assert rec["reorder_required"] is True
    assert rec["recommended_order_qty"] > 0
    # order = max(0, reorder_point - inventory_position), within the one unit
    # of ceil/round tolerance used by the shared policy.
    assert abs(
        rec["recommended_order_qty"]
        - (rec["reorder_point"] - rec["inventory_position"])
    ) <= 1


# ---------------------------------------------------------------------------
# d. Open orders reduce the recommended quantity by the same amount.
# ---------------------------------------------------------------------------


def test_open_orders_reduce_the_quantity_one_for_one():
    low = _workspace("low", products=[_product(current_stock=5, open_order_qty=0)])
    rec0 = low.reorder_recommendation("P1")
    assert rec0["reorder_required"] is True
    assert rec0["recommended_order_qty"] > 0

    inbound = _workspace(
        "inbound", products=[_product(current_stock=5, open_order_qty=30)]
    )
    rec1 = inbound.reorder_recommendation("P1")
    assert rec1["inventory_position"] == 35
    assert rec1["recommended_order_qty"] == rec0["recommended_order_qty"] - 30
    assert rec1["recommended_order_qty"] > 0

    covered = _workspace(
        "covered", products=[_product(current_stock=5, open_order_qty=10_000)]
    )
    rec2 = covered.reorder_recommendation("P1")
    assert rec2["inventory_position"] == 10_005
    assert rec2["reorder_required"] is False
    assert rec2["recommended_order_qty"] == 0


# ---------------------------------------------------------------------------
# e. Sufficient inventory position produces reorder_required=False, qty=0.
# ---------------------------------------------------------------------------


def test_ample_stock_needs_no_order():
    ws = _workspace(products=[_product(current_stock=100_000, lead_time_days=4)])
    rec = ws.reorder_recommendation("P1")
    assert rec["reorder_required"] is False
    assert rec["recommended_order_qty"] == 0


# ---------------------------------------------------------------------------
# f. A high 30-day forecast does NOT automatically produce a 30-day order.
# ---------------------------------------------------------------------------


def test_a_high_forecast_does_not_order_thirty_days():
    ws = _workspace(products=[_product(current_stock=5, lead_time_days=4)])
    fc = ws.demand_forecast("P1", audit=False)
    assert fc["total"] > 100  # genuinely large 30-day outlook

    rec = ws.reorder_recommendation("P1")
    assert rec["reorder_required"] is True
    assert rec["recommended_order_qty"] > 0
    assert rec["lead_time_days"] < 30
    # The order is sized for the lead time: a fraction of the 30-day total.
    assert rec["recommended_order_qty"] < fc["total"]
    assert rec["target_inventory"] < fc["total"] + rec["safety_stock"]


# ---------------------------------------------------------------------------
# g. Tenant isolation still holds for the reorder path.
# ---------------------------------------------------------------------------


def test_reorder_never_crosses_tenants():
    mine = _workspace("mine", products=[_product(current_stock=5)])
    theirs = _workspace("theirs", products=[_product(product_id="OTHER", current_stock=5)])

    assert mine.reorder_recommendation("P1")["product_id"] == "P1"
    assert theirs.reorder_recommendation("OTHER")["product_id"] == "OTHER"
    # A product that belongs to another tenant is an isolation error, not a 404.
    with pytest.raises(TenantIsolationError):
        mine.reorder_recommendation("OTHER")