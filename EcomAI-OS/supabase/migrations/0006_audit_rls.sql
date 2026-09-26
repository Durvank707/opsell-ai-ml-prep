-- EcomAI-OS — tenant RLS and append-only policy for audit history.
-- Application writes use the server-only service-role boundary and still
-- include an explicit user_id value. Direct clients may only see their own
-- tenant's records.

alter table public.audit_entries enable row level security;

drop policy if exists "tenant_isolation_audit_select" on public.audit_entries;
drop policy if exists "tenant_isolation_audit_insert" on public.audit_entries;

create policy "tenant_isolation_audit_select" on public.audit_entries
  for select
  using (user_id = auth.uid()::text);

create policy "tenant_isolation_audit_insert" on public.audit_entries
  for insert
  with check (user_id = auth.uid()::text);

-- Deliberately no update/delete policies: audit rows are append-only.
