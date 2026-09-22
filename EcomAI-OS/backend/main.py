"""FastAPI Application for EcomAI-OS: E-Commerce Inventory & Demand Intelligence Platform."""

from contextlib import asynccontextmanager
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from backend.schemas import (
    ProductInfo,
    ForecastRequest,
    ForecastResponse,
    InventoryOverviewResponse,
    ReorderRecommendation,
    ReorderCalculateRequest,
    StockoutTimelineResponse,
    BacktestRequest,
    BacktestResponse,
)
from backend.services import EcomAIService

_service_instance: Optional[EcomAIService] = None


def get_service() -> EcomAIService:
    global _service_instance
    if _service_instance is None:
        _service_instance = EcomAIService()
    return _service_instance


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pre-initialize service on startup
    get_service()
    yield


app = FastAPI(
    title="EcomAI-OS API",
    description="Enterprise API for AI-powered Demand Forecasting, What-If Scenario Modeling, and Inventory Policy Optimization.",
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS for React frontend (Vite dev server default: 5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health", tags=["System"])
async def health_check():
    """Verify backend and ML model readiness."""
    service = get_service()
    return {
        "status": "healthy",
        "service": "EcomAI-OS Demand & Inventory Engine",
        "model_loaded": hasattr(service, "model"),
        "products_count": len(service.products),
        "products": service.products,
    }


@app.get("/api/products", response_model=List[ProductInfo], tags=["Products"])
async def list_products():
    """Get metadata, stock positions, safety stocks, and risk ratings for all products."""
    service = get_service()
    try:
        return service.get_all_products()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/products/{product_id}", response_model=ProductInfo, tags=["Products"])
async def get_product(product_id: str):
    """Get detailed inventory status and metrics for a specific product."""
    service = get_service()
    try:
        meta = service.get_product_metadata(product_id)
        return ProductInfo(**meta)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/forecast", response_model=ForecastResponse, tags=["Forecasting"])
async def generate_forecast(request: ForecastRequest):
    """Generate recursive ML demand forecasts with optional What-If scenario overrides."""
    service = get_service()
    try:
        return service.generate_demand_forecast(request)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/inventory/overview", response_model=InventoryOverviewResponse, tags=["Inventory"])
async def get_inventory_overview():
    """Get high-level portfolio inventory metrics, stockout risk distribution, and portfolio values."""
    service = get_service()
    try:
        return service.get_inventory_overview()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/inventory/reorder/{product_id}", response_model=ReorderRecommendation, tags=["Inventory"])
async def get_reorder_recommendation(
    product_id: str,
    moq: int = Query(default=0, ge=0, description="Minimum order quantity"),
    pack_size: int = Query(default=1, ge=1, description="Supplier pack / case size"),
):
    """Calculate recommended order quantity and reorder status for a product."""
    service = get_service()
    try:
        return service.get_reorder_recommendation(product_id, moq=moq, pack_size=pack_size)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/inventory/reorder/calculate", response_model=ReorderRecommendation, tags=["Inventory"])
async def calculate_reorder(request: ReorderCalculateRequest):
    """Calculate order quantity using supplier batching constraints."""
    service = get_service()
    try:
        return service.get_reorder_recommendation(
            request.product_id, moq=request.moq, pack_size=request.pack_size
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/inventory/timeline/{product_id}", response_model=StockoutTimelineResponse, tags=["Inventory"])
async def get_stockout_timeline(product_id: str):
    """Project stock depletion day-by-day and identify expected stockout dates."""
    service = get_service()
    try:
        return service.get_stockout_timeline(product_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/simulation/backtest", response_model=BacktestResponse, tags=["Digital Twin Simulation"])
async def run_simulation_backtest(request: BacktestRequest):
    """Run historical policy backtest comparing XGBoost ML policy against Moving Average baseline."""
    service = get_service()
    try:
        return service.run_backtest_simulation(request)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
