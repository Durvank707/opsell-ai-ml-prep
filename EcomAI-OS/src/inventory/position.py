def calculate_inventory_position(current_stock, open_order_qty):
    """
    Calculate inventory position.

    Inventory Position = Current Stock + Open Order Quantity
    """

    return current_stock + open_order_qty