import numpy as np


def calculate_target_inventory(forecast_demand, safety_stock):
    """
    Calculate the order-up-to target inventory for a replenishment horizon.

    Target Inventory = Expected Demand over the Horizon + Safety Stock

    The caller supplies the demand figure for the horizon the order must cover.
    The production V1 reorder endpoint passes expected *lead-time* demand so a
    replenishment order tops the position back up toward the reorder point;
    backtests and simulations pass whichever horizon total they are evaluating.
    """

    return forecast_demand + safety_stock


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
        Target inventory level (e.g. lead-time demand + safety stock, the
        replenishment level used by the V1 reorder recommendation).
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