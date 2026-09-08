import numpy as np


def calculate_target_inventory(total_forecast, safety_stock):
    """
    Calculate target inventory for the 30-day order-up-to policy.

    Target Inventory = 30-Day Forecast + Safety Stock
    """

    return total_forecast + safety_stock


def calculate_recommended_order_qty(
    target_inventory,
    inventory_position,
    reorder_required
):
    """
    Calculate recommended order quantity.

    An order is recommended only when the reorder condition
    is triggered. Order quantity is rounded up to a whole unit.
    """

    order_qty = np.where(
        reorder_required,
        target_inventory - inventory_position,
        0
    )

    return np.ceil(order_qty)