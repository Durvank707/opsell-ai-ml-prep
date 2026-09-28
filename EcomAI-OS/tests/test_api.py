import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient
from backend.main import app

# Mirrors the hermetic HS256 baseline in tests/conftest.py.
SECRET = "test-only-not-a-real-secret-" + "0" * 32
client = TestClient(app)


def _b64(value: dict) -> str:
    return base64.urlsafe_b64encode(
        json.dumps(value, separators=(",", ":")).encode()
    ).rstrip(b"=").decode()


def _token(subject: str = "test-user-1") -> str:
    now = time.time()
    header = _b64({"alg": "HS256", "typ": "JWT"})
    payload = _b64({"sub": subject, "iat": now, "exp": now + 3600})
    sig = hmac.new(
        SECRET.encode(), f"{header}.{payload}".encode(), hashlib.sha256
    ).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


HEADERS = {"Authorization": f"Bearer {_token()}"}


def test_health_endpoint():
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["model_loaded"] is True
    assert "P001" in data["products"]


def test_list_products():
    response = client.get("/api/products", headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 5
    product_ids = [p["product_id"] for p in data]
    assert "P001" in product_ids


def test_forecast_endpoint():
    payload = {
        "product_id": "P001",
        "horizon": 14,
        "scenario": {
            "price": 1899.0,
            "discount": 10,
            "promotion": 1
        }
    }
    response = client.post("/api/forecast", json=payload, headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert data["product_id"] == "P001"
    assert len(data["forecast_points"]) == 14
    assert data["scenario_applied"] is True


def test_inventory_overview():
    response = client.get("/api/inventory/overview", headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert data["total_products"] == 5
    assert data["total_inventory_units"] > 0
    assert data["portfolio_service_level"] > 90.0


def test_reorder_recommendation():
    response = client.get("/api/inventory/reorder/P001?moq=50&pack_size=12", headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert data["product_id"] == "P001"
    assert "reorder_point" in data
    assert "target_inventory" in data


def test_stockout_timeline():
    response = client.get("/api/inventory/timeline/P001", headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert data["product_id"] == "P001"
    assert len(data["timeline"]) == 30
