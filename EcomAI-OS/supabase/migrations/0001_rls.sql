-- EcomAI-OS — additive RLS migration for tenant-scoped sales.
--
-- Apply this migration to a real Supabase project before exposing user-facing
-- table access.  The application still scopes every query by user_id; this
-- database policy is the second, mandatory boundary for direct/user clients.
-- The service-role key is intentionally server-only.  Supabase's service role
-- bypasses RLS, so the server must continue to add user_id predicates when it
-- uses that key; no secret or privileged client belongs in a browser.
--
-- Apply 0000_sales_schema.sql first (or confirm that the canonical
-- ``public.sales`` table already exists with the columns used by the backend).
-- This migration does not invent or rewrite product data.

alter table public.sales enable row level security;

-- Idempotent policy installation for environments where this migration is
-- applied more than once during local verification.
drop policy if exists "tenant_isolation_sales_select" on public.sales;
drop policy if exists "tenant_isolation_sales_insert" on public.sales;
drop policy if exists "tenant_isolation_sales_update" on public.sales;
drop policy if exists "tenant_isolation_sales_delete" on public.sales;

create policy "tenant_isolation_sales_select" on public.sales
  for select
  using (user_id = auth.uid()::text);

create policy "tenant_isolation_sales_insert" on public.sales
  for insert
  with check (user_id = auth.uid()::text);

create policy "tenant_isolation_sales_update" on public.sales
  for update
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

create policy "tenant_isolation_sales_delete" on public.sales
  for delete
  using (user_id = auth.uid()::text);
