-- deploy-peek: to_regprocedure('public.support_plan_key(text,text)') is not null and exists (select 1 from pg_proc where proname = 'queue_support_sync' and prosrc like '%R-2102%')
-- deploy-key: r2102supportsyncplankey
-- 20261029124808_r2102_support_sync_plan_key.sql
--
-- R-2102 (29 Oct 2026): the support desk (DSP) gets the plan by KEY, and every buyer gets Free.
--
-- 1. plan_key in the payload. queue_support_sync() sent only the subscription's display name
--    ('<seller company> Enterprise Support'), and DSP guessed the tier from the words
--    in it — a seller name containing "Standard" would map wrong. The payload now also carries
--    data.plan_key ('free' | 'standard' | 'enterprise') read from the catalogue SKU
--    (SUP-ENTERPRISE-MO-<tenant> → enterprise) and data.sku. The name stays as DSP's fallback.
--
-- 2. Free for anyone who buys anything (Pardeep, 29 Oct). The trigger used to fire only for
--    vendor 'support'. It now fires for every subscription:
--      · a support subscription → the customer's BEST live paid support plan (enterprise over
--        standard; any status but cancelled, as before), or 'free' when none is left;
--      · any other subscription (Workspace, M365, hosting, domain …) → 'free', but ONLY when it
--        is created active or turns active, and ONLY when the customer has no live paid support
--        plan — a Workspace "Business Standard" or "Enterprise" licence never becomes paid
--        support, and buying or cancelling a licence never downgrades a paid support customer.
--        Cancelling a licence sends nothing (the customer keeps Free).
--
-- queue_support_sync_on_customer_status() (archive / restore) also sends plan_key.
-- Test: supabase/tests/r2102_support_sync_plan_key.test.sql

begin;

-- ── the tier of one support subscription ────────────────────────────────────
create or replace function public.support_plan_key(p_item_id text, p_plan text)
returns text
language sql
immutable
set search_path = public
as $$
  -- R-2102: SKU first (SUP-STANDARD-YR-<tenant>); a product-wise add-on SKU (SUP-<product>-MO)
  -- is sold at Standard; no SKU → the plan name, same rules as lib/support/tiers.ts
  -- tierFromPlanName but WITHOUT its Free fallback (null = not known).
  select case
    when p_item_id ~* '^SUP-(FREE|STANDARD|ENTERPRISE)(-|$)'
      then lower(substring(upper(p_item_id) from '^SUP-(FREE|STANDARD|ENTERPRISE)'))
    when p_item_id ~* '^SUP-' then 'standard'
    when lower(coalesce(p_plan, '')) like '%free support%' then 'free'
    when lower(coalesce(p_plan, '')) like '%enterprise%' then 'enterprise'
    when lower(coalesce(p_plan, '')) like '%standard%' then 'standard'
    when lower(coalesce(p_plan, '')) ~ '\msupport( \((monthly|yearly)\))?$' then 'standard'
    else null
  end;
$$;

revoke all on function public.support_plan_key(text, text) from public, anon;
grant execute on function public.support_plan_key(text, text) to authenticated, service_role;

-- ── subscriptions → outbox ──────────────────────────────────────────────────
create or replace function public.queue_support_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2102
declare
  v_customer   record;
  v_best       record;
  v_is_support boolean := new.vendor = 'support';
  v_new_key    text;
  v_data       jsonb;
begin
  if new.customer_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if v_is_support then
      -- No-op update (something unrelated to plan/status/renewal changed) — skip.
      if old.plan          is not distinct from new.plan
         and old.status    is not distinct from new.status
         and old.renewal_date is not distinct from new.renewal_date
         and old.item_id   is not distinct from new.item_id
         and old.vendor    is not distinct from new.vendor then
        return new;
      end if;
    elsif old.status is not distinct from new.status and old.vendor is not distinct from new.vendor then
      -- A licence only matters when it starts or turns active.
      return new;
    end if;
  end if;

  select name, contact_name, contact_email, domain, customer_number, is_active
    into v_customer
    from public.customers
   where id = new.customer_id;

  -- DSP keys the sync on email (or billing_customer_id) — nothing to send without one.
  if v_customer.contact_email is null then
    return new;
  end if;

  -- The customer's best live paid support plan (this row included, as it is now).
  select s.plan, s.status, s.renewal_date, s.domain, s.item_id, k.key
    into v_best
    from public.subscriptions s
   cross join lateral (select public.support_plan_key(s.item_id, s.plan) as key) k
   where s.customer_id = new.customer_id
     and s.tenant_id   = new.tenant_id
     and s.vendor      = 'support'
     and s.status     <> 'cancelled'
     and k.key in ('standard', 'enterprise')
   order by case k.key when 'enterprise' then 2 else 1 end desc,
            s.renewal_date desc nulls last
   limit 1;

  if v_best.key is not null then
    -- A paid support customer: only a support change is sent, and it is the best plan
    -- they hold. A licence bought or cancelled changes nothing here.
    if not v_is_support then
      return new;
    end if;
    v_data := jsonb_build_object(
      'plan',        v_best.plan,
      'plan_key',    v_best.key,
      'sku',         v_best.item_id,
      'plan_status', v_best.status,
      'plan_expiry', v_best.renewal_date,
      'domain',      coalesce(v_best.domain, new.domain, v_customer.domain)
    );
  elsif v_is_support then
    v_new_key := public.support_plan_key(new.item_id, new.plan);
    if new.status <> 'cancelled' and v_new_key is null then
      -- A support row whose tier we cannot read — send the name, DSP decides (as before).
      v_data := jsonb_build_object(
        'plan', new.plan, 'plan_key', null, 'sku', new.item_id,
        'plan_status', new.status, 'plan_expiry', new.renewal_date,
        'domain', coalesce(new.domain, v_customer.domain));
    else
      -- Cancelled (or a Free support row): the customer is on Free.
      v_data := jsonb_build_object(
        'plan', 'free', 'plan_key', 'free', 'sku', new.item_id,
        'plan_status', new.status, 'plan_expiry', null,
        'domain', coalesce(new.domain, v_customer.domain));
    end if;
  else
    -- Any other product, no paid support: Free, when it is live and the customer is active.
    if new.status <> 'active' or v_customer.is_active is false then
      return new;
    end if;
    v_data := jsonb_build_object(
      'plan', 'free', 'plan_key', 'free', 'sku', null,
      'plan_status', 'active', 'plan_expiry', null,
      'domain', coalesce(new.domain, v_customer.domain));
  end if;

  insert into public.support_sync_outbox (tenant_id, subscription_id, customer_id, payload)
  values (
    new.tenant_id, new.id, new.customer_id,
    jsonb_build_object(
      'event_type', 'subscription.updated',
      'data', jsonb_build_object(
        'billing_customer_id', coalesce(v_customer.customer_number, new.customer_id::text),
        'name',                coalesce(v_customer.contact_name, v_customer.name),
        'email',               v_customer.contact_email
      ) || v_data
    )
  );

  return new;
end;
$$;

drop trigger if exists trg_queue_support_sync on public.subscriptions;
create trigger trg_queue_support_sync
  after insert or update of plan, status, renewal_date, item_id, vendor on public.subscriptions
  for each row execute function public.queue_support_sync();

-- ── archive / restore → outbox (unchanged, plus plan_key / sku) ─────────────
create or replace function public.queue_support_sync_on_customer_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2102
declare
  v_sub    record;
  v_plan   text;
  v_key    text;
  v_status text;
begin
  if old.is_active is not distinct from new.is_active then
    return new;
  end if;
  if new.contact_email is null then
    return new;
  end if;

  for v_sub in
    select id, tenant_id, plan, status, renewal_date, domain, item_id
      from public.subscriptions
     where customer_id = new.id and vendor = 'support'
  loop
    if new.is_active then
      -- Reactivated — resync whatever the subscription's own state actually is.
      v_plan   := v_sub.plan;
      v_key    := case when v_sub.status = 'cancelled' then 'free'
                       else public.support_plan_key(v_sub.item_id, v_sub.plan) end;
      v_status := v_sub.status;
    else
      -- Archived — the customer is no longer a support customer regardless
      -- of what the underlying subscription row still says.
      v_plan   := 'free';
      v_key    := 'free';
      v_status := 'cancelled';
    end if;

    insert into public.support_sync_outbox (tenant_id, subscription_id, customer_id, payload)
    values (
      v_sub.tenant_id, v_sub.id, new.id,
      jsonb_build_object(
        'event_type', 'subscription.updated',
        'data', jsonb_build_object(
          'billing_customer_id', coalesce(new.customer_number, new.id::text),
          'name',         coalesce(new.contact_name, new.name),
          'email',        new.contact_email,
          'domain',       coalesce(v_sub.domain, new.domain),
          'plan',         v_plan,
          'plan_key',     v_key,
          'sku',          v_sub.item_id,
          'plan_status',  v_status,
          'plan_expiry',  v_sub.renewal_date
        )
      )
    );
  end loop;

  return new;
end;
$$;

commit;
