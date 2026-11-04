-- deploy-peek: to_regclass('public.panel_account_outbox') is not null and to_regprocedure('public.queue_panel_account_backfill(boolean)') is not null
-- deploy-key: r2103panelaccountoutbox
-- 20261029114000_r2103_panel_account_outbox.sql
--
-- R-2103 (29 Oct 2026): every buyer gets a customer panel account (the DMS panel,
-- app.anutech.in). Pardeep: "anutech digital se koi bhi kuch kharidta hai to ... customer ka
-- customer panel hona chahiye".
--
-- THE GAP (audit on the card): no ResellerOS path ever asked DMS for the account. It appeared
-- only as a side effect of a hosting.provision / domain.register command, so Workspace and
-- support buyers, staff sales, desk payments and bank-reconcile sales never got a login.
--
-- ONE PLACE, NOT PER PATH: a received payment — whichever RPC wrote it (record_payment,
-- record_desk_payment, record_instalment_payment, record_multi_invoice_payment,
-- reconcile_bank_credit_*, a direct insert) — queues ONE row per customer in
-- panel_account_outbox. The cron /api/cron/panel-accounts (and the Razorpay webhook, at once)
-- sends DMS `customer.ensure` for it: DMS finds the user by email or creates it and mails
-- "Your Customer Portal is ready" with a one-time password. Nothing is sent unless the server
-- flag PANEL_ACCOUNTS_LIVE=1, the DMS command key and the company's "Customer panel accounts"
-- automation switch are all on (and DMS's own ENGINE_CUSTOMER_ACCOUNT_LIVE).
--
-- STATES  pending      → waiting for the cron (next_attempt_at = lease / back-off)
--         done         → DMS answered; dms_user_id holds the panel user
--         needs_email  → the customer has no valid email; staff see it on Hosting & Domains.
--                        Saving an email on the customer puts the row back to pending.
--         failed       → 5 failed sends; staff see it and can "Try again".
--
-- What is here (CLAUDE.md §17b — every step one atomic RPC):
--   table panel_account_outbox (customer_id UNIQUE — one account per customer, ever)
--   trg_queue_panel_account          AFTER INSERT ON payments (status 'received')
--                                    a SEPARATE trigger from support-sync's (R-2102 owns that)
--   trg_panel_account_email_saved    AFTER UPDATE OF contact_email ON customers
--   claim_panel_account_outbox       cron/webhook lease (service_role)
--   finish_panel_account_outbox      record one send (service_role)
--   mark_panel_account_linked        dms-panel order: the buyer already IS a DMS user (service_role)
--   panel_account_overview           staff list (owner/manager/support, own company)
--   requeue_panel_account            staff "Try again" (owner/manager)
--   queue_panel_account_backfill     staff go-live action, dry-run count first (owner/manager)
--
-- NOT automatic for existing customers: the backfill is an explicit staff action, run once at
-- go-live after the data transfer (backfillDecision on the card). This migration queues nothing.
-- Test: supabase/tests/r2103_panel_account_outbox.test.sql

begin;

-- ── table ───────────────────────────────────────────────────────────────────
create table if not exists public.panel_account_outbox (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  status          text not null default 'pending'
                  check (status in ('pending', 'done', 'needs_email', 'failed')),
  source          text not null default 'payment'
                  check (source in ('payment', 'backfill', 'panel-order')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz,
  dms_user_id     text,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  done_at         timestamptz,
  constraint panel_account_outbox_customer_uq unique (customer_id)
);

comment on table public.panel_account_outbox is
  'R-2103: one row per customer who has paid — their customer panel (DMS) account. Sent by /api/cron/panel-accounts.';

create index if not exists panel_account_outbox_pending_idx
  on public.panel_account_outbox (created_at) where status = 'pending';
create index if not exists panel_account_outbox_tenant_status_idx
  on public.panel_account_outbox (tenant_id, status);

alter table public.panel_account_outbox enable row level security;
drop policy if exists panel_account_outbox_service_role on public.panel_account_outbox;
-- R-450: Cloud SQL has no BYPASSRLS; the server client needs its own policy. Nobody else
-- reads the table directly (staff go through panel_account_overview).
create policy panel_account_outbox_service_role on public.panel_account_outbox
  for all to service_role using (true) with check (true);
revoke all on public.panel_account_outbox from anon, authenticated;
grant all on public.panel_account_outbox to service_role;

-- ── helper: is this an address DMS will accept (same test as DMS parseCustomer) ──
create or replace function public.panel_account_email_ok(p_email text)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- R-2103
  select coalesce(btrim(p_email), '') ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
$$;
grant execute on function public.panel_account_email_ok(text) to authenticated, service_role;

-- ── trigger: a received payment queues the customer ─────────────────────────
create or replace function public.tg_queue_panel_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2103: never blocks a payment — any error here is a warning, the payment stands.
declare
  v_customer uuid;
  v_email    text;
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

    select c.contact_email into v_email from public.customers c
     where c.id = v_customer and c.tenant_id = new.tenant_id;
    if not found then
      return null;
    end if;

    insert into public.panel_account_outbox (tenant_id, customer_id, status, source)
    values (new.tenant_id, v_customer,
            case when public.panel_account_email_ok(v_email) then 'pending' else 'needs_email' end,
            'payment')
    on conflict (customer_id) do nothing;
  exception when others then
    raise warning 'R-2103 panel account not queued for payment %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists trg_queue_panel_account on public.payments;
create trigger trg_queue_panel_account
  after insert on public.payments
  for each row
  when (new.status = 'received')
  execute function public.tg_queue_panel_account();

-- ── trigger: an email saved on the customer releases a needs_email row ──────
create or replace function public.tg_panel_account_email_saved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2103
begin
  if public.panel_account_email_ok(new.contact_email) then
    update public.panel_account_outbox o
       set status = 'pending', attempts = 0, next_attempt_at = null, last_error = null, updated_at = now()
     where o.customer_id = new.id
       and o.status = 'needs_email';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_panel_account_email_saved on public.customers;
create trigger trg_panel_account_email_saved
  after update of contact_email on public.customers
  for each row
  when (new.contact_email is distinct from old.contact_email)
  execute function public.tg_panel_account_email_saved();

-- ── claim (cron + webhook) ──────────────────────────────────────────────────
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
-- R-2103
begin
  -- A customer whose email was removed since the row was queued: say so instead of sending.
  update public.panel_account_outbox o
     set status = 'needs_email', updated_at = now()
    from public.customers c
   where c.id = o.customer_id
     and o.status = 'pending'
     and (p_tenant_ids is null or o.tenant_id = any(p_tenant_ids))
     and (p_customer_id is null or o.customer_id = p_customer_id)
     and not public.panel_account_email_ok(c.contact_email);

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
         lower(btrim(c.contact_email)), c.name, c.contact_name, c.contact_first_name, c.contact_last_name,
         coalesce(nullif(btrim(c.contact_mobile), ''), c.contact_phone), c.gstin, c.state, c.address, c.city,
         c.pin_code, c.country, c.customer_number
    from leased l
    join public.customers c on c.id = l.customer_id and c.tenant_id = l.tenant_id;
end;
$$;

comment on function public.claim_panel_account_outbox(integer, uuid[], uuid) is
  'R-2103: lease up to 50 due pending panel-account rows (SKIP LOCKED, 5-min lease) with the customer details to send.';
revoke all on function public.claim_panel_account_outbox(integer, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.claim_panel_account_outbox(integer, uuid[], uuid) to service_role;

-- ── finish ──────────────────────────────────────────────────────────────────
-- p_result: 'done'        → done, dms_user_id stored
--           'wait'        → DMS gate closed / held / busy: try again in an hour, no attempt used
--           'retry'       → attempts + 1, back-off 10/20/40/80 min; the 5th → 'failed'
--           'needs_email' → staff must add a valid email
create or replace function public.finish_panel_account_outbox(
  p_id          uuid,
  p_result      text,
  p_dms_user_id text default null,
  p_error       text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
-- R-2103
declare
  v_status text;
  v_err    text := left(coalesce(nullif(btrim(p_error), ''), 'send failed'), 500);
begin
  if p_result not in ('done', 'wait', 'retry', 'needs_email') then
    raise exception 'finish_panel_account_outbox: unknown result %', p_result using errcode = '22023';
  end if;

  update public.panel_account_outbox o
     set status          = case p_result
                             when 'done' then 'done'
                             when 'needs_email' then 'needs_email'
                             when 'retry' then case when o.attempts + 1 >= 5 then 'failed' else 'pending' end
                             else 'pending' end,
         attempts        = case when p_result = 'retry' then o.attempts + 1 else o.attempts end,
         dms_user_id     = case when p_result = 'done' then coalesce(nullif(btrim(p_dms_user_id), ''), o.dms_user_id) else o.dms_user_id end,
         done_at         = case when p_result = 'done' then now() else o.done_at end,
         last_error      = case when p_result = 'done' then null else v_err end,
         next_attempt_at = case p_result
                             when 'wait' then now() + interval '1 hour'
                             when 'retry' then case when o.attempts + 1 >= 5 then null
                                                    else now() + interval '5 minutes' * power(2, o.attempts + 1) end
                             else null end,
         updated_at      = now()
   where o.id = p_id
     and o.status = 'pending'
  returning o.status into v_status;

  return v_status;  -- null: the row was not pending (finished elsewhere)
end;
$$;

comment on function public.finish_panel_account_outbox(uuid, text, text, text) is
  'R-2103: record one customer.ensure send: done / wait (1h, no attempt) / retry (back-off, failed after 5) / needs_email.';
revoke all on function public.finish_panel_account_outbox(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.finish_panel_account_outbox(uuid, text, text, text) to service_role;

-- ── dms-panel order: the buyer is already a DMS user ────────────────────────
create or replace function public.mark_panel_account_linked(
  p_tenant_id   uuid,
  p_customer_id uuid,
  p_dms_user_id text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
-- R-2103
begin
  if p_tenant_id is null or p_customer_id is null or coalesce(btrim(p_dms_user_id), '') = '' then
    return null;
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.tenant_id = p_tenant_id) then
    return null;
  end if;

  insert into public.panel_account_outbox (tenant_id, customer_id, status, source, dms_user_id, done_at)
  values (p_tenant_id, p_customer_id, 'done', 'panel-order', btrim(p_dms_user_id), now())
  on conflict (customer_id) do update
     set status = 'done',
         dms_user_id = coalesce(public.panel_account_outbox.dms_user_id, excluded.dms_user_id),
         done_at = coalesce(public.panel_account_outbox.done_at, now()),
         last_error = null, next_attempt_at = null, updated_at = now()
   where public.panel_account_outbox.tenant_id = p_tenant_id;
  return 'done';
end;
$$;

revoke all on function public.mark_panel_account_linked(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_panel_account_linked(uuid, uuid, text) to service_role;

-- ── staff: overview (own company) ───────────────────────────────────────────
create or replace function public.panel_account_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
-- R-2103
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null or not public.current_user_has_role('owner', 'manager', 'support') then
    raise exception 'Only an owner, manager or support person can see customer panel accounts.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'counts', (
      select jsonb_build_object(
        'pending',     count(*) filter (where o.status = 'pending'),
        'done',        count(*) filter (where o.status = 'done'),
        'needs_email', count(*) filter (where o.status = 'needs_email'),
        'failed',      count(*) filter (where o.status = 'failed'))
        from public.panel_account_outbox o
       where o.tenant_id = v_tenant),
    'attention', coalesce((
      select jsonb_agg(x order by x->>'updated_at' desc)
        from (
          select jsonb_build_object(
                   'customer_id', o.customer_id,
                   'customer_name', coalesce(nullif(btrim(c.display_name), ''), c.name),
                   'status', o.status,
                   'last_error', o.last_error,
                   'updated_at', o.updated_at) as x
            from public.panel_account_outbox o
            join public.customers c on c.id = o.customer_id
           where o.tenant_id = v_tenant
             and o.status in ('needs_email', 'failed')
           order by o.updated_at desc
           limit 100
        ) s), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.panel_account_overview() from public, anon;
grant execute on function public.panel_account_overview() to authenticated, service_role;

-- ── staff: "Try again" ──────────────────────────────────────────────────────
create or replace function public.requeue_panel_account(p_customer_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
-- R-2103
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  if v_tenant is null or not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can retry a customer panel account.' using errcode = '42501';
  end if;

  update public.panel_account_outbox o
     set status = case when public.panel_account_email_ok(c.contact_email) then 'pending' else 'needs_email' end,
         attempts = 0, next_attempt_at = null, last_error = null, updated_at = now()
    from public.customers c
   where c.id = o.customer_id
     and o.customer_id = p_customer_id
     and o.tenant_id = v_tenant
     and o.status in ('failed', 'needs_email')
  returning o.status into v_status;
  return v_status;  -- null: nothing to retry
end;
$$;

revoke all on function public.requeue_panel_account(uuid) from public, anon;
grant execute on function public.requeue_panel_account(uuid) to authenticated, service_role;

-- ── staff: go-live backfill (existing paying customers), dry run first ──────
create or replace function public.queue_panel_account_backfill(p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
-- R-2103: Pardeep 29 Oct, option (a) — existing customers also get a panel account + login
-- mail. Run ONCE at go-live, after the data transfer. Dry run (default) only counts.
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
  select c.id, public.panel_account_email_ok(c.contact_email)
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

commit;
