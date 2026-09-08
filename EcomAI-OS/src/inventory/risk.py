import pandas as pd


def classify_stockout_risk(row):
    """
    Classify operational stockout risk based on
    expected stockout and replenishment timing.
    """

    # Stockout is not expected within the forecast horizon
    if pd.isna(row["expected_stockout_date"]):
        return "LOW"

    # Stockout is expected, but no reorder is currently triggered
    if not row["reorder_required"]:
        return "MEDIUM"

    # Reorder is required and we know both dates
    if (
        pd.notna(row["expected_replenishment_date"])
        and pd.notna(row["expected_stockout_date"])
    ):
        if row["expected_replenishment_date"] < row["expected_stockout_date"]:
            return "LOW"

        elif row["expected_replenishment_date"] == row["expected_stockout_date"]:
            return "MEDIUM"

        else:
            return "HIGH"

    # Reorder required but replenishment timing is unknown
    return "HIGH"