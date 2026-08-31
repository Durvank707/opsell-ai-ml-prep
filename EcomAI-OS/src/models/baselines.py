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