-- deploy-peek: (to_regprocedure('public.is_personal_session()') is not null and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'tds_receivable' and policyname = 'gp09_personal_wall'))
-- deploy-key: gp09apersonalwall
-- R-2122 (GP-09a, goal G-PERSONAL, 30 Oct 2026): the DB wall, part 1.
--
-- A personal session must never read or write the business money / GST tables, whatever the
-- pages (GP-07a), the /api allowlist (GP-07b) or the data gateway (GP-10) do. Those are app
-- layers; this is the database.
--
-- public.is_personal_session() — STABLE, SECURITY DEFINER, search_path ''. True when the caller's
--   users row has role 'personal' OR the caller's tenant has workspace_kind 'personal' (R-2110).
--   The caller comes from public.current_user_id() (R-1901: app.user_id for app_runtime/app_jobs,
--   the JWT otherwise), so the PostgREST path and the Prisma/gateway path read the same person.
--   An app_jobs session with no user but a tenant (a cron working one tenant) counts as personal
--   when that tenant is personal — business jobs have no business on a personal tenant.
--   app_service / app_anon / no users row → false. Owners and staff of a business workspace,
--   including their Private Vault (D1), are unaffected.
--
-- gp09_personal_wall — one AS RESTRICTIVE FOR ALL TO authenticated policy per table, USING and
--   WITH CHECK `not (select public.is_personal_session())`. The (select …) wrap is the
--   20260928100000 InitPlan pattern: the helper runs once per query, not once per row, so a
--   business tenant pays one indexed users+tenants lookup per statement. RESTRICTIVE = ANDed on
--   top of every existing permissive policy; nothing else changes for anyone else.
--   TO authenticated: app_runtime and app_jobs are members of authenticated (R-1837), so the
--   gateway path is covered too; anon / service_role are not personal sessions.
--
-- THE LIST (explicit; supabase/tests/gp09a_personal_restrictive.test.sql checks every entry):
--   sales money   customers, quotes, invoices, credit_notes, debit_notes, payments,
--                 subscriptions, subscription_billings, customer_credits, project_sales
--   bank          bank_accounts, bank_transactions, txn_category_rules
--   journal/GST   opening_balances, cancelled_vouchers, tax_payments, tds_receivable
-- The card also names quote_items, invoice_items, "journal tables" and "GST return tables".
-- None of those exist as tables (lines are jsonb on quotes/invoices; the journal and the GSTR
-- returns are computed from the source documents above). Their stored parts are the
-- journal/GST rows listed. CRM / team / vendor / catalogue tables are GP-09b; SECURITY DEFINER
-- RPCs (which skip RLS) are GP-09c.
--
-- Re-runnable (create or replace + drop policy if exists). Grants: authenticated + service_role,
-- not anon (R-013, definer-hardening-holds.test.ts).

begin;

create or replace function public.is_personal_session() returns boolean
  language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select u.role::text = 'personal' or t.workspace_kind = 'personal'
       from public.users u
       left join public.tenants t on t.id = u.tenant_id
      where u.id = public.current_user_id()
      limit 1),
    (select t.workspace_kind = 'personal'
       from public.tenants t
      where session_user = 'app_jobs'
        and nullif(current_setting('app.user_id', true), '') is null
        and t.id = nullif(current_setting('app.tenant_id', true), '')::uuid),
    false);
$$;

comment on function public.is_personal_session() is
  'R-2122 (GP-09a): true for a personal session — the caller''s users.role is personal, or their tenant''s workspace_kind is personal (also an app_jobs session working a personal tenant). Used by the gp09_personal_wall RESTRICTIVE policies, always wrapped as (select public.is_personal_session()).';

revoke all on function public.is_personal_session() from public, anon;
grant execute on function public.is_personal_session() to authenticated, service_role;

do $$
declare
  v_t text;
begin
  foreach v_t in array array[
    'customers', 'quotes', 'invoices', 'credit_notes', 'debit_notes', 'payments',
    'subscriptions', 'subscription_billings', 'customer_credits', 'project_sales',
    'bank_accounts', 'bank_transactions', 'txn_category_rules',
    'opening_balances', 'cancelled_vouchers', 'tax_payments', 'tds_receivable']
  loop
    if to_regclass('public.' || v_t) is null then
      raise exception 'R-2122: table public.% is missing — the personal wall list is out of date', v_t;
    end if;
    execute format('drop policy if exists gp09_personal_wall on public.%I', v_t);
    execute format(
      'create policy gp09_personal_wall on public.%I as restrictive for all to authenticated '
      'using (not (select public.is_personal_session())) '
      'with check (not (select public.is_personal_session()))', v_t);
  end loop;
end $$;

commit;
