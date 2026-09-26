# EcomAI-OS Frontend

AI-powered inventory intelligence — a production-quality, light-themed SaaS dashboard for
demand forecasting, inventory health, recommendations and policy simulation.

Built with **React 18 + Vite + Tailwind CSS 3 + Recharts**. The UI runs against either a
self-contained mock backend or the real FastAPI + Supabase stack, selected by one
environment variable and with no page-level branching.

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

`mock` data mode only. There is no backend involved, so this account exists purely to
populate the UI.

| Role             | Email             | Password   | Data                                    |
| ---------------- | ----------------- | ---------- | --------------------------------------- |
| Demo workspace   | `demo@ecomai.app` | `demo1234` | 245-SKU catalog, ~29k sales records, forecasts, simulations |

New signups start with an **empty workspace** and walk through the 3-step onboarding
(Add Products → Import Sales Data → Generate Forecast). Every user's data is generated
deterministically from their account and isolated per-user.

## Data modes: mock or the real backend

Page data flows through the service modules in `src/services/`. Each one branches on
`VITE_DATA_MODE` and resolves to either branch, and both return the same shape, so no
page knows which one it is reading:

```
src/services/{auth,forecast,simulation,inventory,recommendation,dashboard,settings,sales}Service.js
  ├─ VITE_DATA_MODE=mock → src/services/mock/*   # in-memory MockUserDB, deterministic per user
  └─ VITE_DATA_MODE=api  → src/services/api/*    # FastAPI + Supabase, via src/api/client.js
```

Set it in `frontend/.env.local` (see `.env.example`):

```
VITE_DATA_MODE=api
```

`mock` is the default and needs no backend. `api` talks to the real stack through the
Vite `/api` proxy: `src/api/client.js` attaches the bearer token held by
`src/api/tokenStore.js`, and `src/services/api/adapters.js` maps the backend's canonical
snake_case records onto the camelCase objects the pages already consume. That adapter
layer is the only place the two vocabularies meet, so a backend field rename is a
one-file change rather than a sweep through the UI.

**In `api` mode nothing falls back to mock data.** A failed request surfaces as an error
on the page; generated rows are never substituted for a server that did not answer. An
unrecognised `VITE_DATA_MODE` throws at module load rather than defaulting, so a typo
cannot quietly serve mock data during what looks like a live run.

Auth is configured separately, by `VITE_AUTH_MODE` (`mock` | `backend` | `external`); see
below.

For the opt-in local FastAPI issuer, set `VITE_AUTH_MODE=backend`, enable
`LOCAL_AUTH_ENABLED=true` in the backend environment, and use a real
`JWT_SECRET` (32+ bytes). The backend returns a short-lived HS256 bearer token
and `/api/auth/me` restores the session; this mode is rejected in production
and with Supabase.

For a managed identity provider, set `VITE_AUTH_MODE=external` in
`frontend/.env.local`. The host provider can expose
`window.__ECOMAI_OS_AUTH__` with `login`, `signup`, `logout`, and account-action
methods, or the app can use the optional `VITE_AUTH_LOGIN_URL` /
`VITE_AUTH_SIGNUP_URL` endpoints. Issued access tokens are kept in
`sessionStorage` by `src/api/tokenStore.js`; `src/api/client.js` attaches them
as `Authorization: Bearer ...` and never uses the mock hash as a JWT. The
backend remains responsible for verifying the token and binding `sub` to the
tenant. The default `mock` mode remains fully local.

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
    SimulationPage.jsx        # policy backtest (one product at a time)
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

- Data comes from the mock database by default and from the FastAPI + Supabase backend
  when `VITE_DATA_MODE=api`; see [Data modes](#data-modes-mock-or-the-real-backend).
- Auth is mocked via `localStorage` by default (see `src/services/authService.js`).
  Set `VITE_AUTH_MODE=backend` only with the opt-in local FastAPI issuer, or set
  `VITE_AUTH_MODE=external` and provide a real identity-provider adapter when
  connecting the UI to the JWT-protected backend. Mock hashes are never sent as
  bearer tokens.
- Store settings (currency, default lead time, safety-stock method) and notification
  read state are browser-local in both data modes — there is no settings table. The
  Settings page says so on the card rather than implying they are stored server-side.
- Key numeric proofs (seeded deterministically, `mock` mode): 245 products, 20 critical,
  32 to reorder, 21 overstocked, 8 stockout-risk, inventory value ≈ ₹12.4L.