def time_based_split(
    df,
    train_end,
    validation_end,
):
    """
    Split time-series data chronologically into train,
    validation, and test sets.

    Parameters
    ----------
    df : pandas.DataFrame
        Prepared sales dataset containing a 'date' column.
    train_end : str
        First date of the validation period.
    validation_end : str
        First date of the test period.

    Returns
    -------
    tuple
        train, validation, and test DataFrames.
    """

    train = df[
        df["date"] < train_end
    ].copy()

    validation = df[
        (df["date"] >= train_end)
        & (df["date"] < validation_end)
    ].copy()

    test = df[
        df["date"] >= validation_end
    ].copy()

    return train, validation, test