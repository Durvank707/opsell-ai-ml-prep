import pytest
from fastapi.testclient import TestClient
from backend.main import app

client = TestClient(app)


def test_health_endpoint():
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["model_loaded"] is True
    assert "P001" in data["products"]


def test_list_products():
    response = client.get("/api/products")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 5
    product_ids = [p["product_id"] for p in data]
    assert "P001" in product_ids
    assert "decision" in data[0]
    assert "decision_badge" in data[0]


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
    response = client.post("/api/forecast", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["product_id"] == "P001"
    assert len(data["forecast_points"]) == 14
    assert data["scenario_applied"] is True
    assert "plain_english_summary" in data


def test_inventory_overview():
    response = client.get("/api/inventory/overview")
    assert response.status_code == 200
    data = response.json()
    assert data["total_products"] == 5
    assert data["total_inventory_value"] > 0
    assert "products_to_reorder" in data
    assert "alerts" in data


def test_reorder_recommendation():
    response = client.get("/api/inventory/reorder/P001?moq=50&pack_size=12")
    assert response.status_code == 200
    data = response.json()
    assert data["product_id"] == "P001"
    assert "reorder_point" in data
    assert "target_inventory" in data
    assert "recommendation_text" in data


def test_stockout_timeline():
    response = client.get("/api/inventory/timeline/P001")
    assert response.status_code == 200
    data = response.json()
    assert data["product_id"] == "P001"
    assert len(data["timeline"]) == 30


def test_simulation_policy_modes():
    payload = {
        "product_id": "P001",
        "start_date": "2025-10-01",
        "end_date": "2025-10-15",
        "policy_mode": "conservative"
    }
    response = client.post("/api/simulation/backtest", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["policy_mode"] == "conservative"
    assert "stockouts_count" in data
    assert "service_level" in data
