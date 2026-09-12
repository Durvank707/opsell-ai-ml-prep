"""Core inventory simulation utilities for V2."""

from dataclasses import dataclass

import pandas as pd
import numpy as np


from src.inventory.policy import (
    calculate_target_inventory,
    calculate_recommended_order_qty,
)

from src.inventory.reorder import (
    calculate_reorder_point,
    should_reorder,
)

@dataclass
class PurchaseOrder:
    """Represents a purchase order placed with a supplier."""

    order_date: pd.Timestamp
    arrival_date: pd.Timestamp
    quantity: int



def create_purchase_order(
    order_date: pd.Timestamp,
    quantity: int,
    lead_time_days: int,
) -> PurchaseOrder:
    """
    Create a purchase order and calculate its arrival date.
    """

    order_date = pd.Timestamp(order_date)

    arrival_date = order_date + pd.Timedelta(days=lead_time_days)

    return PurchaseOrder(
        order_date=order_date,
        arrival_date=arrival_date,
        quantity=int(quantity),
    )




def get_arrivals_for_date(
    purchase_orders: list[PurchaseOrder],
    date: pd.Timestamp,
) -> int:
    """
    Calculate how many units arrive on a specific date.
    """

    date = pd.Timestamp(date)

    total_arrivals = 0

    for order in purchase_orders:
        if order.arrival_date == date:
            total_arrivals += order.quantity

    return total_arrivals





def process_daily_demand(
    available_stock: int,
    demand: int,
) -> tuple[int, int, int]:
    """
    Consume daily demand from available inventory.

    Returns
    -------
    tuple
        (
            units_fulfilled,
            stockout_units,
            closing_stock,
        )
    """

    demand = int(demand)
    available_stock = int(available_stock)

    units_fulfilled = min(available_stock, demand)

    stockout_units = demand - units_fulfilled

    closing_stock = available_stock - units_fulfilled

    return units_fulfilled, stockout_units, closing_stock





def simulate_day(
    date: pd.Timestamp,
    opening_stock: int,
    demand: int,
    purchase_orders: list[PurchaseOrder],
) -> dict:
    """
    Simulate one day of inventory activity.

    Returns a dictionary containing the day's inventory results.
    """

    date = pd.Timestamp(date)

    # 1. Find inventory arriving today.
    arrival_qty = get_arrivals_for_date(
        purchase_orders=purchase_orders,
        date=date,
    )

    # 2. Add arriving inventory.
    available_stock = opening_stock + arrival_qty

    # 3. Consume today's demand.
    (
        units_fulfilled,
        stockout_units,
        closing_stock,
    ) = process_daily_demand(
        available_stock=available_stock,
        demand=demand,
    )

    return {
        "date": date,
        "opening_stock": opening_stock,
        "arrival_qty": arrival_qty,
        "demand": demand,
        "units_fulfilled": units_fulfilled,
        "stockout_units": stockout_units,
        "closing_stock": closing_stock,
    }



def simulate_inventory(
    demand_df: pd.DataFrame,
    initial_stock: int,
    purchase_orders: list[PurchaseOrder] | None = None,
) -> pd.DataFrame:
    """
    Simulate inventory across an entire historical period.

    Parameters
    ----------
    demand_df:
        DataFrame containing:
        - date
        - units_sold

    initial_stock:
        Inventory available at the beginning of the simulation.

    purchase_orders:
        Purchase orders that may arrive during the simulation.

    Returns
    -------
    pd.DataFrame
        Daily inventory simulation results.
    """

    required_columns = {"date", "units_sold"}

    if not required_columns.issubset(demand_df.columns):
        raise ValueError(
            "demand_df must contain 'date' and 'units_sold' columns."
        )

    df = demand_df.copy()

    # Make sure dates are datetime.
    df["date"] = pd.to_datetime(df["date"])

    # Always simulate chronologically.
    df = df.sort_values("date").reset_index(drop=True)

    purchase_orders = purchase_orders or []

    current_stock = int(initial_stock)

    results = []

    # Simulate one day at a time.
    for _, row in df.iterrows():

        daily_result = simulate_day(
            date=row["date"],
            opening_stock=current_stock,
            demand=row["units_sold"],
            purchase_orders=purchase_orders,
        )

        results.append(daily_result)

        # Today's closing stock becomes tomorrow's opening stock.
        current_stock = daily_result["closing_stock"]

    return pd.DataFrame(results)




def create_policy_order(
    date: pd.Timestamp,
    total_forecast: float,
    lead_time_demand: float,
    safety_stock: float,
    inventory_position: float,
    lead_time_days: int,
) -> PurchaseOrder | None:
    """
    Create a purchase order using the existing V1 reorder
    and order-quantity logic.

    The reorder decision is calculated automatically.
    """

    # 1. Determine whether we need to reorder.
    reorder_required = evaluate_reorder_decision(
        inventory_position=inventory_position,
        lead_time_demand=lead_time_demand,
        safety_stock=safety_stock,
    )

    # 2. Calculate order quantity using the V1 policy.
    target_inventory = calculate_target_inventory(
        total_forecast=total_forecast,
        safety_stock=safety_stock,
    )

    order_qty = calculate_recommended_order_qty(
        target_inventory=target_inventory,
        inventory_position=inventory_position,
        reorder_required=reorder_required,
    )

    # Convert NumPy scalar/array output to a normal Python float.
    order_qty = float(np.asarray(order_qty).item())

    # 3. No order needed.
    if order_qty <= 0:
        return None

    # 4. Create the purchase order.
    return create_purchase_order(
        order_date=date,
        quantity=int(order_qty),
        lead_time_days=lead_time_days,
    )


def evaluate_policy(
    date: pd.Timestamp,
    total_forecast: float,
    safety_stock: float,
    inventory_position: float,
    reorder_required: bool,
    lead_time_days: int,
) -> PurchaseOrder | None:
    """
    Evaluate the V1 inventory policy for a given day.

    Returns a PurchaseOrder when the policy recommends
    replenishment. Otherwise returns None.
    """

    return create_policy_order(
        date=date,
        total_forecast=total_forecast,
        safety_stock=safety_stock,
        inventory_position=inventory_position,
        reorder_required=reorder_required,
        lead_time_days=lead_time_days,
    )


def calculate_inventory_position(
    current_stock: int,
    purchase_orders: list[PurchaseOrder],
    current_date: pd.Timestamp,
) -> int:
    """
    Calculate inventory position.

    Inventory Position =
        Current Stock
        + Quantity of outstanding purchase orders
    """

    current_date = pd.Timestamp(current_date)

    outstanding_qty = sum(
        order.quantity
        for order in purchase_orders
        if order.arrival_date > current_date
    )

    return int(current_stock + outstanding_qty)


def evaluate_reorder_decision(
    inventory_position: float,
    lead_time_demand: float,
    safety_stock: float,
) -> bool:
    """
    Determine whether inventory should be reordered
    using the existing V1 reorder-point logic.
    """

    reorder_point = calculate_reorder_point(
        lead_time_demand=lead_time_demand,
        safety_stock=safety_stock,
    )

    reorder_required = should_reorder(
        inventory_position=inventory_position,
        reorder_point=reorder_point,
    )

    return bool(reorder_required)


def simulate_day_with_policy(
    date: pd.Timestamp,
    opening_stock: int,
    demand: int,
    total_forecast: float,
    lead_time_demand: float,
    safety_stock: float,
    purchase_orders: list[PurchaseOrder],
    lead_time_days: int,
) -> tuple[dict, PurchaseOrder | None]:
    """
    Simulate one day and allow the V1 policy to make
    an automatic replenishment decision.
    """

    # ---------------------------------------------------------
    # 1. Receive orders arriving today.
    # ---------------------------------------------------------
    arrival_qty = get_arrivals_for_date(
        purchase_orders=purchase_orders,
        date=date,
    )

    # ---------------------------------------------------------
    # 2. Add today's arrivals to opening stock.
    # ---------------------------------------------------------
    available_stock = opening_stock + arrival_qty

    # ---------------------------------------------------------
    # 3. Consume today's demand.
    # ---------------------------------------------------------
    (
        units_fulfilled,
        stockout_units,
        closing_stock,
    ) = process_daily_demand(
        available_stock=available_stock,
        demand=demand,
    )

    # ---------------------------------------------------------
    # 4. Calculate inventory position AFTER today's activity.
    # ---------------------------------------------------------
    inventory_position = calculate_inventory_position(
        current_stock=closing_stock,
        purchase_orders=purchase_orders,
        current_date=date,
    )

    # ---------------------------------------------------------
    # 5. Ask the V1 policy whether we should reorder.
    # ---------------------------------------------------------
    new_order = create_policy_order(
        date=date,
        total_forecast=total_forecast,
        lead_time_demand=lead_time_demand,
        safety_stock=safety_stock,
        inventory_position=inventory_position,
        lead_time_days=lead_time_days,
    )

    # ---------------------------------------------------------
    # 6. Record today's result.
    # ---------------------------------------------------------
    daily_result = {
        "date": pd.Timestamp(date),
        "opening_stock": opening_stock,
        "arrival_qty": arrival_qty,
        "demand": demand,
        "units_fulfilled": units_fulfilled,
        "stockout_units": stockout_units,
        "closing_stock": closing_stock,
        "inventory_position": inventory_position,
        "order_qty": 0 if new_order is None else new_order.quantity,
        "order_date": None if new_order is None else new_order.order_date,
        "arrival_date": None if new_order is None else new_order.arrival_date,
    }

    return daily_result, new_order



def simulate_inventory_with_policy(
    demand_df: pd.DataFrame,
    initial_stock: int,
    total_forecast: float,
    lead_time_demand: float,
    safety_stock: float,
    lead_time_days: int,
) -> pd.DataFrame:
    """
    Simulate inventory across multiple historical days
    while allowing the V1 policy to make replenishment decisions.
    """

    required_columns = {"date", "units_sold"}

    if not required_columns.issubset(demand_df.columns):
        raise ValueError(
            "demand_df must contain 'date' and 'units_sold' columns."
        )

    df = demand_df.copy()

    df["date"] = pd.to_datetime(df["date"])

    df = (
        df.sort_values("date")
        .reset_index(drop=True)
    )

    purchase_orders = []

    current_stock = int(initial_stock)

    results = []

    for _, row in df.iterrows():

        daily_result, new_order = simulate_day_with_policy(
            date=row["date"],
            opening_stock=current_stock,
            demand=int(row["units_sold"]),
            total_forecast=total_forecast,
            lead_time_demand=lead_time_demand,
            safety_stock=safety_stock,
            purchase_orders=purchase_orders,
            lead_time_days=lead_time_days,
        )

        # Add today's new order to the outstanding PO list.
        if new_order is not None:
            purchase_orders.append(new_order)

        # Today's closing stock becomes tomorrow's opening stock.
        current_stock = daily_result["closing_stock"]

        results.append(daily_result)

    return pd.DataFrame(results)