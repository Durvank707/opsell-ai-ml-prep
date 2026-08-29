import pandas as pd
import numpy as np


# ==========================================
# 1. PRODUCT CATALOGUE
# ==========================================

products = [
    {
        "product_id": "P001",
        "product_name": "Wireless Headphones",
        "category": "Electronics",
        "base_price": 1999,
    },
    {
        "product_id": "P002",
        "product_name": "Running Shoes",
        "category": "Footwear",
        "base_price": 2499,
    },
    {
        "product_id": "P003",
        "product_name": "Smart Watch",
        "category": "Electronics",
        "base_price": 2999,
    },
    {
        "product_id": "P004",
        "product_name": "Travel Backpack",
        "category": "Accessories",
        "base_price": 1499,
    },
    {
        "product_id": "P005",
        "product_name": "Yoga Mat",
        "category": "Fitness",
        "base_price": 999,
    },
]


# ==========================================
# 2. CONFIGURATION
# ==========================================

np.random.seed(42)

START_DATE = "2024-01-01"
END_DATE = "2025-12-31"

dates = pd.date_range(
    start=START_DATE,
    end=END_DATE,
    freq="D",
)


# ==========================================
# 3. BASE DEMAND FOR EACH PRODUCT
# ==========================================

base_demand = {
    "P001": 35,
    "P002": 25,
    "P003": 30,
    "P004": 20,
    "P005": 40,
}


# ==========================================
# 4. GENERATE DAILY RECORDS
# ==========================================

sales_data = []

for product in products:

    for date in dates:

        # Calendar information
        day_of_week = date.dayofweek
        month = date.month

        is_weekend = day_of_week >= 5

        # Random discount
        discount = np.random.choice(
            [0, 5, 10, 15, 20],
            p=[0.50, 0.15, 0.15, 0.12, 0.08],
        )

        # Promotion when discount is 10% or more
        promotion = int(discount >= 10)

        # Actual selling price
        price = product["base_price"] * (
            1 - discount / 100
        )

        # Seasonal effect
        seasonality = (
            1
            + 0.15
            * np.sin(
                2 * np.pi * month / 12
            )
        )

        # Discount/promotion effect
        promotion_effect = 1 + 0.04 * discount

        # Weekend effect
        weekend_effect = (
            1.15
            if is_weekend
            else 1.0
        )

        # Random variation
        noise = np.random.normal(
            loc=1.0,
            scale=0.12,
        )

        # Calculate demand
        demand = (
            base_demand[product["product_id"]]
            * seasonality
            * promotion_effect
            * weekend_effect
            * noise
        )

        units_sold = max(
            0,
            round(demand),
        )

        # Create one row
        sales_data.append(
            {
                "date": date,
                "product_id": product["product_id"],
                "product_name": product["product_name"],
                "category": product["category"],
                "price": round(price, 2),
                "discount": discount,
                "promotion": promotion,
                "day_of_week": day_of_week,
                "month": month,
                "is_weekend": is_weekend,
                "units_sold": units_sold,
            }
        )


# ==========================================
# 5. CREATE DATAFRAME
# ==========================================

sales_df = pd.DataFrame(sales_data)


# ==========================================
# 6. SAVE DATASET
# ==========================================

sales_df.to_csv(
    "data/raw/sales.csv",
    index=False,
)


# ==========================================
# 7. DISPLAY RESULTS
# ==========================================

print("\nDataset generated successfully!")
print(f"Rows: {len(sales_df)}")
print(f"Columns: {len(sales_df.columns)}")

print("\nFirst 10 rows:")
print(sales_df.head(10))

print("\nSummary statistics:")
print(sales_df.describe()) 