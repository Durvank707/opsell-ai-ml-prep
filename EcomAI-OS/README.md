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

#### Authentication and tenant boundaries

V2 is fail-closed and does not trust a request's `user_id`. Configure a real
HS256 signing secret in the server environment before calling V2:

```dotenv
APP_ENV=development
AUTH_MODE=jwt
JWT_ALGORITHM=HS256
JWT_SECRET=<a-random-secret-at-least-32-bytes>
```

Send the resulting access token as `Authorization: Bearer <token>`. The
server verifies its signature, `exp`, optional `iss`/`aud`, and derives the
tenant from the signed `sub` claim. Any path/body/query `user_id` that differs
from `sub` is rejected with `403`. `AUTH_MODE=disabled` is only an explicit
local-development escape hatch and is rejected in production or when Supabase
is enabled. Tokens with whitespace-padded subjects, missing expiry, duplicate
JSON claims, unsupported headers, or a different `alg` are rejected.

Managed providers may use asymmetric verification instead:

```dotenv
JWT_ALGORITHM=RS256
JWT_PUBLIC_KEY=<server-side PEM public key>
# or: JWT_JWKS_URL=https://provider.example/.well-known/jwks.json
```

The token header cannot select an algorithm or key source. The public key and
JWKS URL are server configuration; never place either a private key or a
Supabase service-role key in the browser.

For an entirely offline end-to-end login, an operator may explicitly set
`LOCAL_AUTH_ENABLED=true`, `AUTH_MODE=jwt`, and a 32-byte `JWT_SECRET` in a
non-production, non-Supabase environment. The optional `/api/auth/signup`,
`/api/auth/login`, and `/api/auth/me` routes use a salted PBKDF2 password hash
and issue short-lived HS256 tokens. This local issuer is not a replacement for
email verification, refresh rotation, or a production identity provider.

#### V1, jobs, and persistence

`/api/health` is a public liveness check. The legacy V1 business routes are a
shared/global demo service, not tenant-isolated: they are disabled by default
for production and Supabase, and explicit production opt-in still requires a
valid JWT. V2 is the tenant-scoped application surface.

Accepted large validation requests return HTTP `202` with a `job_id` and a
truthful `queued` state. Lifecycle records are stored in SQLite at
`data/runtime/jobs.sqlite3` by default; set `JOB_DATABASE_PATH` to a mounted
volume. Local execution is process-local and is not a distributed worker, so a
queued generic job is not claimed to have run until an executable worker exists.

#### Writing tenant data (V2 ingest)

`POST /api/v2/validate` is a read-only canonicalisation pass: it reports
problems and deliberately writes nothing. `POST /api/v2/ingest` is the
authenticated **write** path, and it is what makes the tenant durable:

```jsonc
// 1. the product catalog first — sales rows require an existing product
{"user_id": "you", "record_type": "product",
 "rows": [{"product_id": "P1", "product_name": "Widget",
           "category": "Electronics", "current_stock": 10}]}

// 2. then the sales history for those products
{"user_id": "you", "record_type": "sales",
 "rows": [{"product_id": "P1", "date": "2025-01-01", "units_sold": 4}]}
```

Its guarantees:

* Only `sales` and `product` are ingestable. `inventory` is refused by design,
  as are the derived contracts (`forecast`, `recommendation`, `simulation`),
  which are computed rather than uploaded.
* The tenant is the **signed** subject. A `user_id` that disagrees with the
  token is a `403` and nothing is written.
* **All or nothing.** If any row fails canonical validation the whole batch is
  refused with `422` and neither rows nor audit entries are written, so a
  tenant never holds a half-ingested dataset.
* The server upload cap (`MAX_UPLOAD_ROWS`) is enforced and a client cannot
  raise it with `max_rows`; exceeding it is a `413`.
* Sales for a `product_id` that is not in your catalog are refused rather than
  auto-creating a product from a typo.
* A failed remote write returns `503`. It is never downgraded to a local-only
  success.
* The response reports where the data went, so a client never has to guess:
  `{"ingested_rows": 28, "persisted_to": "sales", "durable": true}`.

Rows are committed per collection in one batch, and audit history is appended
in bounded chunks, so a bulk ingest costs a handful of round trips rather than
one per row.

#### Persistence and tenant isolation

The local workspace is intentionally in-memory when `USE_SUPABASE=false`, and
nothing is sent anywhere in that mode. When `USE_SUPABASE=true`, products,
sales, and audit entries are all written through tenant-scoped PostgREST
adapters, and a fresh workspace rehydrates all three on first access. Remote
writes happen **before** local state changes, so a failed write never leaves a
local record claiming a success that did not occur, and a failed rehydration
rolls back to leave no half-populated workspace.

Tenant isolation is enforced at the application boundary: every query and write
is scoped to the verified workspace `user_id`, which comes from the signed token
and can never be taken from a request body. See
[Row-level security](#row-level-security-and-the-identity-mismatch) for what
the database policies do and do not currently guarantee.

#### Applying the Supabase schema

The service-role key can only reach PostgREST; it cannot run DDL. Create the
tables once, in the Supabase **SQL Editor**, by running
`supabase/migrations/0007_full_schema.sql` (or `0000`–`0006` in order), then
`supabase/migrations/0008_product_price_and_display_fields.sql`. Every statement
is idempotent, so re-running is safe. `scripts/probe_supabase.py` then confirms
connectivity and which tables exist without printing any key material.

`0008` is required, not optional. It adds the three nullable columns the product
record and the product form need beyond the original schema — `unit_price`,
`supplier` and `description`. Without it a product saves but its selling price
and supplier are dropped on the way to the database, and every forecast built
from that history sees a price of `0`. The columns are nullable and additive
precisely so the migration cannot lose existing rows.

#### Never put credentials in `.env.example`

`.env` is git-ignored. `.env.example` is **tracked** and must contain
placeholders only. Put real values in `.env`; a committed template leaks the
service-role key to every clone and to the repository history, where removing
it later does not un-leak it. If a real key ever lands in a tracked file,
rotate it in the Supabase dashboard.

#### Row-level security and the identity mismatch

The migrations enable RLS with policies of the form
`user_id = auth.uid()::text`. **This does not currently match how the
application identifies a tenant, and the policies are therefore inert.**

* The app's tenant identity is the JWT `sub` claim — an email-shaped string such
  as `demo@ecomai.app`.
* `auth.uid()` returns a UUID from a Supabase Auth session. An email is never
  equal to a UUID, so these policies match no row for this application.
* The backend authenticates to PostgREST with the **service-role key, which
  bypasses RLS entirely**. Isolation today comes from application-level scoping,
  not from the database.

Verified with the publishable key, all three tables return `0` rows.

So there is currently **one** isolation boundary, not two. That is not a
shortcut that was taken to make the app work — it is a consequence of the
identity mismatch above, and it should be resolved before the service handles
untrusted traffic. Two coherent options:

1. **Adopt Supabase Auth as the identity provider.** Sign users in through
   Supabase Auth so `sub` *is* `auth.uid()`, and the existing policies start
   matching. This is the option that makes the database a genuine second layer
   and is the prerequisite for any direct-from-client access.
2. **Service-role-only, deliberately.** Keep the service-role connection, drop
   the client-facing RLS policies, and document that the application boundary is
   the only boundary. Acceptable only while the API is the sole client and the
   service-role key never leaves the server.

Option 1 is the target state. Until it is chosen, do not expose the
publishable/anon key to a browser expecting the policies to protect data.

### 2. Frontend Setup & Run (React)

Launch the Vite development server:
```powershell
# In another terminal:
cd frontend
npm run dev
```
- Web Application: `http://localhost:5173`

Out of the box the UI serves its own mock data. To run it against this backend and
Supabase instead, set `VITE_DATA_MODE=api` (and `VITE_AUTH_MODE=external`) in
`frontend/.env.local` — see `frontend/.env.example` and
`frontend/README.md` § *Data modes*. In that mode a failed request is reported on the
page; the app never falls back to generated data behind your back.

---

## Automated Tests

Run the complete test suite (inventory policy unit tests, ML tests, and FastAPI API tests):
```powershell
.\.venv\Scripts\python.exe -m pytest tests/
```

The suite is hermetic: `tests/conftest.py` pins an explicit environment and
points `ECOMAI_OS_ENV_FILE` at a non-existent path, so a developer's real
`.env` or Supabase credentials can never change a test result.

---

## Project Structure

```
EcomAI-OS/
├── backend/                  # FastAPI Application
│   ├── main.py               # REST API endpoints & CORS
│   ├── auth.py               # V2 JWT verification + tenant binding
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
