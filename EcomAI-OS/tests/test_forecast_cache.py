"""Tests for the per-workspace demand-forecast memo.

Every dashboard render calls :meth:`TenantWorkspace.demand_forecast` from four
different read surfaces (inventory overview, stockout projection, recommendation
rows, portfolio forecast), and each call recomputes the full recursive XGBoost
series. The memo caches one payload per ``(product, horizon)``, stamped by the
product's sales/product write versions, so:

* a cache hit returns a deep copy (callers may mutate what they receive),
* editing one product's rows invalidates exactly that product's entries,
* one tenant can never observe another tenant's cached numbers,
* ``audit=True`` decisions are always computed fresh and always recorded.

These tests drive the real forecaster and assert that outputs are identical
whether served from the memo or computed fresh, while a counting wrapper on the
ML adapter proves how many times the model actually ran.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import date, timedelta
import threading

import pytest

import backend.tenant as tenant_module
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


def _workspace(user, products=None, *, days=200, volumes=None):
    """A tenant workspace whose products all carry >=180 days of history.

    That crosses the forecaster's ``preferred_range``, so every product runs
    the real XGBoost model rather than a labeled baseline — the unit of work
    the memo is meant to avoid repeating.
    """
    products = products or [_product()]
    volumes = volumes or [5] * len(products)
    ws = TenantWorkspace(user)
    ws.add_products(products)
    rows = []
    for index, day in enumerate(_days(days)):
        for product, volume in zip(products, volumes):
            rows.append({
                "product_id": product["product_id"],
                "date": day,
                "units_sold": volume + (index % 7),
                "price": product.get("unit_price", 12.0),
                "category": product["category"],
                "promotion": False,
            })
    ws.upsert_sales_rows(rows)
    return ws


@pytest.fixture
def ml_counter(monkeypatch):
    """Count how many times ``_ml_forecast`` actually runs a series forecast."""
    counter = {"n": 0}
    original = tenant_module._ml_forecast

    def counting(history, *, horizon=None):
        counter["n"] += 1
        return original(history, horizon=horizon)

    monkeypatch.setattr(tenant_module, "_ml_forecast", counting)
    return counter


# ---------------------------------------------------------------------------
# Cache hits
# ---------------------------------------------------------------------------

def test_repeated_calls_share_one_computation(ml_counter):
    ws = _workspace("cache-hit")
    first = ws.demand_forecast("P1", horizon=30)
    assert ml_counter["n"] == 1

    second = ws.demand_forecast("P1", horizon=30)
    defaulted = ws.demand_forecast("P1")  # horizon None -> FORECAST_HORIZON (30)
    assert second == first
    assert defaulted == first
    assert ml_counter["n"] == 1


def test_horizon_clamping_maps_to_one_key(ml_counter):
    ws = _workspace("clamp")
    clamped = ws.demand_forecast("P1", horizon=240)  # clamped to 180
    explicit = ws.demand_forecast("P1", horizon=180)
    assert clamped == explicit
    assert ml_counter["n"] == 1


def test_memo_payload_is_identical_to_a_fresh_compute(ml_counter):
    """Unchanged-output guarantee: memo hits equal a from-scratch run."""
    ws_a = _workspace("memo-a", volumes=[7])
    ws_b = _workspace("memo-b", volumes=[7])
    hit = ws_a.demand_forecast("P1", horizon=30)
    again = ws_a.demand_forecast("P1", horizon=30)
    fresh = ws_b.demand_forecast("P1", horizon=30)
    assert again == hit
    assert fresh == hit
    assert ml_counter["n"] == 2  # one computation per workspace, none repeated


# ---------------------------------------------------------------------------
# Cross-endpoint reuse
# ---------------------------------------------------------------------------

def test_inventory_recommendations_portfolio_reuse_the_memo(ml_counter):
    ws = _workspace("cross-endpoint")
    # Warm exactly the horizons the dashboard endpoints request.
    ws.demand_forecast("P1", horizon=7)
    ws.demand_forecast("P1")  # horizon 30
    computed = ml_counter["n"]

    ws.inventory_overview()
    ws.recommendations()
    ws.portfolio_forecast(horizon=7)

    assert ml_counter["n"] == computed
    assert ("P1", 7) in ws._forecast_cache
    assert ("P1", 30) in ws._forecast_cache


# ---------------------------------------------------------------------------
# Invalidation
# ---------------------------------------------------------------------------

def test_sales_change_invalidates_only_the_affected_product(ml_counter):
    ws = _workspace(
        "invalidate-sales",
        products=[_product(), _product(product_id="P2", product_name="Gadget")],
    )
    p1_before = ws.demand_forecast("P1", horizon=30)
    p2_before = ws.demand_forecast("P2", horizon=30)
    assert ml_counter["n"] == 2

    # New sales shift P1's history (same-day overwrite + one later day).
    last = START + timedelta(days=199)
    ws.upsert_sales_rows([
        {
            "product_id": "P1",
            "date": last.isoformat(),
            "units_sold": 500,
            "price": 12.0,
            "category": "Electronics",
            "promotion": False,
        },
        {
            "product_id": "P1",
            "date": (last + timedelta(days=1)).isoformat(),
            "units_sold": 600,
            "price": 12.0,
            "category": "Electronics",
            "promotion": False,
        },
    ])

    p1_after = ws.demand_forecast("P1", horizon=30)
    p2_still_cached = ws.demand_forecast("P2", horizon=30)

    assert ml_counter["n"] == 3      # only P1 recomputed
    assert p1_after != p1_before     # its inputs changed
    assert p2_still_cached == p2_before


def test_product_update_invalidates_its_forecast(ml_counter):
    ws = _workspace("invalidate-product")
    first = ws.demand_forecast("P1", horizon=30)
    assert first["product_name"] == "Widget"
    ws.update_product("P1", {"product_name": "Renamed Widget"})
    second = ws.demand_forecast("P1", horizon=30)
    assert second["product_name"] == "Renamed Widget"
    assert ml_counter["n"] == 2


def test_deleted_product_prunes_its_memo_and_never_resurrects_it(ml_counter):
    ws = _workspace(
        "delete-prune",
        products=[_product(), _product(product_id="P2", product_name="Gadget")],
    )
    ws.demand_forecast("P1", horizon=30)
    ws.demand_forecast("P2", horizon=30)
    assert ("P1", 30) in ws._forecast_cache
    assert ("P2", 30) in ws._forecast_cache
    stale_p2_payload = ws._forecast_cache[("P2", 30)][1]

    ws.delete_product("P2")
    assert not any(key[0] == "P2" for key in ws._forecast_cache)
    with pytest.raises(tenant_module.TenantIsolationError):
        ws.demand_forecast("P2", horizon=30)

    # Re-adding the same id must start with a fresh memo, not the old numbers.
    ws.add_product(_product(product_id="P2", product_name="Gadget v2"))
    ws.upsert_sales_rows([
        {
            "product_id": "P2",
            "date": (START + timedelta(days=500 + offset)).isoformat(),
            "units_sold": 6,
            "price": 20.0,
            "category": "Electronics",
            "promotion": False,
        }
        for offset in range(30)
    ])
    revived = ws.demand_forecast("P2", horizon=30)
    assert revived["product_name"] == "Gadget v2"
    assert ws._forecast_cache[("P2", 30)][1] != stale_p2_payload
    assert revived == ws.demand_forecast("P2", horizon=30)  # now cached itself


# ---------------------------------------------------------------------------
# Tenant isolation
# ---------------------------------------------------------------------------

def test_tenant_isolation_never_shares_cached_forecasts(ml_counter):
    ws_a = _workspace("iso-a", volumes=[5])
    ws_b = _workspace("iso-b", volumes=[500])
    fc_a = ws_a.demand_forecast("P1", horizon=30)
    fc_b = ws_b.demand_forecast("P1", horizon=30)

    assert fc_a["total"] != fc_b["total"]
    assert ws_a._forecast_cache is not ws_b._forecast_cache
    assert ws_a._forecast_cache[("P1", 30)][1]["total"] == fc_a["total"]
    assert ws_b._forecast_cache[("P1", 30)][1]["total"] == fc_b["total"]
    assert ml_counter["n"] == 2

    # Warming ws_a further must not leak an entry into ws_b.
    _ = ws_a.demand_forecast("P1", horizon=7)
    assert ("P1", 7) not in ws_b._forecast_cache


# ---------------------------------------------------------------------------
# Mutable / concurrent safety
# ---------------------------------------------------------------------------

def test_cache_hits_return_copies_not_shared_mutable_state(ml_counter):
    ws = _workspace("mutable-safety")
    first = ws.demand_forecast("P1", horizon=30)
    snapshot = deepcopy(first)

    # A caller mutates everything it can reach on the returned object.
    first["points"] = []
    first["actuals"].append({"date": "2025-12-31", "units": 1})
    first["total"] = -999.0
    first["eligibility"]["eligible"] = False

    second = ws.demand_forecast("P1", horizon=30)
    assert second == snapshot
    assert ws._forecast_cache[("P1", 30)][1] == snapshot
    assert ml_counter["n"] == 1


def test_audited_forecasts_bypass_the_memo_and_still_record(ml_counter):
    ws = _workspace("audit-path")
    read = ws.demand_forecast("P1", horizon=30, audit=False)
    assert ml_counter["n"] == 1
    audit_before = len(ws.audit)

    decided = ws.demand_forecast("P1", horizon=30, audit=True)
    assert ml_counter["n"] == 2          # recomputed, never served from the memo
    assert decided == read               # identical payload, just audited
    assert len(ws.audit) == audit_before + 1
    assert ws.audit[-1].action == "forecast_generated"

    # Subsequent read paths still hit the memo.
    again = ws.demand_forecast("P1", horizon=30)
    assert ml_counter["n"] == 2
    assert again == decided


def test_concurrent_reads_are_safe_and_consistent(ml_counter):
    ws = _workspace("concurrent")
    results: list = []
    errors: list = []
    barrier = threading.Barrier(8)

    def _worker():
        try:
            barrier.wait(timeout=30)
            results.append(ws.demand_forecast("P1", horizon=30))
        except Exception as exc:  # noqa: BLE001 - surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=_worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=120)

    assert not errors
    assert len(results) == 8
    assert all(result == results[0] for result in results)
    assert ("P1", 30) in ws._forecast_cache
    assert ws._forecast_cache[("P1", 30)][1] == results[0]
    assert ml_counter["n"] >= 1