def create_lag_features(
    df,
    target_column="units_sold",
    group_column="product_id",
    lags=(1, 7, 14, 28),
):
    """
    Create lag features for a time-series dataset.

    Parameters
    ----------
    df : pandas.DataFrame
        Sales dataset.
    target_column : str
        Column containing the target variable.
    group_column : str
        Column identifying each time series.
    lags : tuple
        Number of periods to lag.

    Returns
    -------
    pandas.DataFrame
        Dataset with lag features added.
    """
    df = df.copy()

    for lag in lags:
        df[f"lag_{lag}"] = (
            df.groupby(group_column)[target_column]
            .shift(lag)
        )

    return df