-- EcomAI-OS — canonical tenant product metadata.
-- Apply after 0002_sales_upsert.sql. Product rows are separate from sales so a
-- catalog update cannot rewrite historical demand.

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
