"""Policy profiles, the replenishment rule, and the single-product backtest.

These tests exist because the simulator used to advertise behaviour the backend
did not implement. Each one pins a claim the Simulation page now makes:

* the replenishment rule is lead-time demand + safety stock, not the 30-day
  forecast total;
* ``current`` is exactly the live V2 recommendation;
* the policy presets change the configured parameters and nothing else;
* a custom policy may only set the two parameters the server honours;
* the whole run is one product, and the API refuses anything wider.
"""

import base64
import hashlib
import hmac
import json
import math
import re
import secrets
import time
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routers import v2
from src.inventory.policy_profiles import (
    AGGRESSIVE_SAFETY_MULTIPLIER,
    COMPARABLE_POLICY_KEYS,
    CONSERVATIVE_SAFETY_MULTIPLIER,
    CUSTOM_PARAM_FIELDS,
    POLICY_PROFILES,
    PolicyProfile,
    describe_custom_fields,
    describe_profiles,
    get_profile,
    policy_keys,
    resolve_policy,
)
from src.inventory.reorder import calculate_reorder_point
from src.inventory.simulation import (
    prepare_backtest_forecast,
    run_backtest,
    run_baseline_backtest,
    run_policy_replay,
)
from backend.tenant import TenantWorkspace


# ---------------------------------------------------------------------------
# Policy profile resolution
# ---------------------------------------------------------------------------


BASE = dict(
    safety_stock=20.0,
    daily_forecast=10.0,
    lead_time_demand=50.0,
    lead_time_days=5,
)


def test_current_policy_reproduces_the_live_v2_reorder_rule():
    """`current` must equal the production recommendation, exactly.

    Live V2 tops the inventory position up to lead-time demand plus safety
    stock. If `current` meant anything else, "run the simulation" would stop
    describing what the product page would have recommended.
    """
    resolved = resolve_policy(get_profile("current"), **BASE)

    assert resolved.safety_stock == 20.0
    # Reorder point and order-up-to are the same level under `current`.
    assert resolved.reorder_point == 50.0 + 20.0
    assert resolved.order_up_to == 50.0 + 20.0
    assert resolved.order_up_to == calculate_reorder_point(
        lead_time_demand=50.0, safety_stock=20.0
    )


def test_reorder_point_is_never_built_from_the_30_day_forecast():
    """The 30-day total must not reach the replenishment levels.

    A 30-day target would be ~6x the lead-time target for a 5-day lead time and
    would order far more than live V2 ever recommends.
    """
    base = dict(BASE)
    base["daily_forecast"] = 10.0  # 30-day forecast = 300 units
    resolved = resolve_policy(get_profile("current"), **base)

    assert resolved.order_up_to == 70.0
    assert resolved.order_up_to < 10.0 * 30 + resolved.safety_stock


@pytest.mark.parametrize(
    "key, expected_safety",
    [("current", 20.0), ("conservative", 30.0), ("aggressive", 10.0)],
)
def test_presets_scale_the_configured_safety_stock(key, expected_safety):
    resolved = resolve_policy(get_profile(key), **BASE)
    assert resolved.safety_stock == expected_safety


def test_safety_multipliers_are_stated_where_they_are_declared():
    """A preset's number is a declared constant, not an incidental value."""
    assert POLICY_PROFILES["conservative"].safety_multiplier == 1.5
    assert POLICY_PROFILES["aggressive"].safety_multiplier == 0.5
    # Only the safety buffer varies; the coverage rule is the production one.
    for key in ("current", "conservative", "aggressive"):
        assert POLICY_PROFILES[key].coverage_multiplier == 1.0


def test_conservative_reorders_earlier_and_orders_more_than_current():
    """'Keep more safety inventory' has to actually change the order."""
    current = resolve_policy(get_profile("current"), **BASE)
    conservative = resolve_policy(get_profile("conservative"), **BASE)
    aggressive = resolve_policy(get_profile("aggressive"), **BASE)

    assert conservative.reorder_point > current.reorder_point
    assert conservative.order_up_to > current.order_up_to
    assert aggressive.order_up_to < current.order_up_to


def test_every_profile_describes_itself_in_plain_english():
    for key in policy_keys():
        assert POLICY_PROFILES[key].label
        assert POLICY_PROFILES[key].description


def test_describe_profiles_and_custom_fields_cover_the_whole_ui():
    described = {row["key"] for row in describe_profiles()}
    assert described == set(policy_keys())

    custom = describe_custom_fields()
    assert set(custom) == set(CUSTOM_PARAM_FIELDS)
    for text in custom.values():
        assert text


def test_an_unknown_policy_key_is_refused_not_silently_treated_as_current():
    with pytest.raises(ValueError, match="not a supported inventory policy"):
        get_profile("yolo")


def test_policy_resolution_is_deterministic():
    first = resolve_policy(get_profile("conservative"), **BASE)
    second = resolve_policy(get_profile("conservative"), **BASE)
    assert first == second


# ---------------------------------------------------------------------------
# Custom policy parameters
# ---------------------------------------------------------------------------


def test_custom_policy_uses_the_supplied_safety_stock():
    resolved = resolve_policy(
        get_profile("custom"),
        custom={"safety_stock": 99, "coverage_days": 7},
        **BASE,
    )
    assert resolved.safety_stock == 99.0
    # Coverage is now 7 days of the 10-unit daily forecast, not 5 days of
    # lead-time demand.
    assert resolved.coverage_demand == 70.0
    assert resolved.reorder_point == 70.0 + 99.0
    assert resolved.order_up_to == 70.0 + 99.0


def test_custom_policy_coverage_days_changes_the_replenishment_target():
    narrow = resolve_policy(
        get_profile("custom"), custom={"coverage_days": 2}, **BASE
    )
    wide = resolve_policy(
        get_profile("custom"), custom={"coverage_days": 14}, **BASE
    )
    assert wide.order_up_to > narrow.order_up_to


def test_custom_policy_falls_back_to_the_current_values_it_omits():
    """An omitted field is the current policy's own value, not a guess."""
    resolved = resolve_policy(
        get_profile("custom"), custom={"safety_stock": 5}, **BASE
    )
    assert resolved.safety_stock == 5.0
    # Coverage left alone is the 50 units of lead-time demand.
    assert resolved.coverage_demand == 50.0
    assert resolved.coverage_days == 5.0


def test_custom_policy_refuses_a_parameter_the_server_would_ignore():
    """A field that is accepted and then dropped would look like it worked."""
    with pytest.raises(ValueError, match="accepts only"):
        resolve_policy(
            get_profile("custom"),
            custom={"reorder_point": 500, "pack_size": 12},
            **BASE,
        )


@pytest.mark.parametrize(
    "params, match",
    [
        ({"safety_stock": -1}, "zero or more"),
        ({"coverage_days": 0}, "greater than zero"),
        ({"coverage_days": "soon"}, "must be a number"),
    ],
)
def test_custom_policy_validates_its_parameters(params, match):
    with pytest.raises(ValueError, match=match):
        resolve_policy(get_profile("custom"), custom=params, **BASE)


def test_a_preset_refuses_custom_parameters_rather_than_ignoring_them():
    """Silently dropping them would let the UI print a number never used."""
    with pytest.raises(ValueError, match="fixed policy and takes no custom"):
        resolve_policy(get_profile("current"), custom={"safety_stock": 9999}, **BASE)


def test_no_parameters_at_all_resolves_to_the_standard_rule():
    resolved = resolve_policy(get_profile("current"), custom=None, **BASE)
    assert resolved.safety_stock == 20.0
    assert resolved.order_up_to == 70.0


def test_profile_can_be_passed_as_an_object_not_only_a_key():
    assert resolve_policy(POLICY_PROFILES["aggressive"], **BASE).safety_stock == 10.0


# ---------------------------------------------------------------------------
# Replenishment mechanics in the replay
# ---------------------------------------------------------------------------


BASE_DAY = pd.Timestamp("2026-01-01")


def _day(offset, *, lead_demand, daily=10.0, total=300.0, demand=10):
    """One prepared forecast row, `offset` days into the simulated window."""
    return pd.DataFrame(
        {
            "date": [BASE_DAY + pd.Timedelta(days=offset)],
            "demand": [demand],
            "xgb_daily_forecast": [daily],
            "xgb_lead_time_demand": [lead_demand],
            "xgb_total_forecast": [total],
            "baseline_daily_forecast": [daily],
            "baseline_lead_time_demand": [lead_demand],
            "baseline_total_forecast": [total],
        }
    )


def _days(lead_demand, count=1, **kwargs):
    """`count` consecutive days, all forecasting the same lead-time demand."""
    return pd.concat(
        [_day(i, lead_demand=lead_demand, **kwargs) for i in range(count)],
        ignore_index=True,
    )


def test_replay_orders_lead_time_demand_plus_safety_stock_not_the_30_day_total():
    """The core correction: the order target is not the 30-day forecast."""
    result = run_policy_replay(
        _days(50.0),
        starting_stock=0,
        safety_stock=20.0,
        lead_time_days=5,
    )
    row = result.iloc[0]

    assert row["reorder_point"] == 70.0
    assert row["target_inventory"] == 70.0
    # The 30-day figure is reported but must not size the order.
    assert row["total_forecast"] == 300.0
    assert row["order_qty"] == 70


def test_inventory_position_counts_open_orders():
    """The reorder trigger is measured on stock *plus* what is already on order."""
    result = run_policy_replay(
        _days(50.0, count=3),
        starting_stock=0,
        safety_stock=20.0,
        lead_time_days=5,
    )

    # Day 0: nothing on hand or on order, so the trigger fires and 70 go out.
    assert int(result.iloc[0]["closing_stock"]) == 0
    assert int(result.iloc[0]["inventory_position"]) == 0
    assert int(result.iloc[0]["order_qty"]) == 70
    # Day 1: still zero on hand, but 70 are already coming, so the position is
    # 70 and no second order is placed.
    assert int(result.iloc[1]["open_order_units"]) == 70
    assert int(result.iloc[1]["inventory_position"]) == 70
    assert int(result.iloc[1]["reorder_point"]) == 70
    assert int(result.iloc[1]["order_qty"]) == 0
    # The position is always exactly stock on hand plus stock on order.
    for row in result.to_dict("records"):
        assert int(row["inventory_position"]) == int(
            row["closing_stock"]
        ) + int(row["open_order_units"])


def test_purchase_orders_arrive_after_the_lead_time():
    result = run_policy_replay(
        _days(50.0, count=8),
        starting_stock=0,
        safety_stock=20.0,
        lead_time_days=5,
    )

    # Ordered on day 0 with a 5-day lead time, so nothing lands until day 5.
    assert int(result.iloc[0]["order_qty"]) == 70
    assert all(int(r["arrival_qty"]) == 0 for r in result.iloc[:5].to_dict("records"))
    assert int(result.iloc[5]["arrival_qty"]) == 70


def test_stockouts_are_recorded_when_demand_exceeds_available_stock():
    """Order on day 0, no stock, 5-day lead time: days 0-4 are all lost."""
    result = run_policy_replay(
        _days(50.0, count=8, demand=10),
        starting_stock=0,
        safety_stock=0.0,
        lead_time_days=5,
    )

    lost = int(result["stockout_units"].sum())
    fulfilled = int(result["units_fulfilled"].sum())
    demand_total = int(result["demand"].sum())

    # Nothing was available for the first five days, so all of it was lost.
    assert fulfilled + lost == demand_total
    assert int(result["stockout_units"].iloc[:5].sum()) == 50
    assert int((result["stockout_units"] > 0).sum()) == 5  # five stockout days
    assert lost == demand_total - fulfilled


def test_excess_inventory_is_measurable_as_stock_above_the_safety_buffer():
    result = run_policy_replay(
        _days(0.0, count=3, demand=1),
        starting_stock=100,
        safety_stock=10.0,
        lead_time_days=5,
    )

    buffer = float(result["safety_stock"].iloc[0])
    excess = float((result["closing_stock"] - buffer).clip(lower=0).mean())
    assert excess > 0
    # No order is placed at all when the position stays above the reorder point.
    assert int(result["order_qty"].sum()) == 0


def test_replay_is_deterministic():
    days = _days(50.0, count=5)
    kwargs = dict(starting_stock=10, safety_stock=20.0, lead_time_days=5)
    assert run_policy_replay(days, **kwargs).equals(run_policy_replay(days, **kwargs))


def test_replay_refuses_an_unknown_forecasting_method():
    with pytest.raises(ValueError, match="not a forecasting method"):
        run_policy_replay(
            _days(50.0),
            starting_stock=0,
            safety_stock=20.0,
            lead_time_days=5,
            method="crystal-ball",
        )


def test_replay_refuses_a_days_frame_missing_the_requested_forecast():
    only_baseline = _days(50.0)[["date", "demand", "baseline_daily_forecast"]]
    with pytest.raises(ValueError, match="missing 'xgb_daily_forecast'"):
        run_policy_replay(
            only_baseline,
            starting_stock=0,
            safety_stock=20.0,
            lead_time_days=5,
            method="xgboost",
        )


def test_conservative_actually_holds_more_stock_over_the_replay():
    """Not just different parameters on paper — a different inventory curve."""
    days = _days(20.0, count=6, demand=5)
    kwargs = dict(starting_stock=0, safety_stock=10.0, lead_time_days=5)
    current = run_policy_replay(days, profile="current", **kwargs)
    conservative = run_policy_replay(days, profile="conservative", **kwargs)

    assert conservative["reorder_point"].mean() > current["reorder_point"].mean()
    assert conservative["target_inventory"].mean() > current["target_inventory"].mean()
    assert int(conservative["order_qty"].sum()) > int(current["order_qty"].sum())
    # The demand series is the same for both, so the difference is the policy.
    assert list(current["demand"]) == list(conservative["demand"])
    assert list(current["total_forecast"]) == list(conservative["total_forecast"])


def test_aggressive_keeps_a_thinner_buffer_than_current():
    days = _days(20.0, count=6, demand=5)
    kwargs = dict(starting_stock=0, safety_stock=10.0, lead_time_days=5)
    current = run_policy_replay(days, profile="current", **kwargs)
    aggressive = run_policy_replay(days, profile="aggressive", **kwargs)

    assert float(aggressive["safety_stock"].iloc[0]) == 5.0
    assert float(aggressive["reorder_point"].iloc[0]) < float(
        current["reorder_point"].iloc[0]
    )


def test_custom_replay_uses_its_own_parameters():
    result = run_policy_replay(
        _days(20.0, count=4),
        starting_stock=0,
        safety_stock=10.0,
        lead_time_days=5,
        profile="custom",
        custom={"safety_stock": 100, "coverage_days": 3},
    )
    # 3 days x 10 units of forecast + the 100-unit buffer.
    assert float(result.iloc[0]["reorder_point"]) == 130.0
    assert float(result["safety_stock"].iloc[0]) == 100.0


def test_simulating_one_day_matches_simulating_the_same_single_day():
    """The single-day helper must not be a second implementation."""
    frame = pd.DataFrame(
        {
            "date": pd.date_range("2025-12-01", periods=40, freq="D"),
            "units_sold": [10] * 40,
        }
    )
    for column in ("product_id", "product_name", "category", "price"):
        frame[column] = "P1" if column == "product_id" else ("Widget" if column == "product_name" else ("General" if column == "category" else 100.0))

    window = run_backtest(
        product_history=frame,
        start_date=pd.Timestamp("2025-12-30"),
        end_date=pd.Timestamp("2025-12-31"),
        starting_stock=0,
        model=_constant_model(10.0),
        model_features=["lag_1"],
        safety_stock=10.0,
        lead_time_days=3,
    )

    from src.inventory.simulation import simulate_backtest_day

    orders = []
    day, order = simulate_backtest_day(
        current_date=pd.Timestamp("2025-12-30"),
        product_history=frame,
        current_stock=0,
        purchase_orders=orders,
        model=_constant_model(10.0),
        model_features=["lag_1"],
        safety_stock=10.0,
        lead_time_days=3,
    )
    assert int(window.iloc[0]["order_qty"]) == int(day["order_qty"])
    assert int(window.iloc[0]["reorder_point"]) == int(day["reorder_point"])
    assert order is not None


class _constant_model:
    """Stands in for the trained XGBoost model in unit tests."""

    def __init__(self, value):
        self.value = value

    def predict(self, frame):
        return [self.value] * len(frame)


def test_preparing_the_forecast_produces_one_row_per_day():
    frame = pd.DataFrame(
        {
            "date": pd.date_range("2025-12-01", periods=40, freq="D"),
            "units_sold": [10] * 40,
        }
    )
    for column, value in (
        ("product_id", "P1"),
        ("product_name", "Widget"),
        ("category", "General"),
        ("price", 100.0),
    ):
        frame[column] = value

    days = prepare_backtest_forecast(
        frame,
        pd.Timestamp("2025-12-20"),
        pd.Timestamp("2025-12-25"),
        model=_constant_model(12.0),
        model_features=["lag_1"],
        lead_time_days=3,
    )
    assert len(days) == 6
    assert float(days["xgb_lead_time_demand"].iloc[0]) == 36.0  # 3 x 12
    assert float(days["xgb_total_forecast"].iloc[0]) == 360.0   # 30 x 12
    # The baseline arm is a 7-day moving average of the recorded 10s.
    assert float(days["baseline_daily_forecast"].iloc[0]) == 10.0
    assert float(days["baseline_lead_time_demand"].iloc[0]) == 30.0


def test_the_forecast_is_identical_across_policies():
    """One pass, many policies: the demand series cannot depend on the policy."""
    frame = pd.DataFrame(
        {
            "date": pd.date_range("2025-12-01", periods=40, freq="D"),
            "units_sold": [8, 11] * 20,
        }
    )
    for column, value in (
        ("product_id", "P1"),
        ("product_name", "Widget"),
        ("category", "General"),
        ("price", 100.0),
    ):
        frame[column] = value

    kwargs = dict(
        product_history=frame,
        start_date=pd.Timestamp("2025-12-20"),
        end_date=pd.Timestamp("2025-12-25"),
        starting_stock=0,
        model=_constant_model(9.0),
        model_features=["lag_1"],
        safety_stock=10.0,
        lead_time_days=3,
    )
    runs = {
        key: run_backtest(profile=key, **kwargs) for key in COMPARABLE_POLICY_KEYS
    }
    forecasts = {tuple(r["total_forecast"]) for r in runs.values()}
    assert len(forecasts) == 1


# ---------------------------------------------------------------------------
# The moving-average arm
#
# The baseline replay is the one arm that uses no trained model, and it is the
# arm the V1 endpoint reaches. Splitting the forecast out of the replay left it
# passing a `model` it never had, which turned every V1 backtest into a 500
# while the V2 tests stayed green — the V2 suite never called this function.
# ---------------------------------------------------------------------------


def _history(units: list[int]) -> pd.DataFrame:
    frame = pd.DataFrame(
        {
            "date": pd.date_range("2025-12-01", periods=len(units), freq="D"),
            "units_sold": units,
        }
    )
    for column, value in (
        ("product_id", "P1"),
        ("product_name", "Widget"),
        ("category", "General"),
        ("price", 100.0),
    ):
        frame[column] = value
    return frame


def test_the_baseline_replay_runs_without_a_trained_model():
    """The moving average is arithmetic; it must not require a model argument."""
    window = run_baseline_backtest(
        product_history=_history([10] * 40),
        start_date=pd.Timestamp("2025-12-20"),
        end_date=pd.Timestamp("2025-12-25"),
        starting_stock=40,
        safety_stock=10.0,
        lead_time_days=3,
    )
    assert len(window) == 6
    assert "order_qty" in window.columns
    # 10 units a day, a 3-day lead time and a 10-unit buffer: reorder below 40.
    assert float(window["reorder_point"].iloc[0]) == 40.0


def test_the_baseline_replay_uses_the_same_replenishment_rule():
    """Order-up-to is the reorder point, not the 30-day forecast total."""
    window = run_baseline_backtest(
        product_history=_history([10] * 40),
        start_date=pd.Timestamp("2025-12-20"),
        end_date=pd.Timestamp("2025-12-25"),
        starting_stock=0,
        safety_stock=10.0,
        lead_time_days=3,
    )
    # The 30-day total is 300 units and is reported, but no order may be sized
    # from it; every order is a top-up to the reorder point.
    assert float(window["total_forecast"].iloc[0]) == 300.0
    assert (window["order_qty"] <= window["reorder_point"]).all()


def test_the_baseline_replay_still_applies_a_policy():
    """A policy is a policy whichever forecasting arm it is replayed with."""
    kwargs = dict(
        product_history=_history([10] * 40),
        start_date=pd.Timestamp("2025-12-20"),
        end_date=pd.Timestamp("2025-12-25"),
        starting_stock=0,
        safety_stock=10.0,
        lead_time_days=3,
    )
    current = run_baseline_backtest(profile="current", **kwargs)
    conservative = run_baseline_backtest(profile="conservative", **kwargs)
    # 1.5x a 10-unit buffer: the conservative arm reorders 5 units later.
    assert float(conservative["safety_stock"].iloc[0]) == 15.0
    assert float(conservative["reorder_point"].iloc[0]) == 45.0
    assert float(current["reorder_point"].iloc[0]) == 40.0


def test_the_baseline_replay_honours_its_window_argument():
    """The moving-average window is part of the arm's definition, not a default.

    Dropping it would silently make every baseline forecast a 7-day average
    while the signature still advertised a choice.
    """
    # A week of 10s then a week of 20s. A 7-day average on the first simulated
    # day sees only the 10s; a 21-day average sees both weeks.
    units = [10] * 7 + [20] * 7 + [10] * 21
    frame = _history(units)
    wide = run_baseline_backtest(
        product_history=frame,
        start_date=pd.Timestamp("2025-12-29"),
        end_date=pd.Timestamp("2025-12-29"),
        starting_stock=100,
        safety_stock=0.0,
        lead_time_days=1,
        forecast_window=21,
    )
    narrow = run_baseline_backtest(
        product_history=frame,
        start_date=pd.Timestamp("2025-12-29"),
        end_date=pd.Timestamp("2025-12-29"),
        starting_stock=100,
        safety_stock=0.0,
        lead_time_days=1,
        forecast_window=7,
    )
    assert float(wide["daily_forecast"].iloc[0]) != float(narrow["daily_forecast"].iloc[0])


def test_preparing_a_baseline_only_forecast_needs_no_model():
    days = prepare_backtest_forecast(
        _history([10] * 40),
        pd.Timestamp("2025-12-20"),
        pd.Timestamp("2025-12-22"),
        lead_time_days=3,
        methods=("baseline",),
    )
    assert list(days["baseline_daily_forecast"].unique()) == [10.0]
    # Only the requested arm is produced, so no XGBoost column is fabricated.
    assert "xgb_daily_forecast" not in days.columns


def test_preparing_an_xgboost_forecast_still_refuses_a_missing_model():
    """The guard names what is missing instead of failing inside the loop."""
    with pytest.raises(ValueError, match="model"):
        prepare_backtest_forecast(
            _history([10] * 40),
            pd.Timestamp("2025-12-20"),
            pd.Timestamp("2025-12-22"),
            lead_time_days=3,
            methods=("xgboost",),
        )


# ---------------------------------------------------------------------------
# The API surface: one product, real policies
# ---------------------------------------------------------------------------


PRODUCT = {
    "product_id": "P1",
    "product_name": "Widget",
    "category": "General",
    "unit_cost": 100.0,
    "current_stock": 0,
    "lead_time_days": 3,
}

HISTORY_START = pd.Timestamp("2025-09-01")


def _workspace_with_history(tenant="sim-user", days=60):
    """A tenant with enough recorded demand for a backtest to run.

    The engine reserves a 28-day lead-in before the window, so the series has
    to be longer than the window it will replay.
    """
    ws = TenantWorkspace(tenant)
    ws.add_product(dict(PRODUCT))
    ws.upsert_sales_rows([
        {
            "product_id": "P1",
            "date": (HISTORY_START + pd.Timedelta(days=index)).date().isoformat(),
            "units_sold": 8 + (index % 5),
            "price": 100.0,
        }
        for index in range(days)
    ])
    return ws


def test_backtest_is_scoped_to_one_product():
    ws = _workspace_with_history()
    result = ws.backtest("P1")
    assert result["scope"] == "single_product"
    assert result["product_id"] == "P1"
    assert result["duration_days"] > 0


def test_backtest_rejects_an_unknown_policy_key():
    ws = _workspace_with_history()
    with pytest.raises(ValueError, match="not a supported inventory policy"):
        ws.backtest("P1", policy="vibes")


def test_backtest_rejects_custom_parameters_a_preset_does_not_accept():
    """A preset must not silently accept a custom value it never applied."""
    ws = _workspace_with_history()
    with pytest.raises(ValueError, match="fixed policy"):
        ws.backtest("P1", policy="current", policy_params={"pack_size": 12})


def test_backtest_reports_the_effective_policy_values():
    ws = _workspace_with_history()
    result = ws.backtest("P1", policy="conservative")

    policy = result["policy"]
    assert policy["key"] == "conservative"
    assert policy["label"]
    assert policy["description"]
    assert policy["safety_stock"] > result["safety_stock"]
    assert policy["average_reorder_point"] > 0
    assert policy["average_order_up_to"] > 0


def test_backtest_compares_the_three_standard_policies():
    ws = _workspace_with_history()
    result = ws.backtest("P1")

    keys = [row["key"] for row in result["policy_comparison"]]
    assert keys == list(COMPARABLE_POLICY_KEYS)
    for row in result["policy_comparison"]:
        assert row["stockout_days"] >= 0
        assert 0 <= row["service_level"] <= 100
        assert row["average_inventory"] >= 0
        assert row["excess_inventory"] >= 0
        assert row["number_of_orders"] >= 0
        assert row["total_inventory_cost"] >= 0

    # Conservative keeps more stock, so it must hold more on average.
    by_key = {row["key"]: row for row in result["policy_comparison"]}
    assert (
        by_key["conservative"]["average_inventory"]
        >= by_key["aggressive"]["average_inventory"]
    )


def test_backtest_policies_run_against_the_same_forecast():
    """Like-for-like: only the policy differs between the three columns."""
    ws = _workspace_with_history()
    result = ws.backtest("P1")
    # Same starting stock and same length for every column.
    assert result["starting_stock"] > 0
    assert result["duration_days"] == len(result["daily_trajectory"])


def test_backtest_policy_comparison_changes_with_the_selected_policy():
    ws = _workspace_with_history()
    current = ws.backtest("P1", policy="current")
    conservative = ws.backtest("P1", policy="conservative")
    # The same three columns are always compared; only the *selected* policy
    # changes which replay the main metrics came from.
    assert [r["key"] for r in current["policy_comparison"]] == [
        r["key"] for r in conservative["policy_comparison"]
    ]
    assert current["policy"]["key"] == "current"
    assert conservative["policy"]["key"] == "conservative"


def test_backtest_method_comparison_runs_under_one_policy():
    """The XGBoost/moving-average arms share the selected policy."""
    ws = _workspace_with_history()
    result = ws.backtest("P1", policy="aggressive")

    trajectory = result["daily_trajectory"]
    assert len(trajectory) > 0
    # Both arms recorded their reorder point on the same days.
    assert all(
        "xgb_reorder_point" in point and "baseline_reorder_point" in point
        for point in trajectory
    )


def test_backtest_exposes_what_the_ui_needs_to_explain_itself():
    ws = _workspace_with_history()
    result = ws.backtest("P1")

    assert {p["key"] for p in result["available_policies"]} == set(policy_keys())
    assert set(result["custom_parameters"]) == set(CUSTOM_PARAM_FIELDS)
    for text in result["custom_parameters"].values():
        assert text


def test_backtest_trajectory_reports_in_transit_stock():
    ws = _workspace_with_history()
    result = ws.backtest("P1")
    for point in result["daily_trajectory"]:
        assert point["xgb_open_order_units"] >= 0
        assert point["baseline_open_order_units"] >= 0
        assert (
            point["xgb_inventory_position"]
            == point["xgb_closing_stock"] + point["xgb_open_order_units"]
        )


def test_backtest_is_deterministic():
    ws = _workspace_with_history()
    first = ws.backtest("P1", policy="conservative")
    second = ws.backtest("P1", policy="conservative")

    assert first["xgb_metrics"] == second["xgb_metrics"]
    assert first["policy_comparison"] == second["policy_comparison"]
    assert first["daily_trajectory"] == second["daily_trajectory"]


def test_a_custom_policy_changes_the_replay_not_just_the_label():
    ws = _workspace_with_history()
    default = ws.backtest("P1")
    custom = ws.backtest(
        "P1",
        policy="custom",
        policy_params={"safety_stock": default["safety_stock"] * 4, "coverage_days": 10},
    )
    assert custom["policy"]["key"] == "custom"
    assert custom["policy"]["coverage_days"] == 10.0
    assert custom["policy"]["average_order_up_to"] > default["policy"]["average_order_up_to"]


def test_a_product_with_no_history_cannot_be_backtested():
    ws = TenantWorkspace("sim-empty")
    ws.add_product(dict(PRODUCT))
    with pytest.raises(ValueError, match="no sales history"):
        ws.backtest("P1")


def test_another_tenants_product_is_not_reachable():
    ws = _workspace_with_history()
    other = TenantWorkspace("sim-other")
    other.add_product({**PRODUCT, "product_id": "THEIRS"})
    with pytest.raises(Exception):
        ws.backtest("THEIRS")


# ---------------------------------------------------------------------------
# The HTTP surface
# ---------------------------------------------------------------------------


SECRET = "sim-" + secrets.token_urlsafe(48)
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


class _StubModel:
    """A stand-in for the trained XGBoost model.

    The policy rules under test do not depend on the forecast's *accuracy* —
    only on it being the same series across policies — so a constant forecast
    keeps these tests to a few seconds instead of training a real model per
    backtest. `test_the_forecast_is_identical_across_policies` is what pins the
    like-for-like property this relies on.
    """

    def predict(self, frame):
        return [10.0] * len(frame)


@pytest.fixture(autouse=True)
def jwt_environment(monkeypatch):
    monkeypatch.setenv("APP_ENV", "test")
    monkeypatch.setenv("USE_SUPABASE", "false")
    monkeypatch.setenv("AUTH_MODE", "jwt")
    monkeypatch.setenv("JWT_SECRET", SECRET)
    monkeypatch.setenv("JWT_CLOCK_SKEW_SECONDS", "0")
    monkeypatch.setenv("JWT_USER_ID_CLAIM", "sub")
    monkeypatch.setattr(v2, "_WORKSPACES", {})
    from backend import main as backend_main

    monkeypatch.setattr(
        backend_main,
        "get_service",
        lambda: type("_S", (), {"model": _StubModel()})(),
    )


def _api(ws, body, user="sim-user"):
    v2._WORKSPACES[user] = ws
    ws.remote_hydrated = True
    return client.post(
        f"/api/v2/simulation/backtest?user_id={user}",
        json=body,
        headers={"Authorization": f"Bearer {_token(user)}"},
    )


def test_the_api_runs_one_product():
    response = _api(_workspace_with_history(), {"product_id": "P1"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["scope"] == "single_product"
    assert body["product_id"] == "P1"


def test_the_api_refuses_a_product_list():
    """A wider scope must fail loudly rather than simulate one of the products."""
    response = _api(_workspace_with_history(), {"product_id": ["P1", "P2"]})
    assert response.status_code == 422


def test_the_api_refuses_an_unknown_policy():
    response = _api(
        _workspace_with_history(), {"product_id": "P1", "policy": "vibes"}
    )
    assert response.status_code == 422
    assert "not a supported inventory policy" in response.text


def test_the_api_defaults_to_the_current_policy():
    response = _api(_workspace_with_history(), {"product_id": "P1"})
    assert response.json()["policy"]["key"] == "current"


@pytest.mark.parametrize("policy", ["current", "conservative", "aggressive"])
def test_the_api_runs_each_standard_policy(policy):
    response = _api(
        _workspace_with_history(), {"product_id": "P1", "policy": policy}
    )
    assert response.status_code == 200, response.text
    assert response.json()["policy"]["key"] == policy


def test_the_api_runs_a_custom_policy():
    response = _api(
        _workspace_with_history(),
        {
            "product_id": "P1",
            "policy": "custom",
            "policy_params": {"safety_stock": 200, "coverage_days": 12},
        },
    )
    assert response.status_code == 200, response.text
    policy = response.json()["policy"]
    assert policy["key"] == "custom"
    assert policy["safety_stock"] == 200.0
    assert policy["coverage_days"] == 12.0


def test_the_api_refuses_a_custom_parameter_it_does_not_apply():
    response = _api(
        _workspace_with_history(),
        {
            "product_id": "P1",
            "policy": "custom",
            "policy_params": {"reorder_point": 900},
        },
    )
    assert response.status_code == 422
    assert "accepts only" in response.text


def test_the_api_passes_custom_parameters_to_a_preset_and_it_fails():
    """Sending a custom value to a preset must not be silently ignored."""
    response = _api(
        _workspace_with_history(),
        {
            "product_id": "P1",
            "policy": "current",
            "policy_params": {"safety_stock": 5},
        },
    )
    assert response.status_code == 422
    assert "fixed policy" in response.text


def test_the_api_returns_the_explanations_the_ui_needs():
    body = _api(_workspace_with_history(), {"product_id": "P1"}).json()
    assert {row["key"] for row in body["available_policies"]} == {
        "current",
        "conservative",
        "aggressive",
        "custom",
    }
    for row in body["available_policies"]:
        assert row["label"] and row["description"]
    assert set(body["custom_parameters"]) == {"safety_stock", "coverage_days"}


def test_the_api_compares_three_policies_and_two_methods():
    body = _api(_workspace_with_history(), {"product_id": "P1"}).json()
    assert [row["key"] for row in body["policy_comparison"]] == [
        "current",
        "conservative",
        "aggressive",
    ]
    assert "xgb_metrics" in body and "baseline_metrics" in body
    # Both method arms ran over the same days.
    assert len(body["daily_trajectory"]) == body["duration_days"]


def test_the_api_response_is_audited_with_the_policy_actually_run():
    ws = _workspace_with_history()
    response = _api(ws, {"product_id": "P1", "policy": "aggressive"})
    assert response.status_code == 200
    entry = ws.audit[-1]
    assert entry.action == "simulation_backtested"
    assert entry.detail["policy"] == "aggressive"


# ---------------------------------------------------------------------------
# The V1 endpoint replays the same rule
#
# `backend/services.run_backtest_simulation` is a separate entry point that
# calls both arms directly. When the forecast pass was split out of the replay,
# the baseline call in here was left passing a `model` that no longer existed in
# its signature, and every V1 backtest became a 500. The V2 tests never noticed
# because they reach the replay through the tenant workspace instead.
# ---------------------------------------------------------------------------


def test_the_v1_service_replays_both_arms_over_one_window(monkeypatch):
    from backend import services as v1_services
    from backend.schemas import BacktestRequest

    # `EcomAIService` is a process-wide singleton, and its data frames are what
    # every V1 endpoint reads. The fixture below is only valid for this test, so
    # the real ones are restored afterwards — otherwise the V1 tests that run
    # next would find a catalog of one product.
    service = v1_services.EcomAIService()
    # Dates are datetimes, as the service leaves them after loading the CSV.
    history = pd.DataFrame(
        {
            "product_id": "P1",
            "product_name": "Widget",
            "category": "General",
            "price": 100.0,
            "date": [HISTORY_START + pd.Timedelta(days=index) for index in range(60)],
            "units_sold": [8 + (index % 5) for index in range(60)],
        }
    )
    # The service reads forecast error from a lookup the way it does in
    # production; a product with no entry there cannot be configured.
    monkeypatch.setattr(service, "sales_df", history)
    monkeypatch.setattr(service, "model", _constant_model(9.0))
    monkeypatch.setattr(
        service, "error_std_df", pd.DataFrame([{"product_id": "P1", "error_std": 4.2}])
    )

    result = service.run_backtest_simulation(
        BacktestRequest(
            product_id="P1",
            start_date="2025-09-20",
            end_date="2025-09-25",
        )
    )

    payload = result.model_dump() if hasattr(result, "model_dump") else result.dict()
    assert payload["duration_days"] == 6
    assert len(payload["daily_trajectory"]) == 6
    # Both arms replayed the same days, so the comparison is like-for-like and
    # neither arm is missing: the baseline is the one this bug emptied.
    for point in payload["daily_trajectory"]:
        assert point["xgb_closing_stock"] >= 0
        assert point["baseline_closing_stock"] >= 0
        assert point["xgb_order_qty"] >= 0
        assert point["baseline_order_qty"] >= 0
    # Both arms are scored, not just the XGBoost one.
    assert payload["baseline_metrics"]["number_of_orders"] is not None
    assert "recommended_strategy" in payload["cost_comparison"]


# ---------------------------------------------------------------------------
# The frontend vocabulary is pinned to the server's
# ---------------------------------------------------------------------------

FRONTEND_POLICY_MODULE = (
    Path(__file__).resolve().parents[1]
    / "frontend"
    / "src"
    / "services"
    / "simulationPolicy.js"
)


def _frontend_policy_source() -> str:
    """The frontend policy catalogue, or skip when the frontend is absent.

    A deployment that ships only the API still has one vocabulary -- the
    server's -- so the absence of the frontend bundle is not a failure of this
    contract.

    Adjacent string literals are joined before the text is read: the form wraps
    its long explanations across lines the way a formatter would, and the server
    sends them as one sentence.
    """

    if not FRONTEND_POLICY_MODULE.exists():
        pytest.skip("frontend sources are not part of this deployment")
    source = FRONTEND_POLICY_MODULE.read_text(encoding="utf-8")
    return re.sub(r"'\s*\+\s*'", "", source)


def test_the_frontend_offers_exactly_the_policies_the_server_accepts():
    source = _frontend_policy_source()
    for key in policy_keys():
        assert f"'{key}'" in source, f"the form never offers the {key!r} policy"


def test_the_frontend_repeats_the_servers_policy_labels_and_descriptions():
    """One vocabulary, not two.

    The form has to offer the policies before any run has happened, so it carries
    its own copy of the labels. A rename on either side would then leave the page
    offering "Conservative" while the server resolved and reported something
    else, which is the drift this test exists to stop.
    """

    source = _frontend_policy_source()
    for profile in describe_profiles():
        assert profile["label"] in source, f"missing label for {profile['key']!r}"
        assert profile["description"] in source, (
            f"missing description for {profile['key']!r}"
        )


def test_the_frontend_mirrors_the_policy_multipliers_it_replays():
    """The demo engine reads these; the server is still the authority.

    `simulationService.js` replays the same rule in the browser when there is no
    backend to call, using the multipliers held in the frontend catalogue. If
    they drift from the server's, a demo run quietly contradicts a real one, so
    the numbers are pinned rather than left to two independent edits.
    """

    source = _frontend_policy_source()
    assert f"safetyMultiplier: {CONSERVATIVE_SAFETY_MULTIPLIER}" in source
    assert f"safetyMultiplier: {AGGRESSIVE_SAFETY_MULTIPLIER}" in source
    # Coverage stays on the supplier lead time under every preset, which is what
    # keeps the presets a change in buffer size and nothing else.
    assert source.count("coverageMultiplier: 1") == len(POLICY_PROFILES)


def test_the_frontend_repeats_the_servers_custom_field_explanations():
    source = _frontend_policy_source()
    for name, hint in describe_custom_fields().items():
        assert f"'{name}'" in source
        assert hint in source, f"the form's {name!r} explanation has drifted"


def test_the_frontend_exposes_only_the_supported_custom_fields():
    source = _frontend_policy_source()
    for name in CUSTOM_PARAM_FIELDS:
        assert f"'{name}'" in source
    # A third knob the form offered would be ignored by the server and then
    # reported on the results panel as though it had been simulated.
    assert "min_stock" not in source
    assert "reorder_point" not in source
