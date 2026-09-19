import pandas as pd
from sklearn.metrics import mean_absolute_error


def calculate_mae(y_true, y_pred):
    """
    Calculate Mean Absolute Error.

    Parameters
    ----------
    y_true : array-like
        Actual target values.
    y_pred : array-like
        Predicted target values.

    Returns
    -------
    float
        Mean Absolute Error.
    """
    return mean_absolute_error(y_true, y_pred)



def calculate_inventory_metrics(results, unit_cost: float | None = None, **kwargs):
    """
    Calculate operational (and optionally financial) inventory metrics from simulation results.

    Parameters
    ----------
    results : pandas.DataFrame
        Daily inventory simulation results.
    unit_cost : float, optional
        Unit cost of the product. If provided, financial costs are computed.

    Returns
    -------
    dict
        Inventory operational and financial performance metrics.
    """

    total_demand = results["demand"].sum()
    total_fulfilled = results["units_fulfilled"].sum()
    lost_sales_units = results["stockout_units"].sum()

    service_level = (
        float(total_fulfilled / total_demand * 100)
        if total_demand > 0
        else 0.0
    )

    metrics = {
        "average_inventory": float(results["closing_stock"].mean()),
        "maximum_inventory": float(results["closing_stock"].max()),
        "total_units_ordered": int(results["order_qty"].sum()),
        "number_of_orders": int((results["order_qty"] > 0).sum()),
        "stockout_days": int((results["stockout_units"] > 0).sum()),
        "lost_sales_units": int(lost_sales_units),
        "total_demand": int(total_demand),
        "total_fulfilled": int(total_fulfilled),
        "service_level": round(service_level, 2),
    }

    if unit_cost is not None:
        financials = calculate_financial_metrics(
            results=results,
            unit_cost=unit_cost,
            **kwargs,
        )
        metrics.update(financials)

    return metrics


def calculate_financial_metrics(
    results,
    unit_cost: float,
    holding_cost_rate: float = 0.20,
    ordering_cost_per_order: float = 500.0,
    stockout_cost_per_unit: float = 1000.0,
) -> dict:
    """
    Calculate financial supply chain costs from simulation results.

    Parameters
    ----------
    results : pandas.DataFrame
        Daily inventory simulation results.
    unit_cost : float
        Unit cost of the product.
    holding_cost_rate : float, default=0.20
        Annual inventory holding cost rate (e.g., 20% per year).
    ordering_cost_per_order : float, default=500.0
        Fixed administrative/logistics cost per purchase order placed.
    stockout_cost_per_unit : float, default=1000.0
        Penalty/lost margin cost per unfulfilled unit of demand.

    Returns
    -------
    dict
        Breakdown of holding, ordering, stockout, and total inventory costs.
    """
    if "date" in results.columns and len(results) > 1:
        dates = pd.to_datetime(results["date"])
        duration_days = (dates.max() - dates.min()).days + 1
    else:
        duration_days = len(results)

    avg_inventory = float(results["closing_stock"].mean())
    num_orders = int((results["order_qty"] > 0).sum())
    lost_sales_units = float(results["stockout_units"].sum())

    holding_cost = (
        avg_inventory
        * unit_cost
        * holding_cost_rate
        * (duration_days / 365.0)
    )

    ordering_cost = num_orders * ordering_cost_per_order
    stockout_cost = lost_sales_units * stockout_cost_per_unit
    total_cost = holding_cost + ordering_cost + stockout_cost

    return {
        "unit_cost": float(unit_cost),
        "duration_days": int(duration_days),
        "holding_cost": round(holding_cost, 2),
        "ordering_cost": round(ordering_cost, 2),
        "stockout_cost": round(stockout_cost, 2),
        "total_inventory_cost": round(total_cost, 2),
    }


def compare_inventory_strategies(
    strategy_a_name: str,
    strategy_a_results,
    strategy_b_name: str,
    strategy_b_results,
    unit_cost: float,
    holding_cost_rate: float = 0.20,
    ordering_cost_per_order: float = 500.0,
    stockout_cost_per_unit: float = 1000.0,
) -> dict:
    """
    Compare two inventory replenishment strategies side-by-side on operational
    and financial KPIs.
    """
    cost_kwargs = dict(
        unit_cost=unit_cost,
        holding_cost_rate=holding_cost_rate,
        ordering_cost_per_order=ordering_cost_per_order,
        stockout_cost_per_unit=stockout_cost_per_unit,
    )

    metrics_a = calculate_inventory_metrics(strategy_a_results, **cost_kwargs)
    metrics_b = calculate_inventory_metrics(strategy_b_results, **cost_kwargs)

    cost_a = metrics_a["total_inventory_cost"]
    cost_b = metrics_b["total_inventory_cost"]

    if cost_a < cost_b:
        recommended = strategy_a_name
        savings = cost_b - cost_a
    elif cost_b < cost_a:
        recommended = strategy_b_name
        savings = cost_a - cost_b
    else:
        # Tie-breaker: higher service level
        recommended = (
            strategy_a_name
            if metrics_a["service_level"] >= metrics_b["service_level"]
            else strategy_b_name
        )
        savings = 0.0

    return {
        strategy_a_name: metrics_a,
        strategy_b_name: metrics_b,
        "recommended_strategy": recommended,
        "expected_savings": round(savings, 2),
        "cost_difference": round(cost_a - cost_b, 2),
    }