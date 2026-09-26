-- EcomAI-OS — product selling price, supplier and description.
--
-- These three columns are additions to the canonical PRODUCT_RECORD contract
-- (see backend/contracts.py). None of them is a new modality: each one already
-- had a home in the application UI, and without a column to hold it the value a
-- tenant typed was accepted by the API and then lost on the next read.
--
--   unit_price  USED by ML. It is the price a sales row falls back to when the
--               row itself carries none, so a product with no stored price fed
--               the forecaster a price of zero rather than a missing value.
--   supplier    IGNORED by ML. Display-only supplier label.
--   description IGNORED by ML. Display-only product description.
--
-- All three are nullable and additive: an existing products row keeps working
-- and reports the same values it did before, with these fields absent.

alter table public.products
  add column if not exists unit_price numeric
    check (unit_price is null or unit_price >= 0),
  add column if not exists supplier text,
  add column if not exists description text;

comment on column public.products.unit_price is
  'Catalog selling price; the price a sales row falls back to when it carries none.';
comment on column public.products.supplier is
  'Display-only supplier label. Not read by the forecaster or inventory engine.';
comment on column public.products.description is
  'Display-only product description. Not read by the forecaster or inventory engine.';
