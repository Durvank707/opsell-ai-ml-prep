import pandas as pd

from src.inventory.safety_stock import calculate_safety_stock


def calculate_residual_error_std(
    predictions_df: pd.DataFrame,
    actual_col: str = "units_sold",
    pred_col: str = "prediction",
    group_col: str = "product_id",
) -> pd.DataFrame:
    """
    Calculate forecast error standard deviation for each product group.

    Parameters
    ----------
    predictions_df : pd.DataFrame
        DataFrame containing actual and predicted demand.
    actual_col : str
        Actual demand column name.
    pred_col : str
        Predicted demand column name.
    group_col : str
        Product identifier column name.

    Returns
    -------
    pd.DataFrame
        DataFrame with columns [group_col, "error_std"].
    """
    df = predictions_df.copy()
    df["error"] = df[actual_col] - df[pred_col]
    return (
        df.groupby(group_col)["error"]
        .std()
        .reset_index(name="error_std")
    )


def prepare_product_inventory_config(
    product_id: str,
    product_history: pd.DataFrame,
    forecast_error_std: pd.DataFrame | dict | float,
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

    # Resolve error_std whether provided as float, dict, or DataFrame
    if isinstance(forecast_error_std, (int, float)):
        error_std = float(forecast_error_std)
    elif isinstance(forecast_error_std, dict):
        if product_id not in forecast_error_std:
            raise ValueError(f"No forecast error std found for {product_id} in dict.")
        error_std = float(forecast_error_std[product_id])
    elif isinstance(forecast_error_std, pd.DataFrame):
        matching_error = forecast_error_std.loc[
            forecast_error_std["product_id"] == product_id,
            "error_std",
        ]
        if matching_error.empty:
            raise ValueError(
                f"No forecast error std found for {product_id}"
            )
        error_std = float(matching_error.iloc[0])
    else:
        raise TypeError(
            f"Unsupported type for forecast_error_std: {type(forecast_error_std)}"
        )

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