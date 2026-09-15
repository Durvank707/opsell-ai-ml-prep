import pandas as pd

from src.inventory.safety_stock import calculate_safety_stock


def prepare_product_inventory_config(
    product_id: str,
    product_history: pd.DataFrame,
    forecast_error_std: pd.DataFrame,
    backtest_start: pd.Timestamp,
    lead_time_days: int,
    inventory_days: int,
) -> dict:

    history_before_backtest = product_history[
        product_history["date"] < backtest_start
    ]

    if history_before_backtest.empty:
        raise ValueError(
            f"No history found before backtest for {product_id}"
        )

    average_daily_demand = (
        history_before_backtest["units_sold"].mean()
    )

    starting_stock = int(
        round(average_daily_demand * inventory_days)
    )

    matching_error = forecast_error_std.loc[
        forecast_error_std["product_id"] == product_id,
        "error_std",
    ]

    if matching_error.empty:
        raise ValueError(
            f"No forecast error std found for {product_id}"
        )

    error_std = float(matching_error.iloc[0])

    safety_stock = calculate_safety_stock(
        error_std=error_std,
        lead_time_days=lead_time_days,
    )

    return {
        "product_id": product_id,
        "starting_stock": starting_stock,
        "forecast_error_std": error_std,
        "safety_stock": safety_stock,
        "lead_time_days": lead_time_days,
        "inventory_days": inventory_days,
    }