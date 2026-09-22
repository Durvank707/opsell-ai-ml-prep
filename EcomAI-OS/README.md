# EcomAI-OS: Autonomous Demand Forecasting & Inventory Intelligence Platform

An enterprise AI-driven operating system designed to forecast demand, automate multi-echelon replenishment policies, prevent stockouts, and quantify supply chain ROI through digital twin backtesting.

Built with **FastAPI**, **React (Vite + Tailwind CSS + Recharts + Lucide)**, **XGBoost**, and **Scikit-Learn**.

---

## Key Modules & Features

### 1. Executive Overview & Portfolio Valuation
- **Real-Time KPIs**: Total on-hand inventory units, portfolio valuation (@ unit cost), portfolio service level target (99.4%), and stockout risk distribution.
- **Urgent Action Center**: Immediate replenishment alerts for high-risk SKUs with expected stockout dates and days of inventory remaining.
- **Portfolio Catalog**: Deep-dive into each SKU's selling price, daily run rate, safety stock, and reorder point (ROP).

### 2. AI Demand Forecasting & What-If Scenario Lab
- **Recursive Multi-Lag ML Engine**: XGBoost regression model trained on 14 rolling features (`lag_1`, `lag_7`, `lag_14`, `lag_28`, `rolling_mean_7/14/28`, calendar effects, and price elasticity).
- **Interactive Horizon Selection**: Forecast 7, 14, 30, or 60 days into the future.
- **What-If Promotional Scenario Lab**: Adjust price overrides, promotional discounts (0-50%), and marketing campaign flags to simulate demand lift before executing campaigns.
- **Confidence Interval Bounds**: Shaded upper and lower error bounds based on forecast standard deviation (±1.645σ).
- **Moving Average Baseline Comparison**: Direct side-by-side comparison against trailing 7-day moving average.

### 3. Inventory Operations & Reorder Intelligence
- **Order-Up-To Dynamic Policy**: Automated computation of target inventory ($Target = Forecast_{30d} + Safety Stock$) and reorder point ($ROP = Demand_{lead\_time} + Safety Stock$).
- **Stockout Depletion Curve**: Visualizes projected inventory consumption day-by-day and flags the exact date of stockout.
- **Supplier Batching Order Calculator**: Configurable Minimum Order Quantity (MOQ) and Case/Pack Size batching with instant PO capital calculations.
- **1-Click Purchase Order Execution**: Simulates PO creation and tracks outstanding replenishment.

### 4. Digital Twin Simulation & Financial ROI Backtest
- **Historical Policy Backtest**: Simulates daily inventory, orders, fulfillment, and stockouts over 92 days of historical data comparing the ML-driven policy vs Moving Average baseline.
- **Financial Supply Chain Cost Engine**:
  - Annual Inventory Holding Cost (e.g., 20%/year)
  - Administrative Ordering Cost per PO (e.g., ₹500/order)
  - Stockout Penalty / Lost Margin Cost (e.g., ₹1,000/unfulfilled unit)
- **Net Cost Savings**: Quantifies rupee savings and service level improvements achieved by AI optimization.

---

## Quick Start Guide

### Prerequisites
- Python 3.12+
- Node.js 18+ & npm

### 1. Backend Setup & Run (FastAPI)

Activate the virtual environment and launch Uvicorn:
```powershell
# In project root:
.\.venv\Scripts\uvicorn.exe backend.main:app --reload --port 8000
```
- API root: `http://localhost:8000`
- Interactive OpenAPI Docs: `http://localhost:8000/docs`

### 2. Frontend Setup & Run (React)

Launch the Vite development server:
```powershell
# In another terminal:
cd frontend
npm run dev
```
- Web Application: `http://localhost:5173`

---

## Automated Tests

Run the complete test suite (inventory policy unit tests, ML tests, and FastAPI API tests):
```powershell
.\.venv\Scripts\python.exe -m pytest tests/
```

---

## Project Structure

```
EcomAI-OS/
├── backend/                  # FastAPI Application
│   ├── main.py               # REST API endpoints & CORS
│   ├── schemas.py            # Pydantic data contracts
│   └── services.py           # ML & inventory business logic service layer
├── frontend/                 # React SPA Dashboard
│   ├── src/
│   │   ├── api/client.js     # REST client
│   │   ├── components/       # Header, Sidebar, Nav
│   │   ├── views/            # Overview, Forecasting, Inventory, Backtest
│   │   ├── App.jsx           # State & orchestrator
│   │   └── main.jsx          # Entry point
│   ├── package.json
│   └── vite.config.js
├── models/
│   └── xgboost_forecaster.joblib  # Trained model
├── data/
│   ├── raw/                  # sales.csv, inventory_snapshot.csv
│   └── processed/            # forecast_error_std.csv
├── src/                      # Core ML & inventory algorithms
│   ├── data/
│   ├── evaluation/
│   ├── features/
│   ├── inventory/
│   └── models/
└── tests/                    # Pytest test suite
```
