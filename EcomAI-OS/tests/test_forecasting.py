import pandas as pd
import numpy as np
import pytest

from src.models.forecasting import forecast_product_demand


class DummyForecaster:
    """Predicts a fixed percentage of price + discount or constant demand."""
    def __init__(self, fixed_prediction=25.0):
        self.fixed_prediction = fixed_prediction
        self.last_X = None

    def predict(self, X):
        self.last_X = X.copy()
        # Returns constant or dynamic demand
        return np.full(len(X), self.fixed_prediction)


def test_forecast_product_demand_standard():
    dates = pd.date_range("2025-01-01", periods=60, freq="D")
    history = pd.DataFrame({
        "date": dates,
        "product_id": ["P001"] * 60,
        "product_name": ["Wireless Headphones"] * 60,
        "category": ["Electronics"] * 60,
        "price": [1999.0] * 60,
        "discount": [0] * 60,
        "promotion": [0] * 60,
        "units_sold": [30.0] * 60,
    })

    model = DummyForecaster(fixed_prediction=35.0)
    features = [
        "price", "discount", "promotion", "day_of_week", "month", "is_weekend",
        "lag_1", "lag_7", "lag_14", "lag_28",
        "rolling_mean_7", "rolling_mean_14", "rolling_mean_28", "rolling_std_7"
    ]

    forecast_df = forecast_product_demand(
        model=model,
        product_history=history,
        model_features=features,
        horizon=14,
    )

    assert len(forecast_df) == 14
    assert list(forecast_df.columns) == ["date", "product_id", "forecast_units"]
    assert forecast_df["date"].min() == pd.Timestamp("2025-03-02")
    assert (forecast_df["forecast_units"] == 35.0).all()


def test_forecast_product_demand_scenario_override():
    dates = pd.date_range("2025-01-01", periods=35, freq="D")
    history = pd.DataFrame({
        "date": dates,
        "product_id": ["P002"] * 35,
        "product_name": ["Running Shoes"] * 35,
        "category": ["Footwear"] * 35,
        "price": [2499.0] * 35,
        "discount": [0] * 35,
        "promotion": [0] * 35,
        "units_sold": [20.0] * 35,
    })

    model = DummyForecaster(fixed_prediction=40.0)
    features = [
        "price", "discount", "promotion", "day_of_week", "month", "is_weekend",
        "lag_1", "lag_7", "lag_14", "lag_28",
        "rolling_mean_7", "rolling_mean_14", "rolling_mean_28", "rolling_std_7"
    ]

    # Scenario: 20% promotional discount
    forecast_df = forecast_product_demand(
        model=model,
        product_history=history,
        model_features=features,
        horizon=7,
        scenario_params={"discount": 20, "promotion": 1, "price": 1999.0},
    )

    assert len(forecast_df) == 7
    # Verify the model received the scenario override parameters
    assert model.last_X["discount"].iloc[0] == 20
    assert model.last_X["promotion"].iloc[0] == 1
    assert model.last_X["price"].iloc[0] == 1999.0


def test_forecast_short_history_safety():
    # Only 10 days of history (< 28 days required by lag_28)
    dates = pd.date_range("2025-01-01", periods=10, freq="D")
    history = pd.DataFrame({
        "date": dates,
        "product_id": ["P003"] * 10,
        "product_name": ["Smart Watch"] * 10,
        "category": ["Electronics"] * 10,
        "price": [2999.0] * 10,
        "discount": [0] * 10,
        "promotion": [0] * 10,
        "units_sold": [15.0] * 10,
    })

    model = DummyForecaster(fixed_prediction=18.0)
    features = [
        "price", "discount", "promotion", "day_of_week", "month", "is_weekend",
        "lag_1", "lag_7", "lag_14", "lag_28",
        "rolling_mean_7", "rolling_mean_14", "rolling_mean_28", "rolling_std_7"
    ]

    # Must not raise IndexError
    forecast_df = forecast_product_demand(
        model=model,
        product_history=history,
        model_features=features,
        horizon=5,
    )
    assert len(forecast_df) == 5
    assert (forecast_df["forecast_units"] == 18.0).all()
