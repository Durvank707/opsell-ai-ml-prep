def calculate_projected_stock(inventory_position, forecast_demand):
    """
    Calculate projected stock after forecast demand.

    Projected Stock = Inventory Position - Forecast Demand
    """

    return inventory_position - forecast_demand



def create_stockout_timeline(forecast_df, inventory_state):
    """
    Calculate cumulative forecast demand and projected stock
    over the forecast horizon for each product.
    """

    stockout_timeline = forecast_df.copy()

    stockout_timeline = stockout_timeline.sort_values(
        ["product_id", "date"]
    )

    stockout_timeline["cumulative_demand"] = (
        stockout_timeline
        .groupby("product_id")["forecast_units"]
        .cumsum()
    )

    stockout_timeline = stockout_timeline.merge(
        inventory_state[
            ["product_id", "inventory_position"]
        ],
        on="product_id",
        how="left"
    )

    stockout_timeline["projected_stock"] = (
        stockout_timeline["inventory_position"]
        - stockout_timeline["cumulative_demand"]
    )

    return stockout_timeline


def calculate_stockout_dates(stockout_timeline):
    """
    Calculate the first date when projected stock
    reaches zero or below.
    """

    return (
        stockout_timeline[
            stockout_timeline["projected_stock"] <= 0
        ]
        .groupby("product_id")["date"]
        .min()
        .reset_index(name="expected_stockout_date")
    )