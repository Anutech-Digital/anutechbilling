-- deploy-peek: to_regprocedure('public.queue_support_free_backfill(boolean)') is not null
-- deploy-key: r2107supportfreebackfill
-- 20261029145126_r2107_support_free_backfill.sql
--
-- R-2107 (29 Oct 2026): existing buyers get the Free support desk account too.
--
-- R-2102 gives Free support only to a subscription that starts or turns active from now on
-- (queue_support_sync). Customers who already hold licences get no support desk account until
-- this one-time go-live step runs. Same pattern as R-2103's "Give existing customers a login"
-- (queue_panel_account_backfill), decision on the card following Pardeep's (a) for R-2103:
-- a staff action that counts first (dry run, the default) and then queues one
-- support_sync_outbox row with plan_key 'free' for every ACTIVE customer of the caller's
-- company who
--   · has an active subscription that is not support (a licence, hosting, domain …),
--   · holds no live paid support plan (support_plan_key standard / enterprise, not cancelled),
--   · has no support_sync_outbox row yet (already on the desk, or already queued) — so a
--     second run queues nothing new,
--   · has an email (customer_primary_email, R-2108) — DSP keys the account on it; the ones
--     without are counted, not queued.
-- The desk mails a welcome per new account, and the cron sends only while the support-sync
-- switch is on. Pardeep runs it once after the data transfer; never on staging Anutech without
-- his go. Mid-term Standard → Enterprise stays the pro-rata upgrade quote (R-2073).
-- Test: supabase/tests/r2107_support_free_backfill.test.sql

begin;

create or replace function public.queue_support_free_backfill(p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
-- R-2107
declare
  v_tenant  uuid := public.current_tenant_id();
  v_with    integer;
  v_without integer;
  v_queued  integer := 0;
begin
  if v_tenant is null or not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can give existing customers Free support.' using errcode = '42501';
  end if;

  -- Two clicks at once must not queue twice.
  perform pg_advisory_xact_lock(hashtext('r2107_support_free_backfill'), hashtext(v_tenant::text));

  create temporary table if not exists pg_temp.r2107_backfill (
    customer_id uuid primary key, subscription_id uuid, email text, name text,
    billing_customer_id text, domain text
  ) on commit drop;
  truncate pg_temp.r2107_backfill;

  insert into pg_temp.r2107_backfill (customer_id, subscription_id, email, name, billing_customer_id, domain)
  select c.id, lic.id, public.customer_primary_email(c.id),
         coalesce(c.contact_name, c.name), coalesce(c.customer_number, c.id::text),
         coalesce(lic.domain, c.domain)
    from public.customers c
   cross join lateral (
     select s.id, s.domain
       from public.subscriptions s
      where s.tenant_id = v_tenant and s.customer_id = c.id
        and s.status = 'active' and s.vendor is distinct from 'support'
      order by s.renewal_date desc nulls last, s.id
      limit 1
   ) lic
   where c.tenant_id = v_tenant
     and c.is_active
     and not exists (select 1 from public.support_sync_outbox o where o.customer_id = c.id)
     and not exists (
       select 1 from public.subscriptions s
        where s.tenant_id = v_tenant and s.customer_id = c.id
          and s.vendor = 'support' and s.status <> 'cancelled'
          and public.support_plan_key(s.item_id, s.plan) in ('standard', 'enterprise'));

  select count(*) filter (where email is not null), count(*) filter (where email is null)
    into v_with, v_without
    from pg_temp.r2107_backfill;

  if not coalesce(p_dry_run, true) then
    insert into public.support_sync_outbox (tenant_id, subscription_id, customer_id, payload)
    select v_tenant, b.subscription_id, b.customer_id,
           jsonb_build_object(
             'event_type', 'subscription.updated',
             'data', jsonb_build_object(
               'billing_customer_id', b.billing_customer_id,
               'name',        b.name,
               'email',       b.email,
               'plan',        'free',
               'plan_key',    'free',
               'sku',         null,
               'plan_status', 'active',
               'plan_expiry', null,
               'domain',      b.domain))
      from pg_temp.r2107_backfill b
     where b.email is not null;
    get diagnostics v_queued = row_count;
  end if;

  return jsonb_build_object(
    'dry_run', coalesce(p_dry_run, true),
    'with_email', v_with,
    'without_email', v_without,
    'queued', v_queued);
end;
$$;

comment on function public.queue_support_free_backfill(boolean) is
  'R-2107: queue a Free support desk account (support_sync_outbox, plan_key free) for every active customer of the caller''s company with an active non-support subscription, no paid support and no outbox row yet. Dry run (default) only counts.';
revoke all on function public.queue_support_free_backfill(boolean) from public, anon;
grant execute on function public.queue_support_free_backfill(boolean) to authenticated, service_role;

commit;
