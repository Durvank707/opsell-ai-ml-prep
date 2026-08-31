def create_rolling_features(
    df,
    target_column="units_sold",
    group_column="product_id",
):
    """
    Create rolling demand statistics using only past observations.

    Parameters
    ----------
    df : pandas.DataFrame
        Sales dataset.
    target_column : str
        Column containing the target variable.
    group_column : str
        Column identifying each time series.

    Returns
    -------
    pandas.DataFrame
        Dataset with rolling features added.
    """
    df = df.copy()

    grouped_target = df.groupby(group_column)[target_column]

    df["rolling_mean_7"] = (
        grouped_target
        .transform(lambda x: x.shift(1).rolling(7).mean())
    )

    df["rolling_mean_14"] = (
        grouped_target
        .transform(lambda x: x.shift(1).rolling(14).mean())
    )

    df["rolling_mean_28"] = (
        grouped_target
        .transform(lambda x: x.shift(1).rolling(28).mean())
    )

    df["rolling_std_7"] = (
        grouped_target
        .transform(lambda x: x.shift(1).rolling(7).std())
    )

    return df