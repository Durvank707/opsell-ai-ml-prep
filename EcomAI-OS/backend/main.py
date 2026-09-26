"""FastAPI Application for EcomAI-OS: E-Commerce Inventory & Demand Intelligence Platform."""

from contextlib import asynccontextmanager
import logging
import os
from typing import Any, List, Optional
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from backend.auth import require_v1_auth
from backend.config import _load_dotenv_files
from backend.jobs import friendly_error
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

# The service imports pandas/scikit-learn/joblib and the trained forecaster.
# Keep that heavy import lazy so validation, job, and tenant routes remain
# usable even when the optional ML resources are unavailable.
_service_instance: Optional[Any] = None
_logger = logging.getLogger("ecomai.v1")


def _configured_cors_origins() -> list[str]:
    _load_dotenv_files()
    configured = os.environ.get("CORS_ORIGINS", "").strip()
    if configured:
        origins = [item.strip() for item in configured.split(",") if item.strip()]
        if origins:
            return origins
    return ["http://localhost:5173", "http://127.0.0.1:5173"]


def _is_public_liveness_only() -> bool:
    """Avoid loading the optional ML stack in production health checks."""

    _load_dotenv_files()
    return (
        os.environ.get("APP_ENV", "development").strip().lower() == "production"
        or os.environ.get("USE_SUPABASE", "false").strip().lower()
        in {"true", "1", "yes", "on"}
    )


def get_service() -> Any:
    global _service_instance
    if _service_instance is None:
        from backend.services import EcomAIService

        _service_instance = EcomAIService()
    return _service_instance


def _get_service_or_500() -> Any:
    """Turn optional-ML initialization failures into a safe API error."""

    try:
        return get_service()
    except Exception:
        _logger.exception("Unable to initialize the legacy ML service")
        raise HTTPException(
            status_code=500,
            detail="The requested operation could not be completed.",
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Do not force the optional ML stack or local account store during process
    # import/startup. The first route that needs them initializes them lazily.
    try:
        yield
    finally:
        try:
            from backend.local_auth import reset_store
            reset_store()
        except Exception:  # pragma: no cover - shutdown must remain best effort
            _logger.exception("Failed to close local authentication store")


app = FastAPI(
    title="EcomAI-OS API",
    description="Enterprise API for AI-powered Demand Forecasting, What-If Scenario Modeling, and Inventory Policy Optimization.",
    version="1.0.0",
    lifespan=lifespan,
)

# Keep browser CORS explicit. A wildcard origin is not paired with credentialed
# requests in production; deployments can add their exact UI origin(s) via env.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_configured_cors_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/api/health", tags=["System"])
async def health_check():
    """Public liveness check.

    Production/Supabase deployments never initialize the heavy optional ML
    service or expose catalog identifiers from this endpoint. The richer local
    demo response is retained only for the original development test surface.
    """
    if _is_public_liveness_only():
        return {"status": "healthy"}
    service = _get_service_or_500()
    return {
        "status": "healthy",
        "service": "EcomAI-OS Demand & Inventory Engine",
        "model_loaded": hasattr(service, "model"),
        "products_count": len(service.products),
        "products": service.products,
    }


@app.get(
    "/api/products",
    response_model=List[ProductInfo],
    tags=["Products"],
    dependencies=[Depends(require_v1_auth)],
)
async def list_products():
    """Get metadata, stock positions, safety stocks, and risk ratings for all products."""
    service = _get_service_or_500()
    try:
        return service.get_all_products()
    except Exception:
        _logger.exception("Unhandled error in V1 endpoint")
        raise HTTPException(
            status_code=500,
            detail="The requested operation could not be completed.",
        )


@app.get(
    "/api/products/{product_id}",
    response_model=ProductInfo,
    tags=["Products"],
    dependencies=[Depends(require_v1_auth)],
)
async def get_product(product_id: str):
    """Get detailed inventory status and metrics for a specific product."""
    service = _get_service_or_500()
    try:
        meta = service.get_product_metadata(product_id)
        return ProductInfo(**meta)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=friendly_error(str(e)))
    except Exception:
        _logger.exception("Unhandled error in V1 endpoint")
        raise HTTPException(
            status_code=500,
            detail="The requested operation could not be completed.",
        )


@app.post(
    "/api/forecast",
    response_model=ForecastResponse,
    tags=["Forecasting"],
    dependencies=[Depends(require_v1_auth)],
)
async def generate_forecast(request: ForecastRequest):
    """Generate recursive ML demand forecasts with optional What-If scenario overrides."""
    service = _get_service_or_500()
    try:
        return service.generate_demand_forecast(request)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=friendly_error(str(e)))
    except Exception:
        _logger.exception("Unhandled error in V1 endpoint")
        raise HTTPException(
            status_code=500,
            detail="The requested operation could not be completed.",
        )


@app.get(
    "/api/inventory/overview",
    response_model=InventoryOverviewResponse,
    tags=["Inventory"],
    dependencies=[Depends(require_v1_auth)],
)
async def get_inventory_overview():
    """Get high-level portfolio inventory metrics, stockout risk distribution, and portfolio values."""
    service = _get_service_or_500()
    try:
        return service.get_inventory_overview()
    except Exception:
        _logger.exception("Unhandled error in V1 endpoint")
        raise HTTPException(
            status_code=500,
            detail="The requested operation could not be completed.",
        )


@app.get(
    "/api/inventory/reorder/{product_id}",
    response_model=ReorderRecommendation,
    tags=["Inventory"],
    dependencies=[Depends(require_v1_auth)],
)
async def get_reorder_recommendation(
    product_id: str,
    moq: int = Query(default=0, ge=0, description="Minimum order quantity"),
    pack_size: int = Query(default=1, ge=1, description="Supplier pack / case size"),
):
    """Calculate recommended order quantity and reorder status for a product."""
    service = _get_service_or_500()
    try:
        return service.get_reorder_recommendation(product_id, moq=moq, pack_size=pack_size)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=friendly_error(str(e)))
    except Exception:
        _logger.exception("Unhandled error in V1 endpoint")
        raise HTTPException(
            status_code=500,
            detail="The requested operation could not be completed.",
        )


@app.post(
    "/api/inventory/reorder/calculate",
    response_model=ReorderRecommendation,
    tags=["Inventory"],
    dependencies=[Depends(require_v1_auth)],
)
async def calculate_reorder(request: ReorderCalculateRequest):
    """Calculate order quantity using supplier batching constraints."""
    service = _get_service_or_500()
    try:
        return service.get_reorder_recommendation(
            request.product_id, moq=request.moq, pack_size=request.pack_size
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=friendly_error(str(e)))
    except Exception:
        _logger.exception("Unhandled error in V1 endpoint")
        raise HTTPException(
            status_code=500,
            detail="The requested operation could not be completed.",
        )


@app.get(
    "/api/inventory/timeline/{product_id}",
    response_model=StockoutTimelineResponse,
    tags=["Inventory"],
    dependencies=[Depends(require_v1_auth)],
)
async def get_stockout_timeline(product_id: str):
    """Project stock depletion day-by-day and identify expected stockout dates."""
    service = _get_service_or_500()
    try:
        return service.get_stockout_timeline(product_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=friendly_error(str(e)))
    except Exception:
        _logger.exception("Unhandled error in V1 endpoint")
        raise HTTPException(
            status_code=500,
            detail="The requested operation could not be completed.",
        )


@app.post(
    "/api/simulation/backtest",
    response_model=BacktestResponse,
    tags=["Digital Twin Simulation"],
    dependencies=[Depends(require_v1_auth)],
)
async def run_simulation_backtest(request: BacktestRequest):
    """Run historical policy backtest comparing XGBoost ML policy against Moving Average baseline."""
    service = _get_service_or_500()
    try:
        return service.run_backtest_simulation(request)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=friendly_error(str(e)))
    except Exception:
        _logger.exception("Unhandled error in V1 endpoint")
        raise HTTPException(
            status_code=500,
            detail="The requested operation could not be completed.",
        )


# ---------------------------------------------------------------------------
# Optional local auth + additive V2 surface. Neither router changes the legacy
# service implementation; V2 remains the tenant-scoped production surface.
# ---------------------------------------------------------------------------
from backend.routers.auth import router as auth_router
from backend.routers.v2 import router as v2_router

app.include_router(auth_router)
app.include_router(v2_router)
