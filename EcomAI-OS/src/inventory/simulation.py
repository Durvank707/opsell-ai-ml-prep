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

from src.models.forecasting import forecast_product_demand

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
        forecast_demand=total_forecast,
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


# The backtest half of the module. The daily forecast is produced once per
# simulated day by the same recursive call the live forecast uses, and the
# replenishment decision is then made by the shared policy helpers so the
# simulator and the live V2 recommendation cannot drift apart.

from typing import Iterable

from src.inventory.policy_profiles import (
    PolicyProfile,
    get_profile,
    resolve_policy,
)


def _forecast_columns(method: str) -> dict:
    """The per-day forecast columns one forecasting method is replayed with.

    Both methods produce the same three quantities — a single day's demand, the
    demand across the supplier lead time, and the whole-horizon total — so the
    replay loop never branches on the method.
    """

    key = (method or "xgboost").strip().lower()
    if key in ("xgboost", "xgb", "ai"):
        return {
            "daily": "xgb_daily_forecast",
            "lead": "xgb_lead_time_demand",
            "total": "xgb_total_forecast",
        }
    if key in ("baseline", "moving_average", "ma"):
        return {
            "daily": "baseline_daily_forecast",
            "lead": "baseline_lead_time_demand",
            "total": "baseline_total_forecast",
        }
    raise ValueError(
        f"'{method}' is not a forecasting method the simulator can replay. "
        "Use 'xgboost' or 'baseline'."
    )


def prepare_backtest_forecast(
    product_history: pd.DataFrame,
    start_date,
    end_date,
    *,
    model=None,
    model_features: list[str] | None = None,
    lead_time_days: int,
    forecast_window: int = 7,
    horizon: int = 30,
    methods: Iterable[str] = ("xgboost", "baseline"),
) -> pd.DataFrame:
    """Forecast every simulated day once, for the requested methods.

    A backtest day may only look at demand recorded before it, so the forecast
    for each day is produced by the same recursive call the live forecast makes.
    Two facts make this worth doing up front rather than inside the inventory
    loop:

    * The forecast does not depend on the inventory policy. A policy decides
      when to order and how much; it never changes what the demand will be. So
      one pass of forecasts is enough to replay any number of policies against.
    * The moving-average baseline is one line of arithmetic per day, and the
      XGBoost call is the expensive part. Preparing both together means a
      multi-policy comparison costs one XGBoost pass, not one per policy.

    The 30-day total is returned because it is a real planning figure worth
    reporting, but nothing downstream may size an order from it. Replenishment
    covers lead-time demand plus safety stock, exactly as live V2 does.

    Parameters
    ----------
    methods:
        Which forecasting methods to prepare. ``'xgboost'`` requires ``model``
        and ``model_features``; ``'baseline'`` is arithmetic over the recorded
        history and needs neither, so
        :func:`run_baseline_backtest` does not take a model at all. Only the
        requested columns are produced.

    Returns
    -------
    pd.DataFrame
        One row per simulated day with ``date``, ``demand`` and the forecast
        columns for each requested method.
    """

    start_date = pd.Timestamp(start_date)
    end_date = pd.Timestamp(end_date)

    wanted = {(str(m).strip().lower()) for m in methods}
    # Validate the method names through the same table the replay uses, so an
    # unsupported name is refused here rather than half way through a replay.
    for name in wanted:
        _forecast_columns(name)
    if "xgboost" in wanted and (model is None or not model_features):
        # Caught here rather than inside the per-day forecast call, so the
        # caller is told which argument it left out.
        raise ValueError(
            "An XGBoost backtest needs the trained model and its feature list."
        )

    history = product_history.copy()
    history["date"] = pd.to_datetime(history["date"])
    history = history.sort_values("date").reset_index(drop=True)

    backtest_days = history[
        (history["date"] >= start_date) & (history["date"] <= end_date)
    ]

    if backtest_days.empty:
        raise ValueError(
            "No historical demand exists in the selected backtest period."
        )

    from src.models.baselines import moving_average_forecast

    rows = []
    for current_date in backtest_days["date"]:
        history_before_today = history[history["date"] < current_date].copy()

        row = {
            "date": pd.Timestamp(current_date),
        }

        if "xgboost" in wanted:
            forecast = forecast_product_demand(
                model=model,
                product_history=history_before_today,
                model_features=model_features,
                horizon=horizon,
            )
            units = forecast["forecast_units"].astype(float)
            row["xgb_daily_forecast"] = float(units.mean())
            row["xgb_lead_time_demand"] = float(units.head(max(lead_time_days, 1)).sum())
            row["xgb_total_forecast"] = float(units.sum())

        if "baseline" in wanted:
            daily = float(moving_average_forecast(
                history=history_before_today,
                window=forecast_window,
            ))
            row["baseline_daily_forecast"] = daily
            row["baseline_lead_time_demand"] = daily * max(lead_time_days, 1)
            row["baseline_total_forecast"] = daily * horizon

        today_rows = history[history["date"] == current_date]
        if today_rows.empty:
            raise ValueError(
                f"No historical demand found for {current_date.date()}."
            )
        row["demand"] = int(today_rows["units_sold"].iloc[0])

        rows.append(row)

    return pd.DataFrame(rows)


def run_policy_replay(
    days: pd.DataFrame,
    *,
    starting_stock: int,
    safety_stock: float,
    lead_time_days: int,
    profile="current",
    custom: dict | None = None,
    method: str = "xgboost",
    purchase_orders: list[PurchaseOrder] | None = None,
) -> pd.DataFrame:
    """Replay recorded demand one day at a time under one inventory policy.

    Each day, in order: purchase orders placed ``lead_time_days`` ago arrive,
    that day's recorded demand is consumed, the inventory position (stock plus
    everything still in transit) is measured against the policy's reorder
    point, and any resulting order is placed and scheduled to arrive after the
    lead time.

    The replenishment levels come from :func:`resolve_policy`, which builds them
    out of :func:`~src.inventory.reorder.calculate_reorder_point` and
    :func:`~src.inventory.policy.calculate_target_inventory` — the same helpers
    the live V2 reorder recommendation uses. Under the ``current`` profile the
    order-up-to level is lead-time demand plus safety stock; the 30-day forecast
    total is recorded for reporting but never sizes an order.

    Parameters
    ----------
    days:
        The output of :func:`prepare_backtest_forecast`.
    starting_stock:
        Stock on hand on the first simulated day.
    safety_stock:
        The safety stock the inventory configuration derived for this product.
        The policy scales or replaces it.
    lead_time_days:
        This product's supplier lead time.
    profile:
        A policy key or a :class:`~src.inventory.policy_profiles.PolicyProfile`.
    custom:
        ``{"safety_stock": units, "coverage_days": days}``, used only by the
        custom profile.
    method:
        ``'xgboost'`` or ``'baseline'`` — which prepared forecast series to
        replay against.
    purchase_orders:
        An existing list of open orders to seed the replay with. It is appended
        to in place, so the caller keeps ownership of its own order book.

    Returns
    -------
    pd.DataFrame
        One row per simulated day.
    """

    if days is None or days.empty:
        raise ValueError(
            "No historical demand exists in the selected backtest period."
        )

    resolved_profile = get_profile(profile) if not isinstance(profile, PolicyProfile) else profile
    columns = _forecast_columns(method)
    for column in columns.values():
        if column not in days.columns:
            raise ValueError(
                f"The prepared forecast is missing '{column}', so the "
                f"'{method}' method cannot be replayed."
            )

    days = days.sort_values("date").reset_index(drop=True)

    lead_time_days = max(int(lead_time_days or 0), 1)
    orders = purchase_orders if purchase_orders is not None else []
    current_stock = int(starting_stock)

    results = []
    for row in days.itertuples(index=False):
        current_date = pd.Timestamp(row.date)

        # 1. Purchase orders placed `lead_time_days` ago land today.
        arrival_qty = get_arrivals_for_date(
            purchase_orders=orders,
            date=current_date,
        )

        # 2. Demand is served from stock on hand plus what just arrived.
        available_stock = current_stock + arrival_qty

        # 3. Consume the day's recorded demand.
        units_fulfilled, stockout_units, closing_stock = process_daily_demand(
            available_stock=available_stock,
            demand=int(row.demand),
        )

        # 4. Stock still on hand plus everything already ordered but not yet
        #    delivered is what the reorder trigger is measured against. The
        #    in-transit figure is read at this same moment, so
        #    `inventory_position == closing_stock + open_order_units` holds for
        #    every day — including a day that goes on to place an order.
        open_order_units = int(sum(
            order.quantity
            for order in orders
            if order.arrival_date > current_date
        ))
        inventory_position = calculate_inventory_position(
            current_stock=closing_stock,
            purchase_orders=orders,
            current_date=current_date,
        )

        # 5. Apply the policy for today.
        policy = resolve_policy(
            resolved_profile,
            safety_stock=safety_stock,
            daily_forecast=getattr(row, columns["daily"]),
            lead_time_demand=getattr(row, columns["lead"]),
            lead_time_days=lead_time_days,
            custom=custom,
        )

        reorder_required = bool(should_reorder(
            inventory_position=inventory_position,
            reorder_point=policy.reorder_point,
        ))

        order_qty = float(np.asarray(calculate_recommended_order_qty(
            target_inventory=policy.order_up_to,
            inventory_position=inventory_position,
            reorder_required=reorder_required,
        )).item())

        # 6. Place the order; it lands `lead_time_days` from now.
        if order_qty > 0:
            orders.append(create_purchase_order(
                order_date=current_date,
                quantity=int(order_qty),
                lead_time_days=lead_time_days,
            ))

        results.append({
            "date": current_date,
            "opening_stock": current_stock,
            "arrival_qty": arrival_qty,
            "demand": int(row.demand),
            "units_fulfilled": units_fulfilled,
            "stockout_units": stockout_units,
            "closing_stock": closing_stock,
            "open_order_units": open_order_units,
            "inventory_position": inventory_position,
            "order_qty": int(order_qty),
            "reorder_required": reorder_required,
            # Reported, never used to size the order above.
            "total_forecast": float(getattr(row, columns["total"])),
            "daily_forecast": float(getattr(row, columns["daily"])),
            "lead_time_demand": float(getattr(row, columns["lead"])),
            "coverage_demand": policy.coverage_demand,
            "coverage_days": policy.coverage_days,
            "safety_stock": policy.safety_stock,
            "reorder_point": policy.reorder_point,
            "target_inventory": policy.order_up_to,
        })

        # 7. Today's closing stock is tomorrow's opening stock.
        current_stock = closing_stock

    return pd.DataFrame(results)


def simulate_backtest_day(
    current_date: pd.Timestamp,
    product_history: pd.DataFrame,
    current_stock: int,
    purchase_orders: list[PurchaseOrder],
    model,
    model_features: list[str],
    safety_stock: float,
    lead_time_days: int,
    *,
    profile="current",
    custom: dict | None = None,
    method: str = "xgboost",
) -> tuple[dict, PurchaseOrder | None]:
    """Simulate one historical backtest day.

    A thin wrapper over :func:`prepare_backtest_forecast` and
    :func:`run_policy_replay` so a single day and a whole window run through
    exactly the same replenishment code. The forecast uses only historical
    information available before ``current_date``.

    ``purchase_orders`` is the caller's open order book and is appended to in
    place. The order placed today, if any, is returned alongside the day's
    result.
    """

    before = len(purchase_orders)
    days = prepare_backtest_forecast(
        product_history,
        current_date,
        current_date,
        model=model,
        model_features=model_features,
        lead_time_days=lead_time_days,
    )
    replayed = run_policy_replay(
        days,
        starting_stock=current_stock,
        safety_stock=safety_stock,
        lead_time_days=lead_time_days,
        profile=profile,
        custom=custom,
        method=method,
        purchase_orders=purchase_orders,
    )

    new_order = purchase_orders[before] if len(purchase_orders) > before else None
    return replayed.iloc[0].to_dict(), new_order


def run_backtest(
    product_history: pd.DataFrame,
    start_date: pd.Timestamp,
    end_date: pd.Timestamp,
    starting_stock: int,
    model,
    model_features: list[str],
    safety_stock: float,
    lead_time_days: int,
    *,
    profile="current",
    custom: dict | None = None,
) -> pd.DataFrame:
    """Run the V2 historical backtest for one product.

    Each day:
        1. Use only history available before the day.
        2. Generate the existing V1 forecast.
        3. Apply the replenishment policy — reorder point, inventory
           position, order-up-to level, recommended order quantity.
        4. Create a purchase order if required.
        5. Receive orders arriving that day.
        6. Consume actual historical demand.
        7. Carry the inventory state into the next day.

    ``profile`` selects the inventory policy; it defaults to ``current``, which
    is the live V2 replenishment rule.
    """

    days = prepare_backtest_forecast(
        product_history,
        start_date,
        end_date,
        model=model,
        model_features=model_features,
        lead_time_days=lead_time_days,
    )
    return run_policy_replay(
        days,
        starting_stock=starting_stock,
        safety_stock=safety_stock,
        lead_time_days=lead_time_days,
        profile=profile,
        custom=custom,
        method="xgboost",
    )


def run_baseline_backtest(
    product_history,
    start_date,
    end_date,
    starting_stock,
    safety_stock,
    lead_time_days,
    forecast_window=7,
    *,
    profile="current",
    custom: dict | None = None,
) -> pd.DataFrame:
    """Run a historical inventory backtest using a moving-average forecast.

    The same replenishment policy and simulation mechanics are used as the
    XGBoost backtest — same product, same days, same starting stock, same
    safety stock, same lead time. Only the forecasting method changes, which is
    what makes the two comparable.

    No model is taken because this arm never uses one: the moving average is
    arithmetic over the days recorded before the simulated day, which is the
    whole point of the comparison — it is the forecast EcomAI-OS would have
    produced without any trained model at all.
    """

    days = prepare_backtest_forecast(
        product_history,
        start_date,
        end_date,
        lead_time_days=lead_time_days,
        forecast_window=forecast_window,
        methods=("baseline",),
    )
    return run_policy_replay(
        days,
        starting_stock=starting_stock,
        safety_stock=safety_stock,
        lead_time_days=lead_time_days,
        profile=profile,
        custom=custom,
        method="baseline",
    )
