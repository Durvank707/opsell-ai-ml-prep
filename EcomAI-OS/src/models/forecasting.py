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




def forecast_product_demand(model, product_history, model_features, horizon=30):
    """
    Generate recursive future demand forecasts for one product.
    """

    history = product_history.copy()
    history = history.sort_values("date").reset_index(drop=True)

    forecasts = []

    for _ in range(horizon):

        next_date = history["date"].max() + pd.Timedelta(days=1)

        day_of_week = next_date.dayofweek
        month = next_date.month
        is_weekend = day_of_week >= 5

        price = history["price"].iloc[-1]
        discount = 0
        promotion = 0

        demand_history = history["units_sold"]

        lag_1 = demand_history.iloc[-1]
        lag_7 = demand_history.iloc[-7]
        lag_14 = demand_history.iloc[-14]
        lag_28 = demand_history.iloc[-28]

        rolling_mean_7 = demand_history.iloc[-7:].mean()
        rolling_mean_14 = demand_history.iloc[-14:].mean()
        rolling_mean_28 = demand_history.iloc[-28:].mean()
        rolling_std_7 = demand_history.iloc[-7:].std()

        X_future = pd.DataFrame([{
            "price": price,
            "discount": discount,
            "promotion": promotion,
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

        prediction = max(0, prediction)

        future_row = {
            "date": next_date,
            "product_id": history["product_id"].iloc[0],
            "product_name": history["product_name"].iloc[0],
            "category": history["category"].iloc[0],
            "price": price,
            "discount": discount,
            "promotion": promotion,
            "units_sold": prediction,
        }

        history = pd.concat(
            [history, pd.DataFrame([future_row])],
            ignore_index=True
        )

        forecasts.append({
            "date": next_date,
            "product_id": history["product_id"].iloc[0],
            "forecast_units": prediction
        })

    return pd.DataFrame(forecasts)