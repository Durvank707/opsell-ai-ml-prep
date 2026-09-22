"""Pydantic schemas for EcomAI-OS API."""

from __future__ import annotations
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Product Schemas
# ---------------------------------------------------------------------------

class ProductInfo(BaseModel):
    product_id: str
    product_name: str
    category: str
    unit_price: float
    current_stock: int
    open_order_qty: int
    expected_arrival_date: Optional[str] = None
    lead_time_days: int
    unit_cost: float
    forecast_error_std: float
    safety_stock: float
    reorder_point: float
    inventory_position: int
    stockout_risk: str = Field(description="LOW, MEDIUM, or HIGH")
    days_of_inventory: float
    historical_daily_avg: float


# ---------------------------------------------------------------------------
# Demand Forecasting Schemas
# ---------------------------------------------------------------------------

class ForecastScenarioParams(BaseModel):
    price: Optional[float] = None
    discount: Optional[float] = None
    promotion: Optional[int] = None


class ForecastRequest(BaseModel):
    product_id: str
    horizon: int = Field(default=30, ge=7, le=90)
    scenario: Optional[ForecastScenarioParams] = None


class ForecastPoint(BaseModel):
    date: str
    forecast_units: float
    baseline_units: Optional[float] = None
    scenario_units: Optional[float] = None
    price: float
    discount: float
    promotion: int
    lower_bound: float
    upper_bound: float


class RecentActualPoint(BaseModel):
    date: str
    units_sold: float
    price: float
    discount: float
    promotion: int


class ForecastResponse(BaseModel):
    product_id: str
    product_name: str
    category: str
    horizon: int
    forecast_points: List[ForecastPoint]
    recent_actuals: List[RecentActualPoint]
    total_forecast_units: float
    avg_daily_demand: float
    peak_date: str
    peak_units: float
    baseline_total_units: float
    scenario_applied: bool
    scenario_lift_percent: Optional[float] = None


# ---------------------------------------------------------------------------
# Inventory Intelligence Schemas
# ---------------------------------------------------------------------------

class InventoryOverviewResponse(BaseModel):
    total_products: int
    total_inventory_units: int
    total_inventory_value: float
    high_risk_count: int
    medium_risk_count: int
    low_risk_count: int
    portfolio_service_level: float
    products: List[ProductInfo]


class ReorderCalculateRequest(BaseModel):
    product_id: str
    moq: int = Field(default=0, ge=0)
    pack_size: int = Field(default=1, ge=1)


class ReorderRecommendation(BaseModel):
    product_id: str
    product_name: str
    current_stock: int
    open_order_qty: int
    inventory_position: int
    lead_time_demand: float
    safety_stock: float
    reorder_point: float
    target_inventory: float
    recommended_order_qty: int
    reorder_required: bool
    moq: int
    pack_size: int
    lead_time_days: int
    unit_cost: float
    estimated_order_cost: float
    stockout_risk: str
    expected_stockout_date: Optional[str] = None
    expected_replenishment_date: Optional[str] = None


class StockoutTimelinePoint(BaseModel):
    date: str
    forecast_units: float
    cumulative_demand: float
    projected_stock: float


class StockoutTimelineResponse(BaseModel):
    product_id: str
    product_name: str
    inventory_position: int
    expected_stockout_date: Optional[str] = None
    stockout_risk: str
    timeline: List[StockoutTimelinePoint]


# ---------------------------------------------------------------------------
# Backtest & Simulation Schemas
# ---------------------------------------------------------------------------

class BacktestRequest(BaseModel):
    product_id: str
    start_date: str = "2025-10-01"
    end_date: str = "2025-12-31"
    holding_cost_rate: float = 0.20
    ordering_cost_per_order: float = 500.0
    stockout_cost_per_unit: float = 1000.0
    lead_time_days: Optional[int] = None
    inventory_days: int = 5


class BacktestTrajectoryPoint(BaseModel):
    date: str
    actual_demand: int
    xgb_closing_stock: int
    baseline_closing_stock: int
    xgb_order_qty: int
    baseline_order_qty: int
    xgb_stockout_units: int
    baseline_stockout_units: int
    xgb_inventory_position: int
    baseline_inventory_position: int


class BacktestResponse(BaseModel):
    product_id: str
    product_name: str
    start_date: str
    end_date: str
    duration_days: int
    unit_cost: float
    xgb_metrics: Dict[str, Any]
    baseline_metrics: Dict[str, Any]
    cost_comparison: Dict[str, Any]
    daily_trajectory: List[BacktestTrajectoryPoint]
