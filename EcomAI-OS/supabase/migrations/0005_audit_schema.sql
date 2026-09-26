-- EcomAI-OS — append-only tenant audit history.
-- The application writes this table through the server-only PostgREST adapter.

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
