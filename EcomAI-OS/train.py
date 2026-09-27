"""Train the XGBoost forecaster the backend serves, from a fresh clone.

This is the non-interactive entry point for the training pipeline that
``notebooks/02_forecasting_models.ipynb`` develops interactively. It is not a
second implementation: every step below calls the same ``src/`` functions the
notebook calls, with the same split dates, the same feature list and the same
hyperparameters as the notebook's final cells (feature matrix -> concat
train+validation -> fit -> ``joblib.dump``, then the held-out test evaluation
that writes the per-product forecast-error spread).

The notebook stays the exploratory source of truth -- it still holds the model
comparison, the hyperparameter grid search and the baseline backtests. What it
cannot do is produce the artifact a fresh clone needs, because it is opened in
Jupyter with stored outputs and relative ``../`` paths. That gap is what this
script closes.

The feature list is imported from ``backend.services.MODEL_FEATURES`` rather
than repeated, so the model trained here can never disagree with the columns
``forecast_product_demand`` feeds it at serving time.

Produces (all git-ignored, all required for the backend to boot):

* ``models/xgboost_forecaster.joblib`` -- the trained forecaster.
* ``data/processed/forecast_error_std.csv`` -- per-product forecast-error
  spread, used for safety stock.

Requires ``data/raw/sales.csv`` first; see ``scripts/bootstrap.py`` or the
"Fresh Clone Setup" section of the README.
"""

from __future__ import annotations

import sys
from pathlib import Path

import joblib
import pandas as pd
from xgboost import XGBRegressor

PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.services import MODEL_FEATURES
from src.data.loader import load_sales_data
from src.evaluation.metrics import calculate_mae
from src.features.lag_features import create_lag_features
from src.features.rolling_features import create_rolling_features
from src.features.time_features import create_time_features
from src.models.forecasting import train_model
from src.preprocessing.sales import prepare_sales_data
from src.preprocessing.splitting import time_based_split

# Same boundaries as the notebook: train through Jun 2025, validate Jul-Sep
# 2025, hold out Oct-Dec 2025 as the untouched test window.
TRAIN_END = "2025-07-01"
VALIDATION_END = "2025-10-01"

# The notebook's final cells: this configuration is what it selected and dumped.
FINAL_PARAMS = {
    "n_estimators": 200,
    "learning_rate": 0.05,
    "max_depth": 2,
    "random_state": 42,
    "n_jobs": -1,
}

SALES_CSV = PROJECT_ROOT / "data" / "raw" / "sales.csv"
MODEL_PATH = PROJECT_ROOT / "models" / "xgboost_forecaster.joblib"
ERROR_STD_PATH = PROJECT_ROOT / "data" / "processed" / "forecast_error_std.csv"


def _build_features():
    """Load the raw sales store and attach the model's time/lag/rolling features."""
    df = load_sales_data(SALES_CSV)
    df = prepare_sales_data(df)
    df = create_time_features(df)
    df = create_lag_features(df)
    df = create_rolling_features(df)
    return df


def main() -> int:
    if not SALES_CSV.exists():
        # Fail loudly. The backend also refuses to boot without this file, and
        # a silently empty training frame would produce a model that predicts
        # nothing rather than a visible setup error here.
        print(
            f"error: sales data missing: {SALES_CSV}\n"
            "Generate the seed dataset first, e.g.:\n"
            "    python scripts/bootstrap.py",
            file=sys.stderr,
        )
        return 1

    print(f"Sales data : {SALES_CSV}")
    df = _build_features()
    print(f"Rows       : {len(df)} rows, {df['product_id'].nunique()} products")

    train, validation, test = time_based_split(
        df, train_end=TRAIN_END, validation_end=VALIDATION_END
    )
    for name, part in (("Train", train), ("Validation", validation), ("Test", test)):
        print(f"{name:<11}: {part['date'].min().date()} to {part['date'].max().date()}")

    # The longest lag/rolling window leaves the first 28 days of each product
    # without features; those rows are dropped rather than imputed, exactly as
    # the notebook does.
    train_ml = train.dropna(subset=MODEL_FEATURES)
    validation_ml = validation.dropna(subset=MODEL_FEATURES)
    test_ml = test.dropna(subset=MODEL_FEATURES)

    X_final_train = pd.concat([train_ml[MODEL_FEATURES], validation_ml[MODEL_FEATURES]])
    y_final_train = pd.concat([train_ml["units_sold"], validation_ml["units_sold"]])
    print(f"Fitting on : {len(X_final_train)} rows (train + validation)")

    final_model = XGBRegressor(**FINAL_PARAMS)
    final_model = train_model(final_model, X_final_train, y_final_train)

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(final_model, MODEL_PATH)
    print(f"Model saved to: {MODEL_PATH}")

    # Score the untouched test window and record how wrong the model typically
    # is per product. The inventory engine widens safety stock by this spread,
    # so it is written next to the model rather than left to a fallback.
    X_test = test_ml[MODEL_FEATURES]
    predictions = final_model.predict(X_test)
    test_results = test_ml[["date", "product_id", "units_sold"]].copy()
    test_results["error"] = test_results["units_sold"] - predictions

    test_mae = calculate_mae(test_results["units_sold"], predictions)
    product_error_std = test_results.groupby("product_id")["error"].std().reset_index(
        name="error_std"
    )
    ERROR_STD_PATH.parent.mkdir(parents=True, exist_ok=True)
    product_error_std.to_csv(ERROR_STD_PATH, index=False)

    print(f"Test MAE   : {test_mae:.2f} units (held-out {VALIDATION_END} onward)")
    print(f"Error std saved to: {ERROR_STD_PATH}")
    print(product_error_std.to_string(index=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
