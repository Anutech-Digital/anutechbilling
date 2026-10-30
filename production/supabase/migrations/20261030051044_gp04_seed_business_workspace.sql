-- deploy-peek: to_regprocedure('public.seed_business_workspace(uuid,text[])') is not null and exists(select 1 from pg_trigger where tgname = 'trg_tenants_default_petty_cash' and tgrelid = to_regclass('public.tenants') and pg_get_triggerdef(oid) like '%workspace_kind%') and exists(select 1 from pg_trigger where tgname = 'trg_tenants_customer_messages_on' and tgrelid = to_regclass('public.tenants') and pg_get_triggerdef(oid) like '%workspace_kind%')
-- deploy-key: gp04seedbusiness
-- 20261030051044_gp04_seed_business_workspace.sql
--
-- R-2114 (GP-04, goal G-PERSONAL, 30 Oct 2026). A personal workspace (tenants.workspace_kind =
-- 'personal', R-2110) is one person's own money — it must not start with a company "Petty Cash"
-- account (R-1834) or with Customer messages switched ON (R-1922). Both are business seeds.
--
-- What this does (no money, no existing row touched — no backfill):
--   1. seed_business_workspace(p_tenant, p_parts) — the ONE place both seeds live (bodies moved
--      from 20261024101339_r1834 tg_tenant_default_petty_cash and 20261025160239_r1922
--      tg_tenant_customer_messages_on, unchanged: same Petty Cash row, same customer_messages
--      row). Idempotent (ON CONFLICT DO NOTHING on both): a repeat call adds nothing and never
--      turns an owner's OFF switch back ON. Returns {petty_cash_added, customer_messages_added}.
--      p_parts defaults to both; the two triggers each pass their own part so either can still
--      be disabled alone (the R-1834 / R-1922 tests make "existing companies" that way).
--      The paid upgrade (GP-25) calls seed_business_workspace(tenant) AFTER it flips the kind.
--      Refuses a tenant that does not exist (P0002) or is still personal (22023).
--   2. Both AFTER INSERT triggers on tenants keep their names (the R-1834 / R-1922 deploy-peeks
--      look for them) and now carry WHEN (new.workspace_kind = 'business'); their trigger
--      functions just call the seed for their own part.
--
-- §17c: seed_business_workspace takes a caller-chosen tenant, so EXECUTE is service_role only
-- (revoked from public/anon/authenticated/app_runtime) AND the body has the trusted-only guard
-- (R-454 form), with one addition: inside a trigger (pg_trigger_depth() > 0) it is the tenants
-- insert trigger calling for NEW.id — the only callers that reach it from there are the two
-- SECURITY DEFINER trigger functions below, which themselves have no EXECUTE for request roles.
-- SECURITY DEFINER because the company row is inserted before its users row exists (RLS on
-- bank_accounts / automation_jobs would refuse it).
--
-- Proof: supabase/tests/gp04_seed_business_workspace.test.sql (one rollback); the R-1834
-- default_petty_cash and R-1922 new_company_customer_messages_on tests stay green.

begin;

-- ── 1. The one seed function ────────────────────────────────────────────────
create or replace function public.seed_business_workspace(
  p_tenant uuid,
  p_parts text[] default array['petty_cash', 'customer_messages'])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted boolean := pg_trigger_depth() > 0
    or coalesce(auth.role(), '') = 'service_role'
    or (auth.role() is null and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_kind  text;
  v_today date := public.ist_today();
  v_petty boolean := false;
  v_msgs  boolean := false;
  v_n     integer;
begin
  /* R-2114 (GP-04): business seeds — Petty Cash (R-1834) + Customer messages ON (R-1922). */
  if not v_trusted then
    raise exception 'Only the server can set up a business workspace.' using errcode = '42501';
  end if;

  select t.workspace_kind into v_kind from public.tenants t where t.id = p_tenant;
  if not found then
    raise exception 'That workspace does not exist.' using errcode = 'P0002';
  end if;
  if v_kind is distinct from 'business' then
    raise exception 'This workspace is still personal — switch it to business before setting up business features.'
      using errcode = '22023';
  end if;

  if 'petty_cash' = any(p_parts) then
    -- R-1834 body (unchanged): empty Petty Cash, opening date = 1 April of the IST FY.
    insert into public.bank_accounts
      (tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date,
       is_active, is_default_petty_cash, notes)
    values
      (p_tenant, 'Petty Cash', 'Cash in hand', 'cash', 0,
       make_date(extract(year from v_today)::int - case when extract(month from v_today) < 4 then 1 else 0 end, 4, 1),
       true, true,
       'Created with the company for cash spends. Rename it if you like; top it up with Move money / withdraw from a bank account.')
    on conflict (tenant_id) where is_default_petty_cash do nothing;
    get diagnostics v_n = row_count;
    v_petty := v_n > 0;
  end if;

  if 'customer_messages' = any(p_parts) then
    -- R-1922 body (unchanged): only the customer_messages switch — every cron stays OFF (no row).
    insert into public.automation_jobs (tenant_id, job, enabled, dry_run)
    values (p_tenant, 'customer_messages', true, false)
    on conflict (tenant_id, job) do nothing;
    get diagnostics v_n = row_count;
    v_msgs := v_n > 0;
  end if;

  return jsonb_build_object('petty_cash_added', v_petty, 'customer_messages_added', v_msgs);
end;
$$;

revoke all on function public.seed_business_workspace(uuid, text[]) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    execute 'revoke all on function public.seed_business_workspace(uuid, text[]) from app_runtime';
  end if;
end $$;
grant execute on function public.seed_business_workspace(uuid, text[]) to service_role;

-- ── 2. The two tenant triggers: business only, body = the seed ──────────────
create or replace function public.tg_tenant_default_petty_cash()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-1834, R-2114: the body lives in seed_business_workspace. */
  perform public.seed_business_workspace(new.id, array['petty_cash']);
  return new;
end;
$$;

create or replace function public.tg_tenant_customer_messages_on()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-1922, R-2114: the body lives in seed_business_workspace. */
  perform public.seed_business_workspace(new.id, array['customer_messages']);
  return new;
end;
$$;

revoke all on function public.tg_tenant_default_petty_cash() from public, anon, authenticated;
revoke all on function public.tg_tenant_customer_messages_on() from public, anon, authenticated;

drop trigger if exists trg_tenants_default_petty_cash on public.tenants;
create trigger trg_tenants_default_petty_cash
  after insert on public.tenants
  for each row
  when (new.workspace_kind = 'business')
  execute function public.tg_tenant_default_petty_cash();

drop trigger if exists trg_tenants_customer_messages_on on public.tenants;
create trigger trg_tenants_customer_messages_on
  after insert on public.tenants
  for each row
  when (new.workspace_kind = 'business')
  execute function public.tg_tenant_customer_messages_on();

commit;
