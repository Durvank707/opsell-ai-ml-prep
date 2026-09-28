# EcomAI-OS — Onboarding UX & importer-aligned upload templates — Final Report

Scope: lead-time-correct replenishment (V1/V2, shipped previously) plus the new
new-tenant data onboarding work (templates, required/optional columns, and the
feature-engineering explainer). Part 1 (audit) preceded and drove Part 2
(implementation); Part 3 (validation) follows.

---

## A. MODEL_FEATURES mapping (supplied/derived, missing behaviour, can-train verdict)

`MODEL_FEATURES` (backend/services.py:42, shared by train.py and V2) =
`price, discount, promotion, day_of_week, month, is_weekend, lag_1, lag_7,
lag_14, lag_28, rolling_mean_7, rolling_mean_14, rolling_mean_28, rolling_std_7`.

| Feature | Supplied or derived | Upload source | Missing / new-tenant behaviour | Can-train-from-schemas? |
|---|---|---|---|---|
| `price` | Supplied | Sales `price`, else product `unit_price`; last history value repeated at serving | Optional; flagged if a product has none anywhere → labeled baseline | Yes (row or catalog) |
| `discount` | Supplied (training only) | **None** — not in either upload contract; serving forces `0` | Implicitly `0` (in range) — the trained effect is inert for upload-driven forecasting | Yes, as constant `0` |
| `promotion` | Supplied | Sales `promotion` (0/1); enriched `False` when absent | Optional; gates ML eligibility; ordinary forecasts assume future `0` | Yes (row or enriched) |
| `day_of_week` | Derived from `date` (train & serve) | — | Always regenerated; no input needed | Yes |
| `month` | Derived from `date` (train & serve) | — | Always regenerated; no input needed | Yes |
| `is_weekend` | Derived from `date` (train & serve) | — | Always regenerated; no input needed | Yes |
| `lag_1` | Derived from `units_sold` (recursive at serve) | — | Derived; short series handled defensively | Yes |
| `lag_7` / `lag_14` / `lag_28` | Derived from `units_sold` (recursive at serve) | — | Derived; short series handled defensively | Yes |
| `rolling_mean_7/14/28` | Derived from `units_sold` | — | Derived from `units_sold` | Yes |
| `rolling_std_7` | Derived from `units_sold` | — | Derived from `units_sold` | Yes |

Nothing is mocked or silently replaced: when a required model input cannot be
established, the eligibility gate refuses ML and returns a **labeled** baseline.
`channel`, `category`, `product_name` are not MODEL_FEATURES (business key /
gate / display only).

## B. Claimed-vs-actual mismatches (unchanged by this work)

1. **`discount`** is a MODEL_FEATURE that tenants cannot supply (no upload
   column) and is locked at `0` at serving → the trained effect on that feature
   never shifts upload-driven forecasts. Documented, not "fixed".
2. **`promotion`** can be uploaded and gates ML eligibility, but the ordinary
   forecast always assumes future `promotion = 0`.
3. The seed `sales.csv` carries redundant `day_of_week/month/is_weekend`
   columns; train and serve regenerate them from `date`. The upload schema is
   correct to omit them.
4. ML requires ≥90 distinct observation days, non-empty known category, valid
   `price`/`promotion` per row and whole non-negative units; otherwise a
   transparent baseline is used — surfaced in the onboarding copy.

## C. Feature-explanation grounding

The "How forecasting works" explainer shown on the Sales upload claims exactly
what the serving pipeline derives and nothing more:

- "previous-day sales" ↔ `lag_1`
- "weekly history" ↔ `lag_7`, `lag_14`, `lag_28`
- "rolling demand statistics" ↔ `rolling_mean_7/14/28`, `rolling_std_7`
- "calendar information — day of week, month and weekend flags" ↔
  `day_of_week`, `month`, `is_weekend`

The mandatory sentence is present verbatim: *"You provide your normal business
data. EcomAI-OS automatically creates the forecasting features required by the
ML model."* It does **not** claim discount/promotion auto-creation (both default
to `0` at serving). Grounded in code by tests
`test_model_features_split_into_supplied_and_derived_is_exact` and
`test_derived_features_the_copy_claims_are_actually_built` (they assert
`DERIVED_SERVING_FEATURES | CUSTOMER_SUPPLIED_FEATURES == MODEL_FEATURES` and
that the real feature modules build exactly those derived columns).

## D. What changed

Backend
- `backend/contracts.py`: `ONBOARDING_TEMPLATES` — products template = the full
  `PRODUCT_RECORD` canonical field set (14 columns); sales = the 7 `SALES_RECORD`
  fields; example rows import with zero errors/warnings. Plus
  `onboarding_template(record_type)` (raises `ValueError` for unknown types).
- `backend/routers/v2.py`: `GET /api/v2/templates/{record_type}` — auth-gated
  (router-level `require_auth` + token/user binding), `text/csv`,
  `Content-Disposition: attachment`, 422 for unknown record types.
- `tests/test_onboarding_templates.py` (12 tests): template headers ==
  importer-accepted columns (and *not* a superset with ML columns); example
  rows validate with 0 rejected / 0 schema problems / 0 warnings; fresh tenant
  ingests products-then-sales templates end-to-end via `/api/v2/ingest`;
  120-day uploaded template-style history reaches the real XGBoost model
  (`fallback_used == "ml"`, 30 points); sparse history is a labeled baseline;
  endpoint 401 / 200 CSV / 422; copy↔pipeline ground truth.

Frontend
- `services/api/validation.js` (new): `readCsv`, `pollValidationJob`,
  `withoutRejectedRows`, `toValidationReport` extracted from `api/sales.js`.
- `services/api/http.js`: `fetchTemplate` (returns raw CSV text via
  `requestV2`).
- `services/api/sales.js`: refactored onto the shared helpers;
  `downloadSalesTemplate(user)`.
- `services/api/catalog.js`: `validateProductsCsv`, `uploadProductsCsv`,
  `downloadProductTemplate` (recordType `'product'`).
- `services/salesService.js`: `downloadSalesTemplateCsv(user)` (api fetch +
  mock local template, which is byte-identical to the server template).
- `services/productsService.js`: `PRODUCT_CSV_TEMPLATE` (matches server),
  `validateProductCsv`, `uploadProductCsv`, `downloadProductTemplateCsv`.
- `services/mock/db.js`: `importProductRows`.
- `components/UploadDropzone.jsx`: configurable `hint` + `onDownloadTemplate`
  (keeps `onDownloadSample` alias).
- `components/ImportGuide.jsx` (new): required/optional column lists per record
  type + mandatory sentence + sales "How forecasting works" panel.
- `components/importFlow.jsx` (new): shared `ImportStepsIndicator`, `UploadPhase`,
  `ImportStats`, `ErrorsList` (extracted from SalesDataPage).
- `components/ImportProductsModal.jsx` (new): 4-phase products CSV import modal.
- `pages/SalesDataPage.jsx`: idle phase shows the sales `ImportGuide` +
  template download; shared import-flow components; guide under the dropzone.
- `pages/ProductsPage.jsx`: "Import Products (CSV)" button + modal.

Docs: `docs/onboarding-ml-audit.md` (Part 1 audit, updated to the final
14-column products template decision).

## E. Validation results

- `tests/test_onboarding_templates.py`: **12 passed**.
- Full backend suite: **519 passed** (was 507 at `4d569d5`; includes
  `test_ui_api`, `test_ingest`, `test_intelligence`, `test_catalog_fields`,
  `test_v2_replenishment_policy` and every other module).
- Frontend `npm run build` (vite): **passes** (2281 modules).
- Live server (:8000, uvicorn --reload): `GET /api/v2/templates/sales` →
  **401** without a token (route live + auth-gated).
- Frontend tests: none exist in the repo (pre-existing gap); the template/graph
  claims are pinned by the backend tests above instead.

## F. Remaining / blocked

- Live end-to-end with a *signed-in* tenant (upload product template → sales
  template → forecast page shows ML rather than baseline) still requires a
  working password-reset/sign-in: enable custom SMTP in Supabase and add
  `http://localhost:5173/reset-password` to the redirect allow-list; then run
  forgot-password for `durvankjagtap707@gmail.com`. Everything short of that
  step is covered by TestClient integration tests that run the real router,
  auth, ingest pipeline and XGBoost model.
- Pre-existing, out of scope (unchanged): no frontend test framework, no CI,
  `V1_ENABLED` should be false before non-local deploy, RLS off service-role
  key, ~1.2 s blocking XGBoost on async V2 GET routes.