"""Data loading and basic preprocessing functions."""

import pandas as pd
from pathlib import Path


def load_sales_data(file_path):
    """
    Load sales data from a CSV file.

    Parameters
    ----------
    file_path : str
        Path to the sales CSV file.

    Returns
    -------
    pandas.DataFrame
        Loaded sales dataset.
    """
    return pd.read_csv(file_path)

def prepare_datetime(df: pd.DataFrame, date_col: str = "date") -> pd.DataFrame:
    """
    Convert date column to datetime and sort data.

    Args:
        df: Input DataFrame
        date_col: Name of the date column

    Returns:
        DataFrame with datetime converted and sorted
    """
    df = df.copy()
    df[date_col] = pd.to_datetime(df[date_col])
    df = df.sort_values(["product_id", date_col]).reset_index(drop=True)
    return df
