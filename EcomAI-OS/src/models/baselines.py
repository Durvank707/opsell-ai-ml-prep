def naive_forecast(
    df,
    target_column="units_sold",
    group_column="product_id",
):
    """
    Create a naive forecast using the previous observed
    value for each product.

    Parameters
    ----------
    df : pandas.DataFrame
        Time-series dataset.
    target_column : str
        Column containing the target variable.
    group_column : str
        Column identifying each time series.

    Returns
    -------
    pandas.DataFrame
        DataFrame containing the actual value and naive prediction.
    """

    baseline = df[
        ["date", group_column, target_column]
    ].copy()

    baseline = baseline.sort_values(
        [group_column, "date"]
    )

    baseline["prediction"] = (
        baseline
        .groupby(group_column)[target_column]
        .shift(1)
    )

    return baseline





def moving_average_forecast(
    history,
    window=7,
    target_column="units_sold",
):
    """
    Forecast the next day's demand using a moving average.

    Only historical observations available before the forecast
    date should be provided.

    Parameters
    ----------
    history : pandas.DataFrame
        Historical product data.
    window : int, default=7
        Number of previous observations used for the forecast.
    target_column : str, default="units_sold"
        Demand column.

    Returns
    -------
    float
        Forecasted daily demand.
    """

    if target_column not in history.columns:
        raise ValueError(
            f"'{target_column}' column not found in history."
        )

    if len(history) < window:
        raise ValueError(
            f"At least {window} historical observations "
            "are required."
        )

    return float(
        history[target_column]
        .tail(window)
        .mean()
    )