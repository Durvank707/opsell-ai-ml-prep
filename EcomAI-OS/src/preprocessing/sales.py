import pandas as pd


def prepare_sales_data(df):
    """
    Prepare sales data for downstream analysis and modeling.

    Parameters
    ----------
    df : pandas.DataFrame
        Raw sales dataset.

    Returns
    -------
    pandas.DataFrame
        Prepared sales dataset.
    """
    df = df.copy()

    df["date"] = pd.to_datetime(df["date"])

    df = df.sort_values(
        ["product_id", "date"]
    ).reset_index(drop=True)

    return df