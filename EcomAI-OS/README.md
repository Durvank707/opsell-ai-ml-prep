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

Managed providers may use asymmetric verification instead. Exactly one
algorithm is accepted at a time, on purpose: accepting two would widen the
verification surface.

```dotenv
# RS256 (RSA)
JWT_ALGORITHM=RS256
JWT_PUBLIC_KEY=<server-side PEM public key>
# or: JWT_JWKS_URL=https://provider.example/.well-known/jwks.json

# ES256 (ECDSA P-256) -- Supabase Auth's default
JWT_ALGORITHM=ES256
JWT_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
```

The token header cannot select an algorithm or key source. The public key and
JWKS URL are server configuration; never place either a private key or a
Supabase service-role key in the browser.

`JWT_KEY_ID` optionally pins the signing key, and binds whichever key source is
in use — a static PEM or a JWKS. It is worth setting for a provider that rotates
keys: a token signed with any other key is then refused rather than accepted.

ES256 is the only algorithm that needs the `cryptography` package
(`requirements.txt`). It is imported lazily, so an `HS256` or `RS256` deployment
neither needs it installed nor fails to start without it, and a server configured
for `ES256` without it rejects every token rather than accepting an unverified
one. The JOSE signature is the raw `r‖s` pair, not the DER form, and only
P-256 is accepted; a coordinate of the wrong length or a point that is not on
the curve is rejected when the key is loaded, not when a signature fails.

For an entirely offline end-to-end login, an operator may explicitly set
`LOCAL_AUTH_ENABLED=true`, `AUTH_MODE=jwt`, and a 32-byte `JWT_SECRET` in a
non-production, non-Supabase environment. The optional `/api/auth/signup`,
`/api/auth/login`, and `/api/auth/me` routes use a salted PBKDF2 password hash
and issue short-lived HS256 tokens. This local issuer is not a replacement for
email verification, refresh rotation, or a production identity provider.

#### Account management (Supabase Auth)

Sign-in, sign-up, and the four other session routes are issuer-aware: they work
against whichever provider holds the account, and return the same envelope either
way, so switching identity providers is a configuration change.

| Endpoint | Purpose | Credential |
| --- | --- | --- |
| `POST /api/auth/signup` | create an account | none |
| `POST /api/auth/login` | start a session | email + password |
| `POST /api/auth/refresh` | renew an access token | refresh token |
| `GET /api/auth/me` | read the signed-in account | session bearer |
| `POST /api/auth/logout` | revoke this session | session bearer / refresh token |

`LOCAL_AUTH_ENABLED` and `USE_SUPABASE` are mutually exclusive, so there is never
a tie to break and never a fallback from one issuer to the other: with neither
enabled these routes return `503` rather than falling through.

Under Supabase, all of these are public operations except `/me` and the account
actions, and they carry only the **publishable** key. Establishing a session
never involves a privileged credential.

The six **account** actions are separate and are Supabase-only, because the local
issuer has no reset-token, revocation, or deletion story to route them to:

| Endpoint | Purpose | Credential |
| --- | --- | --- |
| `POST /api/auth/password-reset` | email a recovery link | none |
| `POST /api/auth/reset-password` | set the new password | recovery token |
| `PATCH /api/auth/me` | update name / business name / email | session bearer |
| `POST /api/auth/change-password` | change password | session bearer + current password |
| `POST /api/auth/logout-all` | revoke other refresh tokens | session bearer |
| `DELETE /api/auth/me` | delete the account and its rows | session bearer + current password |

These are gated on Supabase Auth being configured, not on the local issuer, so
they are unavailable — with an honest `503` — under a local-only deployment.

Four properties are deliberate:

* **No token is ever returned to the browser for a reset request.** The recovery
  token is emailed by Supabase Auth and comes back in the redirect URL's
  fragment; the frontend reads it there and hands it straight to
  `POST /api/auth/reset-password`, which forwards it to `PUT /auth/v1/user` with
  the *publishable* key. The service-role key is only used for `/admin/*` paths
  and never leaves `backend/supabase_auth.py`.
* **`password-reset` cannot be used to enumerate accounts.** The response is
  byte-identical for a registered address and an unknown one. A 4xx from GoTrue
  (unknown address, or a rate limit) is swallowed for the caller but logged as a
  warning, because a rejected `redirect_to` looks the same from outside and an
  operator needs to see it. A 5xx is **not** swallowed: that means the mail may
  not have gone out, and reporting success would leave someone waiting for a
  message that never arrives.
* **The account routes address GoTrue by the signed `sub` only.** A caller
  cannot manage another account by naming it, and the address used to verify a
  current password is read from the verified token, not the request body.
* **`DELETE /api/auth/me` purges the tenant's own rows** in paged batches
  (PostgREST caps one response, so an un-paginated delete can leave rows behind
  while reporting success). If the purge fails after the account is gone, the
  response says exactly that rather than reporting a clean deletion.

#### Sessions and account enumeration

A Supabase access token lasts about an hour, so `POST /api/auth/refresh` trades
the stored refresh token for a new one and the frontend renews automatically
before sending a request with an expired token. Supabase **rotates** the refresh
token on every renewal, so the replacement has to be stored and concurrent
renewals have to share one in-flight request — otherwise a second caller would
present a token the first had just consumed and sign the user out mid-session.
The local issuer mints stateless tokens, so `/refresh` answers `503` there rather
than pretending to renew something.

`POST /api/auth/logout` revokes with **both** credentials when the browser sends
them: the access token as the bearer, the refresh token in the body. The bearer
authorizes the call and the refresh token names the exact session to destroy
rather than whichever one the bearer happens to map to. Both are needed —
GoTrue answers a body-only `/logout` with `401 no_authorization` and revokes
nothing, which would leave the caller believing a session was destroyed that is
still live.

Because the bearer is required, a session whose access token has already expired
cannot revoke itself. The frontend renews first in that case, so a sign-out
cannot strand a live refresh token. If that renewal fails there is nothing left
to revoke — a refresh token the provider will not accept is already dead — so
the browser clears its tokens and signs out locally without issuing a request
guaranteed to be rejected.

Five enumeration and honesty properties are deliberate:

* **`login` cannot be used to discover which addresses have accounts.** Every
  credential failure is one `401` with the same message, whatever GoTrue
  actually said — including the different answer a project with "Confirm email"
  gives for an unconfirmed account. "Check your inbox" guidance is deliberately
  *not* produced there; it belongs to `signup`, where the address cannot already
  belong to somebody else.
* **A `429` stays a `429`.** A throttle is neither a credential verdict nor a
  secret, and reporting it as a wrong password would send the user to reset it
  for no reason.
* **`signup` reports a confirmation requirement instead of faking a sign-in.**
  With "Confirm email" on, GoTrue creates the account and issues no session. The
  response says `confirmation_required: true` with an empty `access_token`, and
  the signup page says to check the inbox — rather than storing an empty
  credential that fails on the first protected request.
* **On this API, `401` means one thing only: the session credential is not
  acceptable.** Every `401` comes from the auth dependency and carries
  `WWW-Authenticate: Bearer`, and the browser keys its "sign the user out" logic
  on exactly that. An endpoint refusing an otherwise-authenticated caller
  therefore uses `403` — a wrong current password on `change-password` or
  `DELETE /me` is understood-and-refused, not unauthenticated. Returning `401`
  there was a real bug: the client discarded its tokens and threw the user back
  to the login page instead of telling them to retype their password.
* **Changing a password signs you out immediately.** The password is set through
  the Supabase admin API, which revokes the refresh session behind the caller's
  own access token. Left alone, the tab keeps working on a stateless access token
  for up to an hour and then fails every request with "your session has ended"
  for no visible reason. The Settings page signs out at the moment of the change
  and says why.

`POST /api/auth/logout` is the one place a failure is not surfaced to the caller.
It still answers `200` when nothing is configured, and still answers `200` when
GoTrue declines the revocation, because the caller's own sign-out genuinely
succeeded and a failed sign-out would strand a token in the browser with no way
to clear it. The revocation failure is **not** swallowed silently: it is logged
as a warning naming the reason, because the refresh token is still live and an
operator has to be able to see that.

#### Password reset: what to configure in Supabase

`PASSWORD_RESET_REDIRECT_URL` is the page the emailed link lands on. It must be
an absolute `http(s)` URL and must be allow-listed, or GoTrue rejects the request
and no mail is sent:

```dotenv
PASSWORD_RESET_REDIRECT_URL=http://localhost:5173/reset-password
```

In the Supabase dashboard, under **Authentication → URL Configuration**:

* **Site URL** — the app's origin (used when a link omits an explicit target).
* **Redirect URLs** — add `http://localhost:5173/reset-password` and the
  production equivalent. A `redirect_to` that is not allow-listed is *not*
  honored; GoTrue falls back to the Site URL, so the link would land somewhere
  useless rather than failing loudly.

Email delivery uses Supabase Auth's own mailer. Its **built-in SMTP is rate
limited to a couple of messages per hour and only to project members**, which is
enough to confirm the flow works and not enough to use. For real traffic,
configure **Authentication → Email → SMTP Settings** (or the newer
**Email → SMTP** section) with a transactional provider such as Resend,
Postmark, or SendGrid:

| Dashboard field | Value |
| --- | --- |
| SMTP host | your provider's host, e.g. `smtp.resend.com` |
| SMTP port | `587` (or `465` for implicit TLS) |
| SMTP username | the provider's username or API key |
| SMTP password | the provider's SMTP key |
| Enable TLS | on (required by every provider listed above) |

Those values live in the **Supabase dashboard**, not in this repository's
`.env`. This backend needs **no new environment variables** for password reset —
it reuses `SUPABASE_URL` plus the existing publishable and service-role keys,
both of which stay server-side. Do not add the SMTP password to `.env.example`
or to any tracked file.

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
`0008_product_price_and_display_fields.sql` and
`0009_sales_channel.sql`. Every statement is idempotent, so re-running is safe.
`scripts/probe_supabase.py` then confirms connectivity and which tables exist
without printing any key material.

`0008` is required, not optional. It adds the three nullable columns the product
record and the product form need beyond the original schema — `unit_price`,
`supplier` and `description`. Without it a product saves but its selling price
and supplier are dropped on the way to the database, and every forecast built
from that history sees a price of `0`. The columns are nullable and additive
precisely so the migration cannot lose existing rows.

`0009` is also required. It adds the sales `channel` column and widens the sales
upsert key from `(user_id, product_id, date)` to
`(user_id, product_id, date, channel)`, so one product can be recorded once per
channel on a given day. Existing rows are labelled `unrecorded` — the UI shows
that as "Not recorded" — and nothing is attributed to a channel that did not
claim it. The column is `NOT NULL` with a default rather than nullable on
purpose: `NULL`s are distinct in a unique index, so a nullable channel would
make every unchanneled row its own key and a re-upload would silently duplicate
history instead of updating it.

#### Re-uploading an old CSV after `0009`

Because the key now includes `channel`, a re-upload of a file that states no
channel will not match a row previously attributed to a real channel, and will be
inserted as a separate `unrecorded` record. That is the intended consequence of
keying on the channel, not a bug — but it is worth knowing before backfilling
history. The same product/date/channel combination still updates in place.

#### Never put credentials in `.env.example`

`.env` is git-ignored. `.env.example` is **tracked** and must contain
placeholders only. Put real values in `.env`; a committed template leaks the
service-role key to every clone and to the repository history, where removing
it later does not un-leak it. If a real key ever lands in a tracked file,
rotate it in the Supabase dashboard.

#### Row-level security and the identity mismatch

The migrations enable RLS with policies of the form
`user_id = auth.uid()::text`. **Whether these match how the application
identifies a tenant now depends entirely on which issuer is configured**, and
under the local issuer they are inert.

* The app's tenant identity is the JWT `sub` claim.
* Under the **local** issuer `sub` is an email-shaped string such as
  `demo@ecomai.app`. `auth.uid()` returns a UUID from a Supabase Auth session, and
  an email is never equal to a UUID, so these policies match no row.
* Under **Supabase Auth** the two are the same value: GoTrue sets `sub` to the
  auth user's UUID, so `user_id = auth.uid()::text` does match. This is verified
  against a live project, not inferred — see below.
* The backend authenticates to PostgREST with the **service-role key, which
  bypasses RLS entirely**. Isolation today comes from application-level scoping,
  not from the database, whichever issuer is in use.

Verified with the publishable key, all three tables return `0` rows.

So there is currently **one** isolation boundary, not two. That is not a
shortcut that was taken to make the app work — it is a consequence of the
service-role connection above, and it should be resolved before the service
handles untrusted traffic. Two coherent options:

1. **Adopt Supabase Auth as the identity provider.** Sign users in through
   Supabase Auth so `sub` *is* `auth.uid()`, and the existing policies start
   matching. This is the option that makes the database a genuine second layer
   and is the prerequisite for any direct-from-client access.
2. **Service-role-only, deliberately.** Keep the service-role connection, drop
   the client-facing RLS policies, and document that the application boundary is
   the only boundary. Acceptable only while the API is the sole client and the
   service-role key never leaves the server.

Option 1 is the target state, and the two things that stood in its way are now
in place:

1. **ES256 verification.** Supabase signs access tokens with ES256 — the
   project's JWKS serves a single `kty=EC, crv=P-256` key — and
   `SUPPORTED_JWT_ALGORITHMS` in `backend/auth.py` was `{"HS256", "RS256"}`, so
   every real Supabase session token was rejected with "JWT algorithm is not
   accepted" before any tenant check ran. The verifier now handles ES256, and a
   genuine Supabase token verifies against the real JWKS.
2. **Supabase sign-in.** `signup`/`login` were local-issuer only and returned
   `503` under `USE_SUPABASE=true`, so after resetting a password there was no
   way to obtain a Supabase-issued session through this API. The session routes
   are now issuer-aware.

To run this way, the two environment changes are:

```dotenv
JWT_ALGORITHM=ES256
JWT_JWKS_URL=https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
```

Two things to be clear about, because neither is finished by the above:

* **RLS still does not protect anything while the service-role key is what the
  backend uses for PostgREST.** Matching identities are a prerequisite, not the
  change. To make the database a real second layer, the data routes have to
  present the caller's own token (or `anon`) to PostgREST instead of the
  service-role key. That is the remaining work in option 1.
* **Email confirmation.** Supabase projects have "Confirm email" on by default.
  `signup` reports that requirement honestly and the page asks the user to check
  their inbox; nothing auto-confirms an address.

### 2. Frontend Setup & Run (React)

Launch the Vite development server:
```powershell
# In another terminal:
cd frontend
npm run dev
```
- Web Application: `http://localhost:5173`

Out of the box the UI serves its own mock data. To run it against this backend and
Supabase instead, put this in `frontend/.env.local`:
```dotenv
VITE_DATA_MODE=api
VITE_AUTH_MODE=backend
```
`VITE_AUTH_MODE=backend` routes sign-in, sign-up, and password changes through this
API's `/api/auth/*` endpoints, which hold the Supabase credentials server-side —
no Supabase key ever reaches the browser. `external` is the alternative for a host
application that injects its own access token; see `frontend/.env.example` and
`frontend/README.md` § *Data modes*. In `api` mode a failed request is reported on
the page; the app never falls back to generated data behind your back.

The dev server proxies `/api` to `http://localhost:8000`. To point it elsewhere
without editing `vite.config.js`, set `VITE_API_PROXY_TARGET` before `npm run dev`:
```powershell
$env:VITE_API_PROXY_TARGET="http://localhost:8011"
npm run dev
```

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
