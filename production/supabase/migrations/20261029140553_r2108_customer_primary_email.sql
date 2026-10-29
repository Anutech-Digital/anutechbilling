-- deploy-peek: to_regprocedure('public.customer_primary_email(uuid)') is not null and exists (select 1 from pg_proc where proname = 'claim_panel_account_outbox' and prosrc like '%R-2108%')
-- deploy-key: r2108customerprimaryemail
-- 20261029140553_r2108_customer_primary_email.sql
--
-- R-2108 (29 Oct 2026): ONE customer email for the customer panel and the support desk.
--
-- THE GAP (checker on R-2102/R-2103): the customer page shows the PRIMARY CONTACT's email
-- (customer_contacts.is_primary → contacts.email, lib/contacts/primary.ts), but the panel
-- outbox (R-2103) and the support sync (R-2102) read only customers.contact_email. A customer
-- whose email lives on the primary contact sat in "Needs email" and never got a support desk
-- account.
--
-- Decision on the card (one fact, one place): customer_primary_email(customer_id) =
-- customers.contact_email when it is a valid address, else the primary contact's email; null
-- when neither is. Every reader below uses it:
--   tg_queue_panel_account, claim_panel_account_outbox, requeue_panel_account,
--   queue_panel_account_backfill (R-2103 — redefined from their 20261029114000 text)
--   queue_support_sync, queue_support_sync_on_customer_status (R-2102 — from 20261029124808)
-- And an email arriving on the primary contact releases a needs_email panel row, the same as
-- saving customers.contact_email did:
--   trg_panel_account_email_saved     (customers.contact_email — now through the helper)
--   trg_r2108_primary_link_email      (customer_contacts: a primary link added / made primary)
--   trg_r2108_contact_email_saved     (contacts.email changed on someone's primary contact)
-- Test: supabase/tests/r2108_customer_primary_email.test.sql

begin;

-- ── the helper ──────────────────────────────────────────────────────────────
create or replace function public.customer_primary_email(p_customer_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  -- R-2108: contact_email first, else the primary contact's (same company only). Trimmed, case kept.
  select coalesce(
    (select btrim(c.contact_email)
       from public.customers c
      where c.id = p_customer_id
        and public.panel_account_email_ok(c.contact_email)),
    (select btrim(p.email)
       from public.customers c
       join public.customer_contacts cc on cc.customer_id = c.id and cc.tenant_id = c.tenant_id and cc.is_primary
       join public.contacts p on p.id = cc.contact_id and p.tenant_id = c.tenant_id
      where c.id = p_customer_id
        and public.panel_account_email_ok(p.email)
      limit 1)
  );
$$;

comment on function public.customer_primary_email(uuid) is
  'R-2108: the one email for a customer — customers.contact_email when valid, else the primary contact''s email (customer_contacts.is_primary). Null = no email.';
-- It reads any company's customer; only the server and SECURITY DEFINER functions call it.
revoke all on function public.customer_primary_email(uuid) from public, anon, authenticated;
grant execute on function public.customer_primary_email(uuid) to service_role;

-- ── release a needs_email panel row once the customer has an email ──────────
create or replace function public.r2108_release_panel_needs_email(p_customer_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  -- R-2108
  update public.panel_account_outbox o
     set status = 'pending', attempts = 0, next_attempt_at = null, last_error = null, updated_at = now()
   where o.customer_id = p_customer_id
     and o.status = 'needs_email'
     and public.customer_primary_email(p_customer_id) is not null;
$$;
revoke all on function public.r2108_release_panel_needs_email(uuid) from public, anon, authenticated;
grant execute on function public.r2108_release_panel_needs_email(uuid) to service_role;

-- customers.contact_email saved (R-2103 trigger, now through the helper)
create or replace function public.tg_panel_account_email_saved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2103, R-2108
begin
  perform public.r2108_release_panel_needs_email(new.id);
  return null;
end;
$$;

-- a primary link added, or a link made primary
create or replace function public.tg_r2108_primary_link_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2108
begin
  perform public.r2108_release_panel_needs_email(new.customer_id);
  return null;
end;
$$;

drop trigger if exists trg_r2108_primary_link_email on public.customer_contacts;
create trigger trg_r2108_primary_link_email
  after insert or update of is_primary, contact_id on public.customer_contacts
  for each row
  when (new.is_primary)
  execute function public.tg_r2108_primary_link_email();

-- the email on a contact saved — every customer it is primary for
create or replace function public.tg_r2108_contact_email_saved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2108
declare
  v_customer uuid;
begin
  for v_customer in
    select cc.customer_id from public.customer_contacts cc
     where cc.contact_id = new.id and cc.tenant_id = new.tenant_id and cc.is_primary
  loop
    perform public.r2108_release_panel_needs_email(v_customer);
  end loop;
  return null;
end;
$$;

drop trigger if exists trg_r2108_contact_email_saved on public.contacts;
create trigger trg_r2108_contact_email_saved
  after update of email on public.contacts
  for each row
  when (new.email is distinct from old.email)
  execute function public.tg_r2108_contact_email_saved();

revoke all on function public.tg_r2108_primary_link_email() from public, anon, authenticated;
revoke all on function public.tg_r2108_contact_email_saved() from public, anon, authenticated;

-- ── R-2103 panel outbox: payment trigger ────────────────────────────────────
create or replace function public.tg_queue_panel_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2103: never blocks a payment — any error here is a warning, the payment stands.
-- R-2108: the email is customer_primary_email (contact_email, else the primary contact's).
declare
  v_customer uuid;
begin
  begin
    v_customer := new.customer_id;
    if v_customer is null and new.quote_id is not null then
      select q.customer_id into v_customer from public.quotes q
       where q.id = new.quote_id and q.tenant_id = new.tenant_id;
    end if;
    if v_customer is null and new.invoice_id is not null then
      select i.customer_id into v_customer from public.invoices i
       where i.id = new.invoice_id and i.tenant_id = new.tenant_id;
    end if;
    if v_customer is null then
      return null;
    end if;

    if not exists (select 1 from public.customers c where c.id = v_customer and c.tenant_id = new.tenant_id) then
      return null;
    end if;

    insert into public.panel_account_outbox (tenant_id, customer_id, status, source)
    values (new.tenant_id, v_customer,
            case when public.customer_primary_email(v_customer) is not null then 'pending' else 'needs_email' end,
            'payment')
    on conflict (customer_id) do nothing;
  exception when others then
    raise warning 'R-2103 panel account not queued for payment %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

-- ── R-2103 panel outbox: claim ──────────────────────────────────────────────
create or replace function public.claim_panel_account_outbox(
  p_limit       integer default 50,
  p_tenant_ids  uuid[]  default null,
  p_customer_id uuid    default null
)
returns table (
  id uuid, tenant_id uuid, customer_id uuid, attempts integer,
  email text, customer_name text, contact_name text, contact_first_name text, contact_last_name text,
  phone text, gstin text, state text, address text, city text, pin_code text, country text,
  customer_number text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
-- R-2103; R-2108: the email is customer_primary_email.
begin
  -- A customer whose email was removed since the row was queued: say so instead of sending.
  update public.panel_account_outbox o
     set status = 'needs_email', updated_at = now()
   where o.status = 'pending'
     and (p_tenant_ids is null or o.tenant_id = any(p_tenant_ids))
     and (p_customer_id is null or o.customer_id = p_customer_id)
     and public.customer_primary_email(o.customer_id) is null;

  return query
  with picked as (
    select o.id
      from public.panel_account_outbox o
     where o.status = 'pending'
       and (o.next_attempt_at is null or o.next_attempt_at <= now())
       and (p_tenant_ids is null or o.tenant_id = any(p_tenant_ids))
       and (p_customer_id is null or o.customer_id = p_customer_id)
     order by o.created_at, o.id
     limit least(greatest(coalesce(p_limit, 50), 1), 50)
       for update of o skip locked
  ),
  leased as (
    update public.panel_account_outbox o
       set next_attempt_at = now() + interval '5 minutes', updated_at = now()
      from picked
     where o.id = picked.id
    returning o.id, o.tenant_id, o.customer_id, o.attempts
  )
  select l.id, l.tenant_id, l.customer_id, l.attempts,
         lower(public.customer_primary_email(l.customer_id)), c.name, c.contact_name, c.contact_first_name, c.contact_last_name,
         coalesce(nullif(btrim(c.contact_mobile), ''), c.contact_phone), c.gstin, c.state, c.address, c.city,
         c.pin_code, c.country, c.customer_number
    from leased l
    join public.customers c on c.id = l.customer_id and c.tenant_id = l.tenant_id;
end;
$$;

comment on function public.claim_panel_account_outbox(integer, uuid[], uuid) is
  'R-2103: lease up to 50 due pending panel-account rows (SKIP LOCKED, 5-min lease) with the customer details to send. R-2108: email = customer_primary_email.';
revoke all on function public.claim_panel_account_outbox(integer, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.claim_panel_account_outbox(integer, uuid[], uuid) to service_role;

-- ── R-2103 panel outbox: staff "Try again" ──────────────────────────────────
create or replace function public.requeue_panel_account(p_customer_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
-- R-2103; R-2108: the email is customer_primary_email.
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  if v_tenant is null or not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can retry a customer panel account.' using errcode = '42501';
  end if;

  update public.panel_account_outbox o
     set status = case when public.customer_primary_email(o.customer_id) is not null then 'pending' else 'needs_email' end,
         attempts = 0, next_attempt_at = null, last_error = null, updated_at = now()
   where o.customer_id = p_customer_id
     and o.tenant_id = v_tenant
     and o.status in ('failed', 'needs_email')
  returning o.status into v_status;
  return v_status;  -- null: nothing to retry
end;
$$;

revoke all on function public.requeue_panel_account(uuid) from public, anon;
grant execute on function public.requeue_panel_account(uuid) to authenticated, service_role;

-- ── R-2103 panel outbox: go-live backfill ───────────────────────────────────
create or replace function public.queue_panel_account_backfill(p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
-- R-2103: Pardeep 29 Oct, option (a) — existing customers also get a panel account + login
-- mail. Run ONCE at go-live, after the data transfer. Dry run (default) only counts.
-- R-2108: "has an email" = customer_primary_email.
declare
  v_tenant      uuid := public.current_tenant_id();
  v_with        integer;
  v_without     integer;
  v_queued      integer := 0;
begin
  if v_tenant is null or not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can queue customer panel accounts.' using errcode = '42501';
  end if;

  create temporary table if not exists pg_temp.r2103_backfill (customer_id uuid primary key, email_ok boolean) on commit drop;
  truncate pg_temp.r2103_backfill;

  insert into pg_temp.r2103_backfill (customer_id, email_ok)
  select c.id, public.customer_primary_email(c.id) is not null
    from public.customers c
   where c.tenant_id = v_tenant
     and c.is_active
     and not exists (select 1 from public.panel_account_outbox o where o.customer_id = c.id)
     and (
       exists (select 1 from public.payments p
                where p.tenant_id = v_tenant and p.customer_id = c.id and p.status = 'received')
       or exists (select 1 from public.payments p
                    join public.quotes q on q.id = p.quote_id and q.tenant_id = v_tenant
                   where p.tenant_id = v_tenant and p.customer_id is null and q.customer_id = c.id and p.status = 'received')
       or exists (select 1 from public.payments p
                    join public.invoices i on i.id = p.invoice_id and i.tenant_id = v_tenant
                   where p.tenant_id = v_tenant and p.customer_id is null and p.quote_id is null
                     and i.customer_id = c.id and p.status = 'received')
       or exists (select 1 from public.subscriptions s
                   where s.tenant_id = v_tenant and s.customer_id = c.id and s.status = 'active')
     );

  select count(*) filter (where email_ok), count(*) filter (where not email_ok)
    into v_with, v_without
    from pg_temp.r2103_backfill;

  if not coalesce(p_dry_run, true) then
    insert into public.panel_account_outbox (tenant_id, customer_id, status, source)
    select v_tenant, b.customer_id, case when b.email_ok then 'pending' else 'needs_email' end, 'backfill'
      from pg_temp.r2103_backfill b
    on conflict (customer_id) do nothing;
    get diagnostics v_queued = row_count;
  end if;

  return jsonb_build_object(
    'dry_run', coalesce(p_dry_run, true),
    'with_email', v_with,
    'without_email', v_without,
    'queued', v_queued);
end;
$$;

comment on function public.queue_panel_account_backfill(boolean) is
  'R-2103: queue every active paying customer of the caller''s company that has no panel-account row yet. Dry run (default) only counts.';
revoke all on function public.queue_panel_account_backfill(boolean) from public, anon;
grant execute on function public.queue_panel_account_backfill(boolean) to authenticated, service_role;

-- ── R-2102 support sync: subscriptions → outbox ─────────────────────────────
create or replace function public.queue_support_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2102; R-2108: the email is customer_primary_email (contact_email, else the primary contact's).
declare
  v_customer   record;
  v_email      text;
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

  select name, contact_name, domain, customer_number, is_active
    into v_customer
    from public.customers
   where id = new.customer_id;

  -- DSP keys the sync on email (or billing_customer_id) — nothing to send without one.
  v_email := public.customer_primary_email(new.customer_id);
  if v_email is null then
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
        'email',               v_email
      ) || v_data
    )
  );

  return new;
end;
$$;

-- ── R-2102 support sync: archive / restore → outbox ─────────────────────────
create or replace function public.queue_support_sync_on_customer_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2102; R-2108: the email is customer_primary_email.
declare
  v_sub    record;
  v_plan   text;
  v_key    text;
  v_status text;
  v_email  text;
begin
  if old.is_active is not distinct from new.is_active then
    return new;
  end if;
  v_email := public.customer_primary_email(new.id);
  if v_email is null then
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
          'email',        v_email,
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
