-- 0222 — in-app Activity Log (accountability, not surveillance).
--
-- A tamper-resistant "who did what" trail: AFTER triggers on the key data/money
-- tables write one row per USER action (insert/update/delete). System/cron
-- writes (auth.uid() is null) are skipped, so the log shows human activity only.
-- Clients can SELECT (tenant-scoped) but cannot INSERT/UPDATE/DELETE — only the
-- SECURITY DEFINER trigger + log_activity() RPC can write, so nobody can forge
-- or erase their trail.

create table if not exists public.activity_log (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid references public.users(id) on delete set null,
  action     text not null,           -- insert | update | delete | login
  entity     text not null,           -- table name, or 'session'
  entity_id  text,
  label      text,                    -- best-effort human label (name / no. / vendor)
  created_at timestamptz not null default now()
);
create index if not exists activity_log_tenant_time_idx on public.activity_log (tenant_id, created_at desc);
create index if not exists activity_log_user_idx on public.activity_log (tenant_id, user_id, created_at desc);

alter table public.activity_log enable row level security;
drop policy if exists activity_log_sel on public.activity_log;
create policy activity_log_sel on public.activity_log
  for select to authenticated using (tenant_id = public.current_tenant_id());
-- No insert/update/delete policies on purpose → only the definer functions write.

-- Generic row-change logger. SECURITY DEFINER so it can insert past RLS.
create or replace function public.log_row_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_json jsonb; v_tenant uuid; v_id text; v_label text;
begin
  -- Only log human actions; skip cron / service-role writes (no JWT).
  if auth.uid() is null then return null; end if;

  if tg_op = 'DELETE' then v_json := to_jsonb(old); else v_json := to_jsonb(new); end if;
  v_tenant := nullif(v_json->>'tenant_id', '')::uuid;
  if v_tenant is null then return null; end if;
  v_id := v_json->>'id';
  v_label := coalesce(
    v_json->>'full_name', v_json->>'name', v_json->>'company', v_json->>'company_name',
    v_json->>'invoice_no', v_json->>'quote_no', v_json->>'title', v_json->>'vendor_name', ''
  );

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (v_tenant, auth.uid(), lower(tg_op), tg_table_name, v_id, left(v_label, 120));
  return null;
end $$;

-- Client-logged events (e.g. login).
create or replace function public.log_activity(p_action text, p_entity text default 'session', p_entity_id text default null, p_label text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.users where id = auth.uid();
  if v_tenant is null then return; end if;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (v_tenant, auth.uid(), p_action, coalesce(p_entity, 'session'), p_entity_id, left(p_label, 120));
end $$;
grant execute on function public.log_activity(text, text, text, text) to authenticated;

-- Attach the logger to the key tables.
do $$
declare t text;
begin
  foreach t in array array[
    'leads','customers','contacts','quotes','invoices','payments','expenses',
    'subscriptions','employees','vendor_bills','project_sales','bank_transactions'
  ] loop
    execute format('drop trigger if exists trg_activity_%1$s on public.%1$s', t);
    execute format(
      'create trigger trg_activity_%1$s after insert or update or delete on public.%1$s
         for each row execute function public.log_row_change()', t);
  end loop;
end $$;
