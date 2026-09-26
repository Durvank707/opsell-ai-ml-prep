-- EcomAI-OS — complete, ordered Supabase schema.
--
-- Apply this single file in the Supabase SQL Editor for a new project, or
-- apply 0000..0006 individually in numeric order. Every statement is
-- idempotent, so re-running is safe.
--
-- Scope note: these tables are application-owned and always written through the
-- server-only service role with an explicit `user_id`. Row Level Security is a
-- second boundary for direct/user clients, not a replacement for application
-- scoping.

-- ===========================================================================
-- 1. Canonical sales
-- ===========================================================================

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

-- Deterministic PostgREST upsert key: one row per tenant/product/day.
create unique index if not exists sales_tenant_product_date_key
  on public.sales (user_id, product_id, date);

create index if not exists sales_user_date_idx
  on public.sales (user_id, date);

alter table public.sales enable row level security;

drop policy if exists "tenant_isolation_sales_select" on public.sales;
drop policy if exists "tenant_isolation_sales_insert" on public.sales;
drop policy if exists "tenant_isolation_sales_update" on public.sales;
drop policy if exists "tenant_isolation_sales_delete" on public.sales;

create policy "tenant_isolation_sales_select" on public.sales
  for select using (user_id = auth.uid()::text);
create policy "tenant_isolation_sales_insert" on public.sales
  for insert with check (user_id = auth.uid()::text);
create policy "tenant_isolation_sales_update" on public.sales
  for update using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);
create policy "tenant_isolation_sales_delete" on public.sales
  for delete using (user_id = auth.uid()::text);

-- ===========================================================================
-- 2. Canonical products
-- ===========================================================================

create table if not exists public.products (
  user_id text not null,
  product_id text not null,
  product_name text not null,
  category text,
  current_stock integer not null check (current_stock >= 0),
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),
  safety_stock numeric check (safety_stock is null or safety_stock >= 0),
  reorder_point numeric check (reorder_point is null or reorder_point >= 0),
  open_order_qty integer not null default 0 check (open_order_qty >= 0),
  unit_cost numeric check (unit_cost is null or unit_cost >= 0),
  expected_arrival_date date,
  forecast_error_std numeric check (forecast_error_std is null or forecast_error_std >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, product_id)
);

comment on table public.products is
  'Canonical tenant-scoped product and inventory metadata.';
comment on column public.products.user_id is
  'Verified application tenant identity; never selected from an untrusted request body.';

create index if not exists products_user_category_idx
  on public.products (user_id, category, product_id);

alter table public.products enable row level security;

drop policy if exists "tenant_isolation_products_select" on public.products;
drop policy if exists "tenant_isolation_products_insert" on public.products;
drop policy if exists "tenant_isolation_products_update" on public.products;
drop policy if exists "tenant_isolation_products_delete" on public.products;

create policy "tenant_isolation_products_select" on public.products
  for select using (user_id = auth.uid()::text);
create policy "tenant_isolation_products_insert" on public.products
  for insert with check (user_id = auth.uid()::text);
create policy "tenant_isolation_products_update" on public.products
  for update using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);
create policy "tenant_isolation_products_delete" on public.products
  for delete using (user_id = auth.uid()::text);

-- ===========================================================================
-- 3. Append-only audit history
-- ===========================================================================

create table if not exists public.audit_entries (
  id text primary key,
  user_id text not null,
  action text not null,
  product_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

comment on table public.audit_entries is
  'Append-only, tenant-scoped decisions and ingestion audit records.';
comment on column public.audit_entries.user_id is
  'Verified application tenant identity for this audit record.';

create index if not exists audit_entries_user_created_idx
  on public.audit_entries (user_id, created_at, id);

alter table public.audit_entries enable row level security;

drop policy if exists "tenant_isolation_audit_select" on public.audit_entries;
drop policy if exists "tenant_isolation_audit_insert" on public.audit_entries;

create policy "tenant_isolation_audit_select" on public.audit_entries
  for select using (user_id = auth.uid()::text);
create policy "tenant_isolation_audit_insert" on public.audit_entries
  for insert with check (user_id = auth.uid()::text);

-- Deliberately no update/delete policies: audit rows are append-only.
