"""Tests for the tenant intelligence layer behind the inventory UI.

These cover the business surface the application renders: demand forecasts with
confidence bands, the portfolio aggregate, inventory health buckets, stockout
projections, reorder quantities, and the ranked recommendations page.

The important invariant throughout is that these read paths are *honest*:
they run the real model when the eligibility gate allows it, they say plainly
when they fell back, and rendering a page never writes a decision to the audit
trail.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from backend.tenant import TenantWorkspace


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


def _workspace(user="intel-user", *, days=200, products=None, with_ml_fields=False):
    ws = TenantWorkspace(user)
    ws.add_products(products or [_product()])
    rows = []
    for index, day in enumerate(_days(days)):
        for target in (products or [_product()]):
            row = {
                "product_id": target["product_id"],
                "date": day,
                "units_sold": 5 + (index % 7),
                "price": target.get("unit_price", 12.0),
            }
            if with_ml_fields:
                row["category"] = target["category"]
                row["promotion"] = False
            rows.append(row)
    if rows:
        ws.upsert_sales_rows(rows)
    return ws


# ---------------------------------------------------------------------------
# The real model, and when it is allowed to run
# ---------------------------------------------------------------------------


def test_plain_sales_rows_still_reach_the_real_model():
    """A tenant that ingests ordinary sales data must get an ML forecast.

    ``category``/``promotion`` are optional on a sales row, so without the
    history enrichment every real customer would be permanently locked out of
    the model and silently shown a baseline.
    """
    ws = _workspace(with_ml_fields=False)
    result = ws.forecast_for("P1", audit=False)
    assert result["eligibility"]["eligible"] is True
    assert result["fallback_used"] == "ml"
    assert result["model_version"] == "xgboost-v1.0.0"
    assert len(result["forecast"]) == 30


def test_derived_ml_inputs_are_disclosed_not_hidden():
    ws = _workspace(with_ml_fields=False)
    result = ws.forecast_for("P1", audit=False)
    codes = {w["code"] for w in result.get("history_warnings", [])}
    assert "ml_features_derived" in codes
    derived = next(
        w for w in result["history_warnings"] if w["code"] == "ml_features_derived"
    )
    assert {"category", "promotion"} <= set(derived["fields"])


def test_explicit_ml_inputs_need_no_derivation_warning():
    ws = _workspace(with_ml_fields=True)
    result = ws.forecast_for("P1", audit=False)
    assert result["fallback_used"] == "ml"
    codes = {w.get("code") for w in result.get("history_warnings", [])}
    assert "ml_features_derived" not in codes


def test_short_history_is_still_refused_by_the_gate():
    """Enrichment fills known values; it must not fake enough history."""
    ws = _workspace(days=45, with_ml_fields=True)
    result = ws.forecast_for("P1", audit=False)
    assert result["eligibility"]["eligible"] is False
    assert result["fallback_used"] == "baseline"
    assert result["model_version"] is None
    assert result["warning"]


def test_a_new_product_with_no_history_falls_back_rather_than_failing():
    ws = _workspace(days=200)
    ws.add_product(_product(product_id="NEW", product_name="Brand New"))
    result = ws.forecast_for("NEW", audit=False)
    assert result["eligibility"]["eligible"] is False
    assert result["fallback_used"] == "baseline"


# ---------------------------------------------------------------------------
# demand_forecast
# ---------------------------------------------------------------------------


def test_demand_forecast_shape_and_totals_agree():
    ws = _workspace()
    fc = ws.demand_forecast("P1", horizon=30)
    assert len(fc["points"]) == 30
    assert fc["horizon"] == 30
    assert fc["product_id"] == "P1"
    assert fc["fallback_used"] == "ml"
    total = round(sum(p["forecast"] for p in fc["points"]), 2)
    assert fc["total"] == total
    assert fc["avg_daily"] == round(total / 30, 2)
    assert fc["peak_date"] == max(fc["points"], key=lambda p: p["forecast"])["date"]


def test_every_point_is_bracketed_by_its_confidence_band():
    ws = _workspace()
    for point in ws.demand_forecast("P1")["points"]:
        assert point["lower"] <= point["forecast"] <= point["upper"]
        assert point["date"] == date.fromisoformat(point["date"]).isoformat()


def test_band_is_nonzero_for_real_demand():
    """A band of exactly zero would be a false claim of certainty."""
    ws = _workspace()
    assert ws.demand_forecast("P1")["error_std"] > 0


def test_points_are_dated_after_the_last_sale():
    ws = _workspace()
    last_sale = _days(200)[-1]
    for point in ws.demand_forecast("P1")["points"]:
        assert point["date"] > last_sale


def test_horizon_is_clamped_to_a_sane_range():
    ws = _workspace()
    assert len(ws.demand_forecast("P1", horizon=1)["points"]) == 1
    assert len(ws.demand_forecast("P1", horizon=5000)["points"]) == 180


def test_actuals_are_recent_history_in_date_order():
    ws = _workspace()
    actuals = ws.demand_forecast("P1")["actuals"]
    assert actuals
    assert [a["date"] for a in actuals] == sorted(a["date"] for a in actuals)
    assert len(actuals) <= 60


def test_demand_forecast_of_an_unknown_product_is_refused():
    from backend.tenant import TenantIsolationError

    ws = _workspace()
    with pytest.raises(TenantIsolationError):
        ws.demand_forecast("NOPE")


# ---------------------------------------------------------------------------
# portfolio_forecast
# ---------------------------------------------------------------------------


def test_portfolio_forecast_sums_every_product():
    ws = _workspace(products=[
        _product(product_id="P1", current_stock=10, unit_price=12.0),
        _product(product_id="P2", product_name="Gadget", current_stock=400,
                 category="Home", unit_price=5.0),
    ])
    portfolio = ws.portfolio_forecast(horizon=30)
    assert portfolio["products_in_scope"] == 2
    assert portfolio["products_forecast"] == 2
    assert len(portfolio["points"]) == 30
    assert {r["product_id"] for r in portfolio["rows"]} == {"P1", "P2"}
    # The portfolio total is the sum of the per-product totals.
    assert portfolio["total"] == round(
        sum(r["forecast_total"] for r in portfolio["rows"]), 2
    )


def test_portfolio_forecast_can_be_scoped_to_a_category():
    ws = _workspace(products=[
        _product(product_id="P1", category="Electronics"),
        _product(product_id="P2", category="Home"),
    ])
    scoped = ws.portfolio_forecast(category="Home")
    assert scoped["products_in_scope"] == 1
    assert [r["product_id"] for r in scoped["rows"]] == ["P2"]


def test_portfolio_forecast_reports_every_product_with_its_own_label():
    """An ineligible product still gets a labeled baseline rather than vanishing.

    Dropping it would silently understate portfolio demand; the row carries
    ``fallback_used`` so the caller can show that it is not a model forecast.
    """
    ws = _workspace(days=200)
    ws.add_product(_product(product_id="NEW", product_name="Brand New", current_stock=5))
    portfolio = ws.portfolio_forecast()
    assert portfolio["products_in_scope"] == 2
    assert portfolio["products_forecast"] == 2
    labelled = {r["product_id"]: r["fallback_used"] for r in portfolio["rows"]}
    assert labelled["P1"] == "ml"
    assert labelled["NEW"] == "baseline"


def test_portfolio_read_does_not_flood_the_audit_trail():
    ws = _workspace()
    before = len(ws.audit)
    for _ in range(3):
        ws.portfolio_forecast()
    assert len(ws.audit) == before


# ---------------------------------------------------------------------------
# inventory_overview
# ---------------------------------------------------------------------------


def test_inventory_overview_buckets_and_kpis():
    ws = _workspace(products=[
        _product(product_id="SCARCE", current_stock=1),      # below safety stock
        _product(product_id="PLENTY", current_stock=100_000),  # far above target
    ])
    overview = ws.inventory_overview()
    assert overview["kpis"]["total_products"] == 2
    assert overview["health"]["total"] == 2
    assert sum(overview["health"][k] for k in ("healthy", "at_risk", "critical")) == 2
    assert overview["kpis"]["inventory_value"] > 0
    assert overview["kpis"]["total_units"] == 100_001


def test_inventory_overview_breaks_down_by_category():
    ws = _workspace(products=[
        _product(product_id="P1", category="Electronics", current_stock=10),
        _product(product_id="P2", category="Electronics", current_stock=20),
        _product(product_id="P3", category="Home", current_stock=30),
    ])
    categories = {c["category"]: c for c in ws.inventory_overview()["categories"]}
    assert set(categories) == {"Electronics", "Home"}
    assert categories["Electronics"]["products"] == 2
    assert categories["Electronics"]["units"] == 30
    assert categories["Home"]["products"] == 1


def test_inventory_overview_of_an_empty_tenant_is_zero_not_an_error():
    overview = TenantWorkspace("empty").inventory_overview()
    assert overview["kpis"]["total_products"] == 0
    assert overview["categories"] == []
    assert overview["health"]["total"] == 0


# ---------------------------------------------------------------------------
# stockout_timeline
# ---------------------------------------------------------------------------


def test_timeline_projects_depletion_and_earliest_date():
    ws = _workspace(products=[_product(current_stock=10, lead_time_days=4)])
    timeline = ws.stockout_timeline("P1", days=45)
    assert timeline["product_id"] == "P1"
    assert timeline["expected_depletion"] is not None
    points = timeline["points"]
    assert points
    # Dates must be strictly increasing.
    assert [p["date"] for p in points] == sorted({p["date"] for p in points})
    # No-reorder stock can only fall, and never below zero.
    stocks = [p["stock_without_reorder"] for p in points]
    assert all(s >= 0 for s in stocks)
    assert stocks == sorted(stocks, reverse=True)


def test_timeline_shows_that_reordering_helps():
    """Over the order-up-to window, reordering is what keeps stock on hand.

    The comparison is deliberately made at 30 days because that is the window
    the target inventory is sized for; beyond it any policy runs out again.
    """
    ws = _workspace(products=[_product(current_stock=10, lead_time_days=4)])
    timeline = ws.stockout_timeline("P1", days=30)
    last = timeline["points"][-1]
    assert timeline["reorder_placed_on"] is not None
    assert last["stock"] > 0
    assert last["stock"] > last["stock_without_reorder"]


def test_timeline_of_a_healthy_product_never_reorders():
    ws = _workspace(products=[_product(current_stock=100_000, lead_time_days=4)])
    timeline = ws.stockout_timeline("P1", days=30)
    assert timeline["status"] == "overstocked"
    assert timeline["reorder_placed_on"] is None


# ---------------------------------------------------------------------------
# reorder_recommendation
# ---------------------------------------------------------------------------


def test_reorder_is_required_when_below_the_reorder_point():
    ws = _workspace(products=[_product(current_stock=1, lead_time_days=7)])
    reorder = ws.reorder_recommendation("P1")
    assert reorder["reorder_required"] is True
    assert reorder["recommended_order_qty"] > 0
    assert reorder["target_inventory"] > reorder["inventory_position"]


def test_no_order_is_recommended_when_stock_is_ample():
    ws = _workspace(products=[_product(current_stock=100_000, lead_time_days=7)])
    reorder = ws.reorder_recommendation("P1")
    assert reorder["reorder_required"] is False
    assert reorder["recommended_order_qty"] == 0


def test_moq_and_pack_size_are_respected():
    ws = _workspace(products=[_product(current_stock=1, lead_time_days=7)])
    plain = ws.reorder_recommendation("P1")["recommended_order_qty"]
    batched = ws.reorder_recommendation("P1", moq=500, pack_size=25)
    assert batched["recommended_order_qty"] >= 500
    assert batched["recommended_order_qty"] % 25 == 0
    assert batched["recommended_order_qty"] >= plain


# ---------------------------------------------------------------------------
# recommendations
# ---------------------------------------------------------------------------


def test_recommendations_classify_a_scarce_product_as_critical():
    ws = _workspace(products=[_product(current_stock=1, lead_time_days=7)])
    result = ws.recommendations()
    assert result["counts"]["all"] == 1
    (item,) = result["items"]
    assert item["type"] == "critical"
    assert item["title"] == "Reorder Required"
    assert item["action_label"] == "Reorder now"
    assert item["recommended_order_qty"] > 0
    assert item["reason"]


def test_recommendations_flag_excess_inventory():
    ws = _workspace(products=[_product(current_stock=100_000, lead_time_days=7)])
    (item,) = ws.recommendations()["items"]
    assert item["type"] == "reorder"
    assert item["title"] == "Excess Inventory"
    assert item["recommended_order_qty"] == 0


def test_recommendations_are_sorted_most_actionable_first():
    ws = _workspace(products=[
        _product(product_id="HEALTHY", current_stock=100_000),
        _product(product_id="SCARCE", current_stock=1),
        _product(product_id="MID", current_stock=40),
    ])
    types = [r["type"] for r in ws.recommendations()["items"]]
    order = {"critical": 0, "reorder": 1, "monitor": 2, "no_action": 3}
    assert types == sorted(types, key=lambda t: order[t])


def test_recommendation_counts_match_the_returned_items():
    ws = _workspace(products=[
        _product(product_id="A", current_stock=1),
        _product(product_id="B", current_stock=100_000),
    ])
    result = ws.recommendations()
    assert result["counts"]["all"] == len(result["items"])
    for bucket in ("critical", "reorder", "monitor", "no_action"):
        assert result["counts"][bucket] == sum(
            1 for r in result["items"] if r["type"] == bucket
        )


def test_recommendations_carry_the_fallback_label_for_each_row():
    """The page must not present a baseline as if it were a model forecast."""
    ws = _workspace(days=45)
    (item,) = ws.recommendations()["items"]
    assert item["fallback_used"] == "baseline"
    assert item["eligibility"]["eligible"] is False


def test_recommendations_read_does_not_write_audit_entries():
    ws = _workspace()
    before = len(ws.audit)
    for _ in range(3):
        ws.recommendations()
    assert len(ws.audit) == before


def test_recommendations_of_an_empty_tenant_is_empty():
    result = TenantWorkspace("empty").recommendations()
    assert result["items"] == []
    assert result["counts"]["all"] == 0


# ---------------------------------------------------------------------------
# Tenant isolation
# ---------------------------------------------------------------------------


def test_intelligence_never_crosses_tenants():
    from backend.tenant import TenantIsolationError

    mine = _workspace("mine")
    theirs = _workspace("theirs", products=[_product(product_id="OTHER")])
    assert "OTHER" in theirs.products
    assert "OTHER" not in mine.products

    # A product that belongs to someone else is an isolation error, not a 404.
    for call in (
        lambda: mine.demand_forecast("OTHER"),
        lambda: mine.reorder_recommendation("OTHER"),
        lambda: mine.stockout_timeline("OTHER"),
    ):
        with pytest.raises(TenantIsolationError):
            call()


def test_a_category_filter_cannot_disguise_another_tenants_data_as_empty():
    """An unmatched filter must not read as "nothing needs attention"."""
    mine = _workspace("mine", products=[_product(category="Electronics")])
    _workspace("theirs", products=[_product(product_id="OTHER", category="Secret")])

    with pytest.raises(ValueError):
        mine.recommendations(category="Secret")

    # And the unfiltered read still shows only this tenant's own products.
    assert {r["product_id"] for r in mine.recommendations()["items"]} == {"P1"}


def test_a_second_tenant_sees_only_its_own_overview():
    mine = _workspace("mine", products=[_product(product_id="MINE", current_stock=1)])
    _workspace("theirs", products=[_product(product_id="THEIRS", current_stock=1)])
    assert mine.inventory_overview()["kpis"]["total_products"] == 1
