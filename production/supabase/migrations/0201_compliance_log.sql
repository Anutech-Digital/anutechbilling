-- 0201 — Compliance filing log.
--
-- Backs the new Compliance tracker (Pvt Ltd statutory calendar). Each row records
-- that a given obligation instance (obligation_key + period_key from the code
-- catalog in lib/compliance/obligations.ts) was FILED on a date, with optional
-- notes / reference. One row per (tenant, obligation, period) — marking filed is
-- an upsert; un-marking deletes the row. Status in the UI is derived: a matching
-- row = filed, else computed from the due date.

create table if not exists public.compliance_log (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  obligation_key text not null,
  period_key     text not null,
  period_label   text,
  due_date       date,
  filed_date     date not null default current_date,
  reference      text,
  notes          text,
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, obligation_key, period_key)
);

create index if not exists compliance_log_tenant_idx
  on public.compliance_log (tenant_id, due_date);

alter table public.compliance_log enable row level security;

-- Tenant-scoped CRUD — the owner/manager marks obligations filed from the app.
drop policy if exists compliance_log_select on public.compliance_log;
create policy compliance_log_select on public.compliance_log
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

drop policy if exists compliance_log_insert on public.compliance_log;
create policy compliance_log_insert on public.compliance_log
  for insert with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));

drop policy if exists compliance_log_update on public.compliance_log;
create policy compliance_log_update on public.compliance_log
  for update using (tenant_id = (select tenant_id from public.users where id = auth.uid()))
  with check (tenant_id = (select tenant_id from public.users where id = auth.uid()));

drop policy if exists compliance_log_delete on public.compliance_log;
create policy compliance_log_delete on public.compliance_log
  for delete using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

grant select, insert, update, delete on public.compliance_log to authenticated;
