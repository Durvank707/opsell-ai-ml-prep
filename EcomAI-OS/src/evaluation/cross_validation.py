from sklearn.base import clone
from sklearn.model_selection import TimeSeriesSplit

from src.evaluation.metrics import calculate_mae


def time_series_cv_mae(model, X, y, n_splits=3):
    """
    Evaluate a model using chronological time-series cross-validation.

    Parameters
    ----------
    model : estimator
        Scikit-learn compatible model.
    X : pandas.DataFrame
        Features ordered chronologically.
    y : pandas.Series
        Target values corresponding to X.
    n_splits : int
        Number of time-series splits.

    Returns
    -------
    list
        MAE for each validation fold.
    """

    tscv = TimeSeriesSplit(n_splits=n_splits)

    fold_mae = []

    for train_idx, val_idx in tscv.split(X):

        X_train_fold = X.iloc[train_idx]
        X_val_fold = X.iloc[val_idx]

        y_train_fold = y.iloc[train_idx]
        y_val_fold = y.iloc[val_idx]

        fold_model = clone(model)

        fold_model.fit(
            X_train_fold,
            y_train_fold
        )

        predictions = fold_model.predict(
            X_val_fold
        )

        mae = calculate_mae(
            y_val_fold,
            predictions
        )

        fold_mae.append(mae)

    return fold_mae