import pandas as pd


def calculate_lead_time_demand(forecast_df):
    """
    Calculate forecasted demand during each product's lead time.
    """

    lead_time_demand = (
        forecast_df
        .sort_values(["product_id", "date"])
        .groupby("product_id")
        .apply(
            lambda group: group[
                group["date"]
                <= group["date"].min()
                + pd.Timedelta(
                    days=group["lead_time_days"].iloc[0] - 1
                )
            ]["forecast_units"].sum()
        )
        .reset_index(name="lead_time_demand")
    )

    return lead_time_demand