from sklearn.metrics import mean_absolute_error


def calculate_mae(y_true, y_pred):
    """
    Calculate Mean Absolute Error.

    Parameters
    ----------
    y_true : array-like
        Actual target values.
    y_pred : array-like
        Predicted target values.

    Returns
    -------
    float
        Mean Absolute Error.
    """
    return mean_absolute_error(y_true, y_pred)



def calculate_inventory_metrics(results):
    """
    Calculate operational inventory metrics from simulation results.

    Parameters
    ----------
    results : pandas.DataFrame
        Daily inventory simulation results.

    Returns
    -------
    dict
        Inventory performance metrics.
    """

    total_demand = results["demand"].sum()
    total_fulfilled = results["units_fulfilled"].sum()
    lost_sales_units = results["stockout_units"].sum()

    service_level = (
        total_fulfilled / total_demand * 100
        if total_demand > 0
        else 0
    )

    return {
        "average_inventory": results["closing_stock"].mean(),
        "maximum_inventory": results["closing_stock"].max(),
        "total_units_ordered": results["order_qty"].sum(),
        "number_of_orders": (
            results["order_qty"] > 0
        ).sum(),
        "stockout_days": (
            results["stockout_units"] > 0
        ).sum(),
        "lost_sales_units": lost_sales_units,
        "total_demand": total_demand,
        "total_fulfilled": total_fulfilled,
        "service_level": service_level,
    }