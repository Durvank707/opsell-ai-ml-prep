import pandas as pd




def train_model(model, X_train, y_train):
    """
    Train a forecasting model.

    Parameters
    ----------
    model : estimator
        Scikit-learn compatible model.
    X_train : pandas.DataFrame
        Training features.
    y_train : pandas.Series
        Training target.

    Returns
    -------
    estimator
        Fitted model.
    """
    model.fit(X_train, y_train)

    return model




def forecast_product_demand(
    model,
    product_history: pd.DataFrame,
    model_features: list[str],
    horizon: int = 30,
    scenario_params: dict | pd.DataFrame | None = None,
) -> pd.DataFrame:
    """
    Generate recursive future demand forecasts for one product.

    Parameters
    ----------
    model : estimator
        Trained forecasting model (e.g., XGBoost, Random Forest).
    product_history : pd.DataFrame
        Historical records for the product containing at least:
        date, units_sold, price, product_id, product_name, category.
    model_features : list[str]
        Feature names expected by the model.
    horizon : int, default=30
        Number of days to forecast recursively into the future.
    scenario_params : dict or pd.DataFrame, optional
        Future promotional or pricing scenario parameters.
        - If dict: constant overrides, e.g. {"discount": 10, "promotion": 1}
        - If DataFrame: daily schedule with columns ['date', 'price', 'discount', 'promotion']

    Returns
    -------
    pd.DataFrame
        Forecasted daily demand with columns ['date', 'product_id', 'forecast_units'].
    """

    if product_history.empty:
        raise ValueError("Cannot generate forecast: product_history is empty.")

    history = product_history.copy()
    history["date"] = pd.to_datetime(history["date"])
    history = history.sort_values("date").reset_index(drop=True)

    forecasts = []

    for _ in range(horizon):

        next_date = history["date"].max() + pd.Timedelta(days=1)

        day_of_week = next_date.dayofweek
        month = next_date.month
        is_weekend = day_of_week >= 5

        # Base pricing and promotion parameters
        base_price = float(history["price"].iloc[-1]) if "price" in history.columns else 1000.0
        cur_price = base_price
        cur_discount = 0
        cur_promotion = 0

        # Apply scenario parameter overrides if provided
        if scenario_params is not None:
            if isinstance(scenario_params, dict):
                cur_price = scenario_params.get("price", cur_price)
                cur_discount = scenario_params.get("discount", cur_discount)
                cur_promotion = scenario_params.get("promotion", cur_promotion)
            elif isinstance(scenario_params, pd.DataFrame):
                scenario_df = scenario_params.copy()
                scenario_df["date"] = pd.to_datetime(scenario_df["date"])
                match = scenario_df[scenario_df["date"] == next_date]
                if not match.empty:
                    if "price" in match.columns:
                        cur_price = match["price"].iloc[0]
                    if "discount" in match.columns:
                        cur_discount = match["discount"].iloc[0]
                    if "promotion" in match.columns:
                        cur_promotion = match["promotion"].iloc[0]

        demand_history = history["units_sold"]
        n_obs = len(demand_history)

        # Defensive lag calculation (handles series < 28 days gracefully)
        lag_1 = demand_history.iloc[-1]
        lag_7 = demand_history.iloc[-7] if n_obs >= 7 else demand_history.iloc[0]
        lag_14 = demand_history.iloc[-14] if n_obs >= 14 else demand_history.iloc[0]
        lag_28 = demand_history.iloc[-28] if n_obs >= 28 else demand_history.iloc[0]

        # Defensive rolling features
        rolling_mean_7 = demand_history.iloc[-min(n_obs, 7):].mean()
        rolling_mean_14 = demand_history.iloc[-min(n_obs, 14):].mean()
        rolling_mean_28 = demand_history.iloc[-min(n_obs, 28):].mean()
        std_7 = demand_history.iloc[-min(n_obs, 7):].std()
        rolling_std_7 = 0.0 if pd.isna(std_7) else std_7

        X_future = pd.DataFrame([{
            "price": cur_price,
            "discount": cur_discount,
            "promotion": cur_promotion,
            "day_of_week": day_of_week,
            "month": month,
            "is_weekend": is_weekend,
            "lag_1": lag_1,
            "lag_7": lag_7,
            "lag_14": lag_14,
            "lag_28": lag_28,
            "rolling_mean_7": rolling_mean_7,
            "rolling_mean_14": rolling_mean_14,
            "rolling_mean_28": rolling_mean_28,
            "rolling_std_7": rolling_std_7,
        }])

        prediction = model.predict(
            X_future[model_features]
        )[0]

        prediction = max(0.0, float(prediction))

        future_row = {
            "date": next_date,
            "product_id": history["product_id"].iloc[0] if "product_id" in history.columns else "UNKNOWN",
            "product_name": history["product_name"].iloc[0] if "product_name" in history.columns else "Unknown",
            "category": history["category"].iloc[0] if "category" in history.columns else "General",
            "price": cur_price,
            "discount": cur_discount,
            "promotion": cur_promotion,
            "units_sold": prediction,
        }

        history = pd.concat(
            [history, pd.DataFrame([future_row])],
            ignore_index=True
        )

        forecasts.append({
            "date": next_date,
            "product_id": future_row["product_id"],
            "forecast_units": prediction
        })

    return pd.DataFrame(forecasts)