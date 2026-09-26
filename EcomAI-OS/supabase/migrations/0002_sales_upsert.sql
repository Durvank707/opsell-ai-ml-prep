-- EcomAI-OS — canonical sales upsert key for PostgREST.
--
-- Apply after 0001_rls.sql.  The application scopes every request by
-- user_id; this unique index makes the explicit PostgREST upsert operation
-- deterministic and prevents duplicate tenant/product/day rows.
--
-- The table is expected to contain the canonical user_id, product_id, and date
-- columns described by the backend contract.  If an existing project already
-- has an equivalent constraint, IF NOT EXISTS keeps this migration additive.

create unique index if not exists sales_tenant_product_date_key
  on public.sales (user_id, product_id, date);
