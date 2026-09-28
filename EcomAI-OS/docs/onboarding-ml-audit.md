# Onboarding data vs. XGBoost feature pipeline — audit (Part 1)

Status: audit only (no code changed). Findings drive the onboarding UX work in
Part 2.

## The model's feature list

`backend/services.py::MODEL_FEATURES` is the single feature list — imported by
`train.py`, the V1 service and the V2 tenant pipeline:

```
price, discount, promotion,
day_of_week, month, is_weekend,
lag_1, lag_7, lag_14, lag_28,
rolling_mean_7, rolling_mean_14, rolling_mean_28, rolling_std_7
```

## Supply: provided vs. derived, and missing behaviour

| Feature | Source | Missing / new-tenant behaviour |
|---|---|---|
| `price` | Customer-supplied: sales row `price`, else product `unit_price` (enriched at serving). At serving the *last* row's price is used for all forecast days. | Optional in upload. If a product has no price anywhere, the ML gate flags `price` → safe baseline fallback (labeled). |
| `discount` | Training-only column of `data/raw/sales.csv`. **Not** in the canonical sales upload contract; **never** set at serving (always `0`, scenarios only). | Cannot be supplied by a tenant at all. Feature satisfied implicitly as `0` (in range) — the trained coefficient is inert for upload-driven forecasting. Mismatch #1. |
| `promotion` | Customer-supplied sales column (0/1) at training. At serving it exists only via scenario overrides; the ordinary forecast assumes future `promotion = 0`. Missing rows are enriched to `False` for the gate. | Optional. Enriched when absent. Uploaded promo history gates ML eligibility but does **not** shift future forecasts. Mismatch #2. |
| `day_of_week` `month` `is_weekend` | **Derived** from `date` at train (`create_time_features`) and at serving (from the forecast day). | Always derived; no input needed. |
| `lag_1/7/14/28` | **Derived** from `units_sold` per product (`create_lag_features`); recursive at serving (predictions feed back). | Derived from `units_sold`; short series handled defensively. |
| `rolling_mean_7/14/28`, `rolling_std_7` | **Derived** from `units_sold` (`create_rolling_features`, shift(1) at train; trailing window at serving). | Derived from `units_sold`. |

Nothing is mocked or silently replaced: when an optional model input cannot be
established the eligibility gate refuses ML and returns a **labeled** baseline
instead.

## Can the trained model forecast from the current Products + Sales schemas?

Yes. The canonical upload contracts — `PRODUCT_RECORD` and `SALES_RECORD` in
`backend/contracts.py` — provide everything the model's serving path needs:

- `price`: sales row or product `unit_price`.
- `promotion`: sales row or enriched `False`.
- Calendar, lags, rolling: derived from `date` + `units_sold`.
- `discount`: the only feature a tenant cannot influence (always `0` at
  serving) — it does not block forecasting.

`channel`, `category`, `product_name` are **not** MODEL_FEATURES. `channel` is
the sales business key (demand is forecast on the combined daily series);
`category` feeds the eligibility gate and inventory logic, not the regressor.

## Template column decisions (final)

- **Products template = the full `PRODUCT_RECORD` canonical field set (14
  columns).** `TenantWorkspace._build_product_row` persists 12 of them;
  `reorder_point` and `forecast_error_std` are contract-optional fields the
  workspace accepts but does not persist. They are still included so that a
  plain template download imports with **zero** validation warnings — omitting
  them makes the validator flag every row with "Optional field is not mapped".
- **Sales template = the 7 `SALES_RECORD` canonical fields.**
- Neither template carries ML feature columns (`lag_*`, `rolling_*`,
  `day_of_week`, …): the pipeline derives those, and `discount` is not part of
  either upload schema.

## Claimed-vs-actual mismatches to document

1. `discount` (a MODEL_FEATURE) cannot be supplied through the current upload
   schema and is locked at `0` at serving.
2. `promotion` is required by the eligibility gate and can be uploaded, but the
   ordinary forecast always assumes future `promotion = 0`.
3. The seed `sales.csv` carries redundant `day_of_week/month/is_weekend`
   columns; both the training script and the serving path regenerate them from
   `date`. The upload schema is correct to omit them.
4. The ML gate requires a non-empty, known category and 90+ distinct observation
   days before ML is allowed; anything less is a labeled baseline. This is by
   design (§15–17/§42/§43) and must be surfaced in the onboarding copy.

## ML eligibility gate thresholds (for the onboarding copy)

- `< 30 days` → baseline ("Cold start")
- `30–89 days` → baseline with limited-history warning
- `90+ days` → ML allowed (limited confidence until 180; preferred 180–364;
  annual 365+)

Plus: rows must carry `price` and `promotion` (enriched when missing), valid
dates, whole non-negative units, no duplicate dates, and known category.