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
    reorder_required,
    moq: int = 0,
    pack_size: int = 1,
):
    """
    Calculate recommended order quantity with optional MOQ and pack size batching.

    Parameters
    ----------
    target_inventory : float or np.ndarray
        Target inventory level (e.g. 30-day forecast + safety stock).
    inventory_position : float or np.ndarray
        Current stock + open orders.
    reorder_required : bool or np.ndarray
        Whether reorder threshold has been breached.
    moq : int, default=0
        Minimum Order Quantity imposed by supplier.
    pack_size : int, default=1
        Packaging multiple (e.g., case/box size of 6 or 12 units).

    Returns
    -------
    float or np.ndarray
        Recommended order quantity satisfying MOQ and pack size multiples.
    """
    # Base deficit when reorder is needed
    order_qty = np.where(
        reorder_required,
        np.maximum(0.0, target_inventory - inventory_position),
        0.0,
    )

    # Apply Minimum Order Quantity (MOQ)
    if moq > 0:
        order_qty = np.where(
            order_qty > 0,
            np.maximum(order_qty, float(moq)),
            0.0,
        )

    # Apply Pack / Case Size rounding
    if pack_size > 1:
        order_qty = np.where(
            order_qty > 0,
            np.ceil(order_qty / pack_size) * pack_size,
            0.0,
        )
    else:
        order_qty = np.ceil(order_qty)

    return order_qty