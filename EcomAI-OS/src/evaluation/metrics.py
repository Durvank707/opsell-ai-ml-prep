from sklearn.metrics import mean_absolute_error


def calculate_mae(y_true, y_pred):
    """
    Calculate Mean Absolute Error.

    Parameters
    ----------
    y_true : array-like
        Actual target values.
    y_pred : array-like
        Predicted target values.

    Returns
    -------
    float
        Mean Absolute Error.
    """
    return mean_absolute_error(y_true, y_pred)