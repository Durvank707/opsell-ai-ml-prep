import pandas as pd
from pathlib import Path


# ==========================================
# 1. PATHS
# ==========================================

PROJECT_ROOT = Path(__file__).resolve().parent.parent

SALES_PATH = PROJECT_ROOT / "data" / "raw" / "sales.csv"

OUTPUT_PATH = (
    PROJECT_ROOT
    / "data"
    / "raw"
    / "inventory_snapshot.csv"
)


# ==========================================
# 2. LOAD SALES DATA
# ==========================================

sales_df = pd.read_csv(SALES_PATH)

sales_df["date"] = pd.to_datetime(sales_df["date"])

sales_df = sales_df.sort_values(
    ["product_id", "date"]
).reset_index(drop=True)


# ==========================================
# 3. CALCULATE AVERAGE DAILY DEMAND
# ==========================================

avg_daily_demand = (
    sales_df
    .groupby("product_id")["units_sold"]
    .mean()
    .rename("avg_daily_demand")
    .reset_index()
)


# ==========================================
# 4. INVENTORY CONFIGURATION
# ==========================================

inventory_config = pd.DataFrame({
    "product_id": [
        "P001",
        "P002",
        "P003",
        "P004",
        "P005"
    ],
    "lead_time_days": [
        4,
        7,
        5,
        3,
        6
    ],
    "inventory_days": [
        5,
        6,
        5,
        8,
        5
    ],
    "unit_cost": [
        1000,
        1800,
        2500,
        1200,
        700
    ]
})


# ==========================================
# 5. CALCULATE CURRENT STOCK
# ==========================================

inventory_snapshot = inventory_config.merge(
    avg_daily_demand,
    on="product_id",
    how="left"
)

inventory_snapshot["current_stock"] = (
    inventory_snapshot["avg_daily_demand"]
    * inventory_snapshot["inventory_days"]
).round().astype(int)


# ==========================================
# 6. OPEN PURCHASE ORDERS
# ==========================================

inventory_snapshot["open_order_qty"] = 0

inventory_snapshot["expected_arrival_date"] = pd.NaT


# ==========================================
# 7. SNAPSHOT DATE
# ==========================================

snapshot_date = sales_df["date"].max()

inventory_snapshot["snapshot_date"] = snapshot_date


# ==========================================
# 8. SELECT FINAL COLUMNS
# ==========================================

inventory_snapshot = inventory_snapshot[
    [
        "snapshot_date",
        "product_id",
        "current_stock",
        "open_order_qty",
        "expected_arrival_date",
        "lead_time_days",
        "unit_cost"
    ]
]


# ==========================================
# 9. CREATE OUTPUT DIRECTORY
# ==========================================

OUTPUT_PATH.parent.mkdir(
    parents=True,
    exist_ok=True
)


# ==========================================
# 10. SAVE INVENTORY SNAPSHOT
# ==========================================

inventory_snapshot.to_csv(
    OUTPUT_PATH,
    index=False
)


# ==========================================
# 11. DISPLAY RESULTS
# ==========================================

print("\nInventory snapshot generated successfully!")

print(f"Snapshot date: {snapshot_date.date()}")
print(f"Products: {len(inventory_snapshot)}")
print(f"Saved to: {OUTPUT_PATH}")

print("\nInventory snapshot:")
print(inventory_snapshot.to_string(index=False))