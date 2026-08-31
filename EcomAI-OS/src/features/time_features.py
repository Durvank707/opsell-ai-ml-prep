def create_time_features(df):
    """
    Create calendar-based time features.

    Parameters
    ----------
    df : pandas.DataFrame
        Sales dataset containing a 'date' column.

    Returns
    -------
    pandas.DataFrame
        Dataset with calendar features added.
    """
    df = df.copy()

    df["year"] = df["date"].dt.year
    df["month"] = df["date"].dt.month
    df["day"] = df["date"].dt.day
    df["day_of_week"] = df["date"].dt.dayofweek
    df["week_of_year"] = (
        df["date"].dt.isocalendar().week.astype(int)
    )
    df["is_weekend"] = df["day_of_week"] >= 5

    return df