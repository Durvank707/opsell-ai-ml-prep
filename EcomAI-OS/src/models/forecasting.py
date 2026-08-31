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