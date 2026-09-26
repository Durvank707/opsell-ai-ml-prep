-- EcomAI-OS — canonical sales table for the server-side PostgREST adapter.
--
-- Apply this migration before 0001_rls.sql and 0002_sales_upsert.sql.  It is
-- intentionally limited to the canonical sales boundary; product metadata
-- remains a separate persistence concern until its own migration is added.
--
-- user_id is text because the V2 contract stores the verified JWT subject as a
-- stable string. The server derives it from the signed token; callers cannot
-- select another tenant by changing a request user_id.

create table if not exists public.sales (
  user_id text not null,
  product_id text not null,
  date date not null,
  units_sold integer not null check (units_sold >= 0),
  price numeric,
  category text,
  promotion boolean,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.sales is
  'Canonical tenant-scoped daily sales; application writes always include user_id.';
comment on column public.sales.user_id is
  'Application tenant identity; every server query must scope by this column.';
