def calculate_reorder_point(lead_time_demand, safety_stock):
    """
    Calculate reorder point.

    Reorder Point = Lead-Time Demand + Safety Stock
    """

    return lead_time_demand + safety_stock



def should_reorder(inventory_position, reorder_point):
    """
    Determine whether inventory should be reordered.
    """

    return inventory_position < reorder_point