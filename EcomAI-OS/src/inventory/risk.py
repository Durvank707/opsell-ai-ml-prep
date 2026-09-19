import pandas as pd


def classify_stockout_risk(row):
    """
    Classify operational stockout risk based on
    expected stockout and replenishment timing.

    Risk Hierarchy:
    - LOW: No stockout projected within horizon, or replenishment arrives
           strictly before projected stockout.
    - MEDIUM: Replenishment arrives on the exact day stockout is projected.
    - HIGH: Stockout is projected and replenishment arrives after stockout,
            or no replenishment is in transit.
    """
    stockout_date = row.get("expected_stockout_date")
    replenishment_date = row.get("expected_replenishment_date")

    # 1. Stockout is not expected within the forecast horizon
    if pd.isna(stockout_date):
        return "LOW"

    # 2. Stockout is expected, check replenishment arrival timing
    if pd.notna(replenishment_date):
        if replenishment_date < stockout_date:
            return "LOW"
        elif replenishment_date == stockout_date:
            return "MEDIUM"
        else:
            return "HIGH"

    # 3. Stockout is projected and no replenishment is in transit
    return "HIGH"