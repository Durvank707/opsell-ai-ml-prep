import pandas as pd
import numpy as np
import pytest

from src.inventory.safety_stock import calculate_safety_stock
from src.inventory.reorder import calculate_reorder_point, should_reorder
from src.inventory.policy import calculate_target_inventory, calculate_recommended_order_qty
from src.inventory.risk import classify_stockout_risk
from src.inventory.simulation import process_daily_demand, calculate_inventory_position, PurchaseOrder


def test_calculate_safety_stock():
    # SS = ceil(1.645 * 5.0 * sqrt(4)) = ceil(1.645 * 5.0 * 2.0) = ceil(16.45) = 17
    ss = calculate_safety_stock(error_std=5.0, lead_time_days=4, z_score=1.645)
    assert ss == 17.0


def test_reorder_point_and_trigger():
    rop = calculate_reorder_point(lead_time_demand=100, safety_stock=20)
    assert rop == 120

    # Below ROP -> should reorder
    assert should_reorder(inventory_position=119, reorder_point=rop) is True
    # At or above ROP -> should not reorder
    assert should_reorder(inventory_position=120, reorder_point=rop) is False
    assert should_reorder(inventory_position=150, reorder_point=rop) is False


def test_calculate_recommended_order_qty_basic():
    target = 200.0
    pos = 80.0
    # Reorder triggered: target - pos = 120
    qty = calculate_recommended_order_qty(target_inventory=target, inventory_position=pos, reorder_required=True)
    assert qty == 120.0

    # Reorder NOT triggered
    qty_no_reorder = calculate_recommended_order_qty(target_inventory=target, inventory_position=pos, reorder_required=False)
    assert qty_no_reorder == 0.0


def test_calculate_recommended_order_qty_moq():
    target = 100.0
    pos = 85.0
    # Deficit is 15, but supplier MOQ is 50
    qty = calculate_recommended_order_qty(
        target_inventory=target,
        inventory_position=pos,
        reorder_required=True,
        moq=50,
    )
    assert qty == 50.0


def test_calculate_recommended_order_qty_pack_size():
    target = 100.0
    pos = 75.0
    # Deficit is 25, pack size is 12 -> ceil(25 / 12) * 12 = 36
    qty = calculate_recommended_order_qty(
        target_inventory=target,
        inventory_position=pos,
        reorder_required=True,
        pack_size=12,
    )
    assert qty == 36.0


def test_stockout_risk_classification():
    today = pd.Timestamp("2026-01-01")

    # 1. No stockout projected
    row_low = {"expected_stockout_date": pd.NaT, "expected_replenishment_date": pd.NaT}
    assert classify_stockout_risk(row_low) == "LOW"

    # 2. Stockout projected, replenishment arrives safely before
    row_replenish_before = {
        "expected_stockout_date": today + pd.Timedelta(days=10),
        "expected_replenishment_date": today + pd.Timedelta(days=5),
    }
    assert classify_stockout_risk(row_replenish_before) == "LOW"

    # 3. Replenishment arrives on the exact day of stockout
    row_replenish_same_day = {
        "expected_stockout_date": today + pd.Timedelta(days=5),
        "expected_replenishment_date": today + pd.Timedelta(days=5),
    }
    assert classify_stockout_risk(row_replenish_same_day) == "MEDIUM"

    # 4. Critical: Stockout occurs before replenishment arrives
    row_stockout_before_arrival = {
        "expected_stockout_date": today + pd.Timedelta(days=2),
        "expected_replenishment_date": today + pd.Timedelta(days=7),
    }
    assert classify_stockout_risk(row_stockout_before_arrival) == "HIGH"

    # 5. Stockout projected, but no replenishment in transit
    row_no_replenishment = {
        "expected_stockout_date": today + pd.Timedelta(days=3),
        "expected_replenishment_date": pd.NaT,
    }
    assert classify_stockout_risk(row_no_replenishment) == "HIGH"


def test_process_daily_demand():
    # Full fulfillment
    fulfilled, stockout, closing = process_daily_demand(available_stock=50, demand=30)
    assert fulfilled == 30
    assert stockout == 0
    assert closing == 20

    # Partial fulfillment with stockout
    fulfilled, stockout, closing = process_daily_demand(available_stock=10, demand=25)
    assert fulfilled == 10
    assert stockout == 15
    assert closing == 0

    # Zero stock
    fulfilled, stockout, closing = process_daily_demand(available_stock=0, demand=15)
    assert fulfilled == 0
    assert stockout == 15
    assert closing == 0
