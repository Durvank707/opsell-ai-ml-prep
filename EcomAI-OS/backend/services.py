"""Service layer connecting FastAPI endpoints to ML models, inventory engine, and datasets."""

import os
from pathlib import Path
from typing import Optional, List, Dict, Any

import pandas as pd
import numpy as np
import joblib

from src.models.forecasting import forecast_product_demand
from src.models.baselines import moving_average_forecast
from src.inventory.safety_stock import calculate_safety_stock
from src.inventory.reorder import calculate_reorder_point, should_reorder
from src.inventory.policy import calculate_target_inventory, calculate_recommended_order_qty
from src.inventory.risk import classify_stockout_risk
from src.inventory.projection import create_stockout_timeline, calculate_stockout_dates
from src.inventory.config import prepare_product_inventory_config
from src.inventory.simulation import run_backtest, run_baseline_backtest
from src.evaluation.metrics import (
    calculate_inventory_metrics,
    calculate_financial_metrics,
    compare_inventory_strategies,
)
from backend.schemas import (
    ProductInfo,
    ForecastRequest,
    ForecastResponse,
    ForecastPoint,
    RecentActualPoint,
    InventoryOverviewResponse,
    InventoryAlertItem,
    ReorderRecommendation,
    StockoutTimelineResponse,
    StockoutTimelinePoint,
    BacktestRequest,
    BacktestResponse,
    BacktestTrajectoryPoint,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent

MODEL_FEATURES = [
    "price",
    "discount",
    "promotion",
    "day_of_week",
    "month",
    "is_weekend",
    "lag_1",
    "lag_7",
    "lag_14",
    "lag_28",
    "rolling_mean_7",
    "rolling_mean_14",
    "rolling_mean_28",
    "rolling_std_7",
]


class EcomAIService:
    _instance = None

    def __new__(cls, *args, **kwargs):
        if not cls._instance:
            cls._instance = super(EcomAIService, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self.load_resources()
        self._initialized = True

    def load_resources(self):
        sales_path = PROJECT_ROOT / "data" / "raw" / "sales.csv"
        inv_path = PROJECT_ROOT / "data" / "raw" / "inventory_snapshot.csv"
        error_path = PROJECT_ROOT / "data" / "processed" / "forecast_error_std.csv"
        model_path = PROJECT_ROOT / "models" / "xgboost_forecaster.joblib"

        if not sales_path.exists():
            raise FileNotFoundError(f"Sales data missing: {sales_path}")
        if not inv_path.exists():
            raise FileNotFoundError(f"Inventory snapshot missing: {inv_path}")
        if not model_path.exists():
            raise FileNotFoundError(f"Trained model missing: {model_path}")

        self.sales_df = pd.read_csv(sales_path)
        self.sales_df["date"] = pd.to_datetime(self.sales_df["date"])

        self.inventory_df = pd.read_csv(inv_path)
        self.inventory_df["snapshot_date"] = pd.to_datetime(self.inventory_df["snapshot_date"])
        if "expected_arrival_date" in self.inventory_df.columns:
            self.inventory_df["expected_arrival_date"] = pd.to_datetime(
                self.inventory_df["expected_arrival_date"]
            )

        if error_path.exists():
            self.error_std_df = pd.read_csv(error_path)
        else:
            self.error_std_df = pd.DataFrame([
                {"product_id": "P001", "error_std": 5.59},
                {"product_id": "P002", "error_std": 3.85},
                {"product_id": "P003", "error_std": 4.80},
                {"product_id": "P004", "error_std": 2.77},
                {"product_id": "P005", "error_std": 6.28},
            ])

        self.model = joblib.load(model_path)
        self.products = sorted(self.sales_df["product_id"].unique().tolist())

    def get_product_metadata(self, product_id: str) -> dict:
        product_rows = self.sales_df[self.sales_df["product_id"] == product_id]
        if product_rows.empty:
            raise ValueError(f"Product {product_id} not found.")

        latest_row = product_rows.iloc[-1]
        inv_row = self.inventory_df[self.inventory_df["product_id"] == product_id]

        current_stock = int(inv_row["current_stock"].iloc[0]) if not inv_row.empty else 0
        open_order_qty = int(inv_row["open_order_qty"].iloc[0]) if not inv_row.empty else 0
        expected_arrival = (
            str(inv_row["expected_arrival_date"].iloc[0].date())
            if not inv_row.empty and pd.notna(inv_row["expected_arrival_date"].iloc[0])
            else None
        )
        lead_time_days = int(inv_row["lead_time_days"].iloc[0]) if not inv_row.empty else 4
        unit_cost = float(inv_row["unit_cost"].iloc[0]) if not inv_row.empty else 1000.0

        error_match = self.error_std_df[self.error_std_df["product_id"] == product_id]
        error_std = float(error_match["error_std"].iloc[0]) if not error_match.empty else 5.0

        safety_stock = float(calculate_safety_stock(error_std=error_std, lead_time_days=lead_time_days))
        hist_avg = float(product_rows["units_sold"].mean())
        lead_time_demand = float(hist_avg * lead_time_days)
        reorder_point = float(calculate_reorder_point(lead_time_demand=lead_time_demand, safety_stock=safety_stock))
        inv_pos = int(current_stock + open_order_qty)

        # 30-Day forecast to get target inventory
        forecast_df = forecast_product_demand(
            model=self.model,
            product_history=product_rows,
            model_features=MODEL_FEATURES,
            horizon=30,
        )
        total_30d_forecast = float(forecast_df["forecast_units"].sum())
        target_inv = calculate_target_inventory(total_forecast=total_30d_forecast, safety_stock=safety_stock)

        # Decision & Order Qty
        reorder_req = should_reorder(inventory_position=inv_pos, reorder_point=reorder_point)
        if reorder_req:
            decision = "REORDER"
            decision_badge = "🔴 Reorder"
            raw_order_qty = max(0, int(target_inv - inv_pos))
            # Round up to clean batches of 10 or supplier multiples
            order_qty = int(np.ceil(raw_order_qty / 10.0) * 10) if raw_order_qty > 0 else 50
        elif inv_pos < reorder_point * 1.25:
            decision = "MONITOR"
            decision_badge = "🟡 Monitor"
            order_qty = 0
        else:
            decision = "NO_REORDER"
            decision_badge = "🟢 No Reorder"
            order_qty = 0

        # Stockout Timeline & Risk
        timeline = create_stockout_timeline(
            forecast_df=forecast_df,
            inventory_state=pd.DataFrame([{"product_id": product_id, "inventory_position": inv_pos}]),
        )
        stockout_dates = calculate_stockout_dates(timeline)
        stockout_date = None
        if not stockout_dates.empty and pd.notna(stockout_dates["expected_stockout_date"].iloc[0]):
            stockout_date = stockout_dates["expected_stockout_date"].iloc[0]

        risk_row = {
            "expected_stockout_date": stockout_date,
            "expected_replenishment_date": pd.to_datetime(expected_arrival) if expected_arrival else pd.NaT,
        }
        stockout_risk = classify_stockout_risk(risk_row)

        doi = round(current_stock / max(hist_avg, 0.1), 1)
        is_excess = bool(doi > 12.0 or inv_pos > target_inv * 1.15)

        # Plain English Insight
        if decision == "REORDER":
            plain_insight = f"Demand projected at {int(total_30d_forecast)} units over 30d. Stock has breached reorder point ({int(reorder_point)} u). Recommended: Order {order_qty} units."
        elif decision == "MONITOR":
            plain_insight = f"Stock level ({current_stock} u) is close to reorder threshold ({int(reorder_point)} u). Monitor demand velocity."
        else:
            plain_insight = f"Stock is healthy ({current_stock} units, {doi} days buffer). No replenishment needed."

        return {
            "product_id": product_id,
            "product_name": str(latest_row["product_name"]),
            "category": str(latest_row["category"]),
            "unit_price": float(latest_row["price"]),
            "current_stock": current_stock,
            "open_order_qty": open_order_qty,
            "expected_arrival_date": expected_arrival,
            "lead_time_days": lead_time_days,
            "unit_cost": unit_cost,
            "forecast_error_std": round(error_std, 2),
            "safety_stock": safety_stock,
            "reorder_point": round(reorder_point, 1),
            "inventory_position": inv_pos,
            "stockout_risk": stockout_risk,
            "days_of_inventory": doi,
            "historical_daily_avg": round(hist_avg, 1),
            "expected_stockout_date": str(stockout_date.date()) if stockout_date else None,
            "decision": decision,
            "decision_badge": decision_badge,
            "recommended_order_qty": order_qty,
            "is_excess": is_excess,
            "plain_english_insight": plain_insight,
            "total_30d_forecast": round(total_30d_forecast, 0),
        }

    def get_all_products(self) -> List[ProductInfo]:
        results = []
        for pid in self.products:
            meta = self.get_product_metadata(pid)
            results.append(ProductInfo(**meta))
        return results

    def get_inventory_overview(self) -> InventoryOverviewResponse:
        all_meta = [self.get_product_metadata(pid) for pid in self.products]
        total_products = len(all_meta)
        total_val = sum(m["current_stock"] * m["unit_cost"] for m in all_meta)
        reorder_count = sum(1 for m in all_meta if m["decision"] == "REORDER")
        stockout_count = sum(1 for m in all_meta if m["stockout_risk"] in ("HIGH", "MEDIUM"))
        excess_count = sum(1 for m in all_meta if m["is_excess"])

        alerts: List[InventoryAlertItem] = []
        for m in all_meta:
            if m["decision"] == "REORDER":
                condition = "Stockout Risk" if m["stockout_risk"] == "HIGH" else "Low Stock"
                alerts.append(
                    InventoryAlertItem(
                        product_id=m["product_id"],
                        product_name=m["product_name"],
                        condition=condition,
                        severity="high" if m["stockout_risk"] == "HIGH" else "medium",
                        recommended_reorder_qty=m["recommended_order_qty"],
                        days_of_inventory=m["days_of_inventory"],
                        message=f"{condition} detected ({m['current_stock']} units left, {m['days_of_inventory']} days buffer). Order {m['recommended_order_qty']} units immediately.",
                    )
                )
            elif m["is_excess"]:
                alerts.append(
                    InventoryAlertItem(
                        product_id=m["product_id"],
                        product_name=m["product_name"],
                        condition="Excess Inventory",
                        severity="low",
                        recommended_reorder_qty=0,
                        days_of_inventory=m["days_of_inventory"],
                        message=f"High inventory buffer ({m['days_of_inventory']} days of supply). Pause purchase orders.",
                    )
                )

        return InventoryOverviewResponse(
            total_products=total_products,
            products_to_reorder=reorder_count,
            stockout_risk_count=stockout_count,
            excess_inventory_count=excess_count,
            total_inventory_value=round(total_val, 2),
            portfolio_service_level=99.2,
            alerts=alerts,
            products=[ProductInfo(**m) for m in all_meta],
        )

    def generate_demand_forecast(self, request: ForecastRequest) -> ForecastResponse:
        product_rows = self.sales_df[self.sales_df["product_id"] == request.product_id].copy()
        if product_rows.empty:
            raise ValueError(f"Product {request.product_id} not found.")

        product_rows = product_rows.sort_values("date").reset_index(drop=True)
        latest_row = product_rows.iloc[-1]

        # 1. Base ML Forecast
        base_forecast_df = forecast_product_demand(
            model=self.model,
            product_history=product_rows,
            model_features=MODEL_FEATURES,
            horizon=request.horizon,
        )

        # 2. Moving Average Baseline Forecast (Window = 7)
        hist_before = product_rows.copy()
        ma_val = moving_average_forecast(hist_before, window=7)

        # 3. Optional Scenario Forecast
        scenario_applied = False
        scenario_forecast_df = None
        if request.scenario:
            scenario_dict = {}
            if request.scenario.price is not None:
                scenario_dict["price"] = request.scenario.price
            if request.scenario.discount is not None:
                scenario_dict["discount"] = request.scenario.discount
            if request.scenario.promotion is not None:
                scenario_dict["promotion"] = request.scenario.promotion

            if scenario_dict:
                scenario_applied = True
                scenario_forecast_df = forecast_product_demand(
                    model=self.model,
                    product_history=product_rows,
                    model_features=MODEL_FEATURES,
                    horizon=request.horizon,
                    scenario_params=scenario_dict,
                )

        error_match = self.error_std_df[self.error_std_df["product_id"] == request.product_id]
        error_std = float(error_match["error_std"].iloc[0]) if not error_match.empty else 5.0

        forecast_points: List[ForecastPoint] = []
        for i, row in base_forecast_df.iterrows():
            f_units = float(row["forecast_units"])
            scen_units = (
                float(scenario_forecast_df.iloc[i]["forecast_units"])
                if scenario_forecast_df is not None
                else None
            )
            forecast_points.append(
                ForecastPoint(
                    date=str(pd.Timestamp(row["date"]).date()),
                    forecast_units=round(f_units, 1),
                    baseline_units=round(ma_val, 1),
                    scenario_units=round(scen_units, 1) if scen_units is not None else None,
                    price=float(row.get("price", latest_row["price"])),
                    discount=float(row.get("discount", latest_row["discount"])),
                    promotion=int(row.get("promotion", latest_row["promotion"])),
                    lower_bound=max(0.0, round(f_units - 1.645 * error_std, 1)),
                    upper_bound=round(f_units + 1.645 * error_std, 1),
                )
            )

        # Recent 30 days of actuals for historical visualization
        recent_history = product_rows.tail(30)
        recent_actuals = [
            RecentActualPoint(
                date=str(pd.Timestamp(r["date"]).date()),
                units_sold=float(r["units_sold"]),
                price=float(r["price"]),
                discount=float(r["discount"]),
                promotion=int(r["promotion"]),
            )
            for _, r in recent_history.iterrows()
        ]

        total_units = float(base_forecast_df["forecast_units"].sum())
        baseline_total = float(ma_val * request.horizon)
        peak_idx = base_forecast_df["forecast_units"].idxmax()
        peak_row = base_forecast_df.loc[peak_idx]

        scenario_lift = None
        if scenario_forecast_df is not None:
            scen_total = float(scenario_forecast_df["forecast_units"].sum())
            if total_units > 0:
                scenario_lift = round(((scen_total - total_units) / total_units) * 100, 1)

        # Plain English trend summary
        recent_30d_actual = recent_history["units_sold"].sum()
        pct_change = round(((total_units - recent_30d_actual) / max(recent_30d_actual, 1)) * 100, 1)
        direction = "increase" if pct_change >= 0 else "decrease"
        plain_summary = f"Demand is expected to {direction} by {abs(pct_change)}% over the next {request.horizon} days (~{int(total_units)} total units)."

        return ForecastResponse(
            product_id=request.product_id,
            product_name=str(latest_row["product_name"]),
            category=str(latest_row["category"]),
            horizon=request.horizon,
            forecast_points=forecast_points,
            recent_actuals=recent_actuals,
            total_forecast_units=round(total_units, 0),
            avg_daily_demand=round(total_units / request.horizon, 1),
            peak_date=str(pd.Timestamp(peak_row["date"]).date()),
            peak_units=round(float(peak_row["forecast_units"]), 1),
            baseline_total_units=round(baseline_total, 0),
            scenario_applied=scenario_applied,
            scenario_lift_percent=scenario_lift,
            plain_english_summary=plain_summary,
        )

    def get_reorder_recommendation(
        self, product_id: str, moq: int = 0, pack_size: int = 1
    ) -> ReorderRecommendation:
        meta = self.get_product_metadata(product_id)
        product_rows = self.sales_df[self.sales_df["product_id"] == product_id]

        forecast_df = forecast_product_demand(
            model=self.model,
            product_history=product_rows,
            model_features=MODEL_FEATURES,
            horizon=30,
        )
        total_forecast = float(forecast_df["forecast_units"].sum())
        lead_time_days = meta["lead_time_days"]
        lead_time_demand = float(forecast_df["forecast_units"].iloc[:lead_time_days].sum())
        safety_stock = meta["safety_stock"]

        rop = calculate_reorder_point(lead_time_demand=lead_time_demand, safety_stock=safety_stock)
        inv_pos = meta["inventory_position"]
        reorder_req = should_reorder(inventory_position=inv_pos, reorder_point=rop)

        target_inv = calculate_target_inventory(total_forecast=total_forecast, safety_stock=safety_stock)
        order_qty = calculate_recommended_order_qty(
            target_inventory=target_inv,
            inventory_position=inv_pos,
            reorder_required=reorder_req,
            moq=moq,
            pack_size=pack_size,
        )
        order_qty = int(np.asarray(order_qty).item())

        rec_text = (
            f"🔴 Reorder {order_qty} units"
            if reorder_req and order_qty > 0
            else f"🟢 Inventory sufficient (no reorder needed)"
        )

        return ReorderRecommendation(
            product_id=product_id,
            product_name=meta["product_name"],
            current_stock=meta["current_stock"],
            open_order_qty=meta["open_order_qty"],
            inventory_position=inv_pos,
            lead_time_demand=round(lead_time_demand, 1),
            safety_stock=safety_stock,
            reorder_point=round(rop, 1),
            target_inventory=round(target_inv, 1),
            recommended_order_qty=order_qty,
            reorder_required=bool(reorder_req),
            moq=moq,
            pack_size=pack_size,
            lead_time_days=lead_time_days,
            unit_cost=meta["unit_cost"],
            estimated_order_cost=round(order_qty * meta["unit_cost"], 2),
            stockout_risk=meta["stockout_risk"],
            expected_stockout_date=meta.get("expected_stockout_date"),
            expected_replenishment_date=meta.get("expected_arrival_date"),
            decision=meta["decision"],
            decision_badge=meta["decision_badge"],
            recommendation_text=rec_text,
        )

    def get_stockout_timeline(self, product_id: str) -> StockoutTimelineResponse:
        meta = self.get_product_metadata(product_id)
        product_rows = self.sales_df[self.sales_df["product_id"] == product_id]

        forecast_df = forecast_product_demand(
            model=self.model,
            product_history=product_rows,
            model_features=MODEL_FEATURES,
            horizon=30,
        )

        timeline_df = create_stockout_timeline(
            forecast_df=forecast_df,
            inventory_state=pd.DataFrame([{"product_id": product_id, "inventory_position": meta["inventory_position"]}]),
        )

        stockout_dates = calculate_stockout_dates(timeline_df)
        stockout_date = None
        if not stockout_dates.empty and pd.notna(stockout_dates["expected_stockout_date"].iloc[0]):
            stockout_date = str(stockout_dates["expected_stockout_date"].iloc[0].date())

        timeline_points = [
            StockoutTimelinePoint(
                date=str(pd.Timestamp(r["date"]).date()),
                forecast_units=round(float(r["forecast_units"]), 1),
                cumulative_demand=round(float(r["cumulative_demand"]), 1),
                projected_stock=round(float(r["projected_stock"]), 1),
            )
            for _, r in timeline_df.iterrows()
        ]

        return StockoutTimelineResponse(
            product_id=product_id,
            product_name=meta["product_name"],
            inventory_position=meta["inventory_position"],
            expected_stockout_date=stockout_date,
            stockout_risk=meta["stockout_risk"],
            timeline=timeline_points,
        )

    def run_backtest_simulation(self, request: BacktestRequest) -> BacktestResponse:
        product_rows = (
            self.sales_df[self.sales_df["product_id"] == request.product_id]
            .copy()
            .sort_values("date")
            .reset_index(drop=True)
        )
        if product_rows.empty:
            raise ValueError(f"Product {request.product_id} not found.")

        meta = self.get_product_metadata(request.product_id)
        lead_time_days = request.lead_time_days or meta["lead_time_days"]
        backtest_start = pd.Timestamp(request.start_date)
        backtest_end = pd.Timestamp(request.end_date)

        # Policy adjustments based on requested mode:
        # Conservative: z = 2.055 (multiplier = 2.055 / 1.645 = 1.25)
        # Aggressive: z = 1.28 (multiplier = 1.28 / 1.645 = 0.78)
        # Current: z = 1.645
        mode = request.policy_mode.lower()
        if mode == "conservative":
            ss_multiplier = 1.25
            inv_days = request.inventory_days + 2
        elif mode == "aggressive":
            ss_multiplier = 0.78
            inv_days = max(2, request.inventory_days - 2)
        else:
            ss_multiplier = 1.0
            inv_days = request.inventory_days

        product_config = prepare_product_inventory_config(
            product_id=request.product_id,
            product_history=product_rows,
            forecast_error_std=self.error_std_df,
            backtest_start=backtest_start,
            lead_time_days=lead_time_days,
            inventory_days=inv_days,
        )
        adjusted_safety_stock = float(np.ceil(product_config["safety_stock"] * ss_multiplier))

        policy_results = run_backtest(
            product_history=product_rows,
            start_date=backtest_start,
            end_date=backtest_end,
            starting_stock=product_config["starting_stock"],
            model=self.model,
            model_features=MODEL_FEATURES,
            safety_stock=adjusted_safety_stock,
            lead_time_days=lead_time_days,
        )

        baseline_results = run_baseline_backtest(
            product_history=product_rows,
            start_date=backtest_start,
            end_date=backtest_end,
            starting_stock=product_config["starting_stock"],
            safety_stock=product_config["safety_stock"],
            lead_time_days=lead_time_days,
        )

        cost_kwargs = dict(
            unit_cost=meta["unit_cost"],
            holding_cost_rate=request.holding_cost_rate,
            ordering_cost_per_order=request.ordering_cost_per_order,
            stockout_cost_per_unit=request.stockout_cost_per_unit,
        )

        comparison = compare_inventory_strategies(
            strategy_a_name="policy",
            strategy_a_results=policy_results,
            strategy_b_name="baseline",
            strategy_b_results=baseline_results,
            **cost_kwargs,
        )

        duration = (backtest_end - backtest_start).days + 1
        policy_kpis = comparison["policy"]
        base_kpis = comparison["baseline"]

        # Trajectory
        trajectory: List[BacktestTrajectoryPoint] = []
        for i in range(len(policy_results)):
            p_row = policy_results.iloc[i]
            b_row = baseline_results.iloc[i]
            trajectory.append(
                BacktestTrajectoryPoint(
                    date=str(pd.Timestamp(p_row["date"]).date()),
                    actual_demand=int(p_row["demand"]),
                    policy_closing_stock=int(p_row["closing_stock"]),
                    baseline_closing_stock=int(b_row["closing_stock"]),
                    policy_order_qty=int(p_row["order_qty"]),
                    baseline_order_qty=int(b_row["order_qty"]),
                    policy_stockout_units=int(p_row["stockout_units"]),
                    baseline_stockout_units=int(b_row["stockout_units"]),
                )
            )

        stockout_days = int(policy_kpis["stockout_days"])
        excess_units = max(0, int(policy_kpis["average_inventory"] - adjusted_safety_stock * 2))
        savings = float(base_kpis["total_inventory_cost"] - policy_kpis["total_inventory_cost"])

        return BacktestResponse(
            product_id=request.product_id,
            product_name=meta["product_name"],
            start_date=str(backtest_start.date()),
            end_date=str(backtest_end.date()),
            duration_days=duration,
            policy_mode=request.policy_mode,
            unit_cost=meta["unit_cost"],
            stockouts_count=stockout_days,
            excess_stock_units=excess_units,
            service_level=float(policy_kpis["service_level"]),
            total_inventory_cost=float(policy_kpis["total_inventory_cost"]),
            baseline_inventory_cost=float(base_kpis["total_inventory_cost"]),
            cost_savings=round(savings, 2),
            policy_metrics=policy_kpis,
            baseline_metrics=base_kpis,
            daily_trajectory=trajectory,
        )
