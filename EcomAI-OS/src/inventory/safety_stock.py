import numpy as np


def calculate_safety_stock(error_std, lead_time_days, z_score=1.645):
    """
    Calculate safety stock using forecast error uncertainty
    and lead time.

    Formula:
        Safety Stock = Z × Error Std × √Lead Time
    """

    return np.ceil(
        z_score * error_std * np.sqrt(lead_time_days)
    )