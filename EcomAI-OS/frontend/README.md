# EcomAI-OS Frontend

AI-powered inventory intelligence — a production-quality, light-themed SaaS dashboard for
demand forecasting, inventory health, recommendations and policy simulation.

Built with **React 18 + Vite + Tailwind CSS 3 + Recharts**, running entirely on mock data
behind a swappable service layer so the real FastAPI backend can be wired in without a UI redesign.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build to dist/
npm run preview    # serve the production build
```

The Vite dev server proxies `/api/*` to `http://localhost:8000` (see `vite.config.js`)
ready for the FastAPI backend.

## Demo account

| Role             | Email             | Password   | Data                                    |
| ---------------- | ----------------- | ---------- | --------------------------------------- |
| Demo workspace   | `demo@ecomai.app` | `demo1234` | 245-SKU catalog, ~29k sales records, forecasts, simulations |

New signups start with an **empty workspace** and walk through the 3-step onboarding
(Add Products → Import Sales Data → Generate Forecast). Every user's data is generated
deterministically from their account and isolated per-user.

## Swapping mock data for the real backend

All page data flows through service modules in `src/services/`:

```
src/services/index.js          # re-exports per-domain namespaces + USE_REMOTE_API switch
src/services/{auth,forecast,simulation,inventory,recommendation,dashboard,settings,sales}Service.js
src/services/mock/db.js        # in-memory MockUserDB (products, sales, forecasts, activity)
src/services/mock/catalog.js   # 245-SKU catalog generator + value calibration
```

To connect the real API:

1. Set `USE_REMOTE_API = true` in `src/services/index.js`.
2. Implement each service using `src/api/client.js` (Axios instance pointing at the
   Vite `/api` proxy) with the same return shapes the pages already consume.
3. No component or page changes required.

The mock layer intentionally reproduces network latency (`latency()`), so loading
skeletons and error handling behave identically against both backends.

## Sales CSV format

Uploads are validated row-by-row against the product catalog before import:

| Column       | Notes                                      |
| ------------ | ------------------------------------------ |
| `date`       | `YYYY-MM-DD`                               |
| `product_id` | product ID (`P001`) or SKU — must exist    |
| `units_sold` | whole number ≥ 0                           |
| `channel`    | optional (defaults to `Import`)            |

Invalid rows are reported inline (bad dates, unknown products, non-whole units) and
never imported silently. A sample template can be downloaded from the Sales Data page.

## Project structure

```
src/
  App.jsx                     # router, route guards, lazy-loaded pages, providers
  main.jsx                    # entry, provider wiring, toast viewport
  context/
    AuthContext.jsx           # session state (login/signup/logout/refresh)
    DataContext.jsx           # notifications + cross-page data refresh signal
    ToastContext.jsx          # toast actions (stable) + toast state (viewer)
  services/                   # swappable data layer
  components/
    layout/                   # AppShell, Sidebar, Header, Logo
    ui/                       # Button, Card, Badge, Modal, EmptyState, Skeleton, form, ...
    charts.jsx                # Recharts wrappers (demand, donut, stock line, bars)
    DataTable.jsx, KPICard.jsx, ProductCard.jsx, ProductForm.jsx,
    UploadDropzone.jsx, RecommendationCard.jsx, SimulationConfig.jsx, SimulationResults.jsx
  pages/
    auth/                     # Login, Signup, ForgotPassword, ResetPassword
    DashboardPage.jsx         # KPIs + onboarding empty state + demand chart
    InventoryPage.jsx         # stock table, filters, pagination
    ProductsPage.jsx          # catalog grid + CRUD
    ProductDetailPage.jsx     # per-product intelligence + inventory timeline
    SalesDataPage.jsx         # 4-step CSV upload + validation + records explorer
    ForecastPage.jsx          # AI demand forecast + product table
    RecommendationsPage.jsx   # prioritized plain-language actions
    SimulationPage.jsx        # policy comparison (Current/Conservative/Aggressive)
    SettingsPage.jsx          # profile, store, notifications, security
    NotFoundPage.jsx
```

## Design system

- Light enterprise SaaS aesthetic: deep indigo `brand` palette, slate neutrals,
  green/amber/rose for healthy/warning/critical states.
- Rounded cards with subtle borders (`shadow-soft`, `ring-1 ring-slate-200`).
- Status colors drive meaning everywhere (badges, dot menus, charts).
- Reusable primitives in `src/components/ui` + `tailwind-merge` helper in `src/lib/utils.js`.

## Notes

- Auth is mocked via `localStorage` (see `src/services/authService.js`). Swap for JWT
  endpoints when the backend is ready.
- Key numeric proofs (seeded deterministically): 245 products, 20 critical,
  32 to reorder, 21 overstocked, 8 stockout-risk, inventory value ≈ ₹12.4L.