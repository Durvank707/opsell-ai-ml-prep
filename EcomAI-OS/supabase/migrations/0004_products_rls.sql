-- EcomAI-OS — tenant RLS for canonical products.
-- The server still scopes every service-role request by user_id; these
-- policies protect direct/user clients and defense in depth.

alter table public.products enable row level security;

drop policy if exists "tenant_isolation_products_select" on public.products;
drop policy if exists "tenant_isolation_products_insert" on public.products;
drop policy if exists "tenant_isolation_products_update" on public.products;
drop policy if exists "tenant_isolation_products_delete" on public.products;

create policy "tenant_isolation_products_select" on public.products
  for select
  using (user_id = auth.uid()::text);

create policy "tenant_isolation_products_insert" on public.products
  for insert
  with check (user_id = auth.uid()::text);

create policy "tenant_isolation_products_update" on public.products
  for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "tenant_isolation_products_delete" on public.products
  for delete
  using (user_id = auth.uid()::text);
