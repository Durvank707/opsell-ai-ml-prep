import pandas as pd
import pytest

from src.evaluation.metrics import (
    calculate_mae,
    calculate_inventory_metrics,
    calculate_financial_metrics,
    compare_inventory_strategies,
)


def test_calculate_mae():
    y_true = [10, 20, 30]
    y_pred = [12, 18, 33]
    # |10-12| + |20-18| + |30-33| = 2 + 2 + 3 = 7 / 3 = 2.3333...
    assert pytest.approx(calculate_mae(y_true, y_pred), 0.01) == 2.33


def test_calculate_inventory_metrics_operational():
    dates = pd.date_range("2026-01-01", periods=5, freq="D")
    results = pd.DataFrame({
        "date": dates,
        "demand": [20, 25, 30, 20, 15],
        "units_fulfilled": [20, 25, 20, 0, 15],
        "stockout_units": [0, 0, 10, 20, 0],
        "closing_stock": [30, 15, 0, 0, 40],
        "order_qty": [0, 0, 50, 0, 0],
    })

    metrics = calculate_inventory_metrics(results)
    assert metrics["total_demand"] == 110
    assert metrics["total_fulfilled"] == 80
    assert metrics["lost_sales_units"] == 30
    assert metrics["stockout_days"] == 2
    assert metrics["number_of_orders"] == 1
    assert metrics["total_units_ordered"] == 50
    assert pytest.approx(metrics["service_level"], 0.1) == 72.73
    assert metrics["average_inventory"] == 17.0
    assert metrics["maximum_inventory"] == 40.0


def test_calculate_financial_metrics():
    dates = pd.date_range("2026-01-01", periods=365, freq="D")
    results = pd.DataFrame({
        "date": dates,
        "demand": [10] * 365,
        "units_fulfilled": [10] * 365,
        "stockout_units": [0] * 365,
        "closing_stock": [100] * 365,
        "order_qty": [100 if i % 30 == 0 else 0 for i in range(365)],
    })

    # Avg stock = 100, unit cost = 1000, holding rate = 20%, 365 days
    # Holding cost = 100 * 1000 * 0.20 * (365 / 365) = 20,000
    # Number of orders = 13
    # Ordering cost = 13 * 500 = 6,500
    # Stockout cost = 0
    financials = calculate_financial_metrics(
        results,
        unit_cost=1000,
        holding_cost_rate=0.20,
        ordering_cost_per_order=500,
        stockout_cost_per_unit=1000,
    )

    assert financials["holding_cost"] == 20000.0
    assert financials["ordering_cost"] == 6500.0
    assert financials["stockout_cost"] == 0.0
    assert financials["total_inventory_cost"] == 26500.0


def test_compare_inventory_strategies():
    dates = pd.date_range("2026-01-01", periods=30, freq="D")
    
    # Strategy A: Lean, slight stockout
    res_a = pd.DataFrame({
        "date": dates,
        "demand": [20] * 30,
        "units_fulfilled": [19] * 30,
        "stockout_units": [1] * 30, # 30 lost sales
        "closing_stock": [10] * 30, # lean average stock
        "order_qty": [20] * 30,
    })

    # Strategy B: Heavy buffer, zero stockouts
    res_b = pd.DataFrame({
        "date": dates,
        "demand": [20] * 30,
        "units_fulfilled": [20] * 30,
        "stockout_units": [0] * 30,
        "closing_stock": [200] * 30, # high holding cost
        "order_qty": [20] * 30,
    })

    comparison = compare_inventory_strategies(
        strategy_a_name="LeanXGB",
        strategy_b_name="BufferMA",
        strategy_a_results=res_a,
        strategy_b_results=res_b,
        unit_cost=2000,
        stockout_cost_per_unit=100, # low penalty
    )

    assert "LeanXGB" in comparison
    assert "BufferMA" in comparison
    assert "recommended_strategy" in comparison
    assert comparison["expected_savings"] >= 0
