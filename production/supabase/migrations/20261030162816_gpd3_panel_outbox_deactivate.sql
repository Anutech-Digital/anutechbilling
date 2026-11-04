-- deploy-peek: to_regprocedure('public.queue_panel_account_deactivate(uuid,uuid)') is not null and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'panel_account_outbox' and column_name = 'op')
-- deploy-key: gpd3paneloutboxdeactivate
-- 20261030162816_gpd3_panel_outbox_deactivate.sql
--
-- R-2142 (GP-D3, goal G-PERSONAL measure 7 — DPDP delete): when a personal account is erased,
-- the customer's DMS panel login must stop working. DMS gains `customer.deactivate` (anutech-hosting
-- lib/integrations/engine-handlers-customer-deactivate.ts): login off, resellerosCustomerId cleared,
-- paid services and their records kept (retention). Idempotent, signed with the same command key.
--
-- Here, the Billing half, on the R-2103 outbox (20261029114000; claim/requeue as redefined by
-- R-2108 20261029140553):
--   panel_account_outbox.op         'ensure' (default, every existing row) | 'deactivate'
--   panel_account_outbox.dms_email  the email captured when the deactivate was queued — the erase
--                                   may scrub the customer's email before the cron runs
--   panel_account_outbox.source     + 'personal-erase'
--   queue_panel_account_deactivate(p_tenant_id, p_customer_id)   service_role only; called by the
--                                   personal erase (GP-22/23) through
--                                   lib/provisioning/panel-account.server.ts queuePanelAccountDeactivate.
--                                   One row per customer stays the rule (customer_id UNIQUE): the
--                                   customer's row turns into a pending deactivate. Idempotent.
--   claim_panel_account_outbox      returns op; a deactivate row sends dms_email and is never
--                                   flipped to needs_email. (Return type changed → drop + create.)
--   mark_panel_account_linked       never turns a deactivate row back to an ensure 'done'.
--   requeue_panel_account           a failed deactivate retries on its dms_email.
-- The cron /api/cron/panel-accounts sends customer.deactivate for op 'deactivate' rows.
--
-- The support desk side is NOT here: it reuses queue_support_sync_on_customer_status (archive).
-- The erase must keep the customers row (anonymised), not delete it: the outbox row cascades
-- with the customer (on delete cascade) and would vanish before the cron sends it.
-- Test: supabase/tests/gpd3_panel_outbox_deactivate.test.sql

begin;

-- ── columns ─────────────────────────────────────────────────────────────────
alter table public.panel_account_outbox add column if not exists op text not null default 'ensure';
alter table public.panel_account_outbox drop constraint if exists panel_account_outbox_op_check;
alter table public.panel_account_outbox add constraint panel_account_outbox_op_check
  check (op in ('ensure', 'deactivate'));
alter table public.panel_account_outbox add column if not exists dms_email text;

alter table public.panel_account_outbox drop constraint if exists panel_account_outbox_source_check;
alter table public.panel_account_outbox add constraint panel_account_outbox_source_check
  check (source in ('payment', 'backfill', 'panel-order', 'personal-signup', 'personal-erase'));

comment on column public.panel_account_outbox.op is
  'R-2142: ensure = make/find the DMS panel account (R-2103); deactivate = turn its login off (personal erase).';
comment on column public.panel_account_outbox.dms_email is
  'R-2142: for op deactivate, the email captured at queue time (the erase may scrub the customer''s email).';

-- ── queue a deactivate (the personal erase) ─────────────────────────────────
-- Returns 'queued' (row now a pending deactivate), 'already' (a deactivate is pending or done —
-- nothing changed), 'no_email' (no email to find the DMS user by — nothing to turn off),
-- null (the customer is not in that company).
create or replace function public.queue_panel_account_deactivate(p_tenant_id uuid, p_customer_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
-- R-2142
declare
  v_email  text;
  v_status text;
begin
  if p_tenant_id is null or p_customer_id is null then
    return null;
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.tenant_id = p_tenant_id) then
    return null;
  end if;

  if exists (select 1 from public.panel_account_outbox o
              where o.customer_id = p_customer_id and o.op = 'deactivate' and o.status in ('pending', 'done')) then
    return 'already';
  end if;

  v_email := lower(public.customer_primary_email(p_customer_id));
  if v_email is null then
    v_email := (select o.dms_email from public.panel_account_outbox o where o.customer_id = p_customer_id);
  end if;
  if not public.panel_account_email_ok(v_email) then
    return 'no_email';
  end if;

  insert into public.panel_account_outbox (tenant_id, customer_id, status, source, op, dms_email)
  values (p_tenant_id, p_customer_id, 'pending', 'personal-erase', 'deactivate', v_email)
  on conflict (customer_id) do update
     set op = 'deactivate', status = 'pending', source = 'personal-erase', dms_email = excluded.dms_email,
         attempts = 0, next_attempt_at = null, last_error = null, done_at = null, updated_at = now()
   where public.panel_account_outbox.tenant_id = p_tenant_id
  returning status into v_status;

  return case when v_status is null then null else 'queued' end;
end;
$$;

comment on function public.queue_panel_account_deactivate(uuid, uuid) is
  'R-2142: personal erase — turn the customer''s panel_account_outbox row into a pending DMS customer.deactivate. Idempotent. service_role only.';
revoke all on function public.queue_panel_account_deactivate(uuid, uuid) from public, anon, authenticated;
grant execute on function public.queue_panel_account_deactivate(uuid, uuid) to service_role;

-- ── claim: + op; a deactivate row sends its captured email ──────────────────
drop function if exists public.claim_panel_account_outbox(integer, uuid[], uuid);
create function public.claim_panel_account_outbox(
  p_limit       integer default 50,
  p_tenant_ids  uuid[]  default null,
  p_customer_id uuid    default null
)
returns table (
  id uuid, tenant_id uuid, customer_id uuid, attempts integer, op text,
  email text, customer_name text, contact_name text, contact_first_name text, contact_last_name text,
  phone text, gstin text, state text, address text, city text, pin_code text, country text,
  customer_number text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
-- R-2103; R-2108: the email is customer_primary_email. R-2142: op; deactivate uses dms_email.
begin
  -- An ensure row whose customer lost their email since it was queued: say so instead of sending.
  update public.panel_account_outbox o
     set status = 'needs_email', updated_at = now()
   where o.status = 'pending'
     and o.op = 'ensure'
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
    returning o.id, o.tenant_id, o.customer_id, o.attempts, o.op, o.dms_email
  )
  select l.id, l.tenant_id, l.customer_id, l.attempts, l.op,
         case when l.op = 'deactivate' then lower(l.dms_email) else lower(public.customer_primary_email(l.customer_id)) end,
         c.name, c.contact_name, c.contact_first_name, c.contact_last_name,
         coalesce(nullif(btrim(c.contact_mobile), ''), c.contact_phone), c.gstin, c.state, c.address, c.city,
         c.pin_code, c.country, c.customer_number
    from leased l
    join public.customers c on c.id = l.customer_id and c.tenant_id = l.tenant_id;
end;
$$;

comment on function public.claim_panel_account_outbox(integer, uuid[], uuid) is
  'R-2103: lease up to 50 due pending panel-account rows (SKIP LOCKED, 5-min lease) with the customer details to send. R-2108: email = customer_primary_email. R-2142: + op; deactivate rows send dms_email.';
revoke all on function public.claim_panel_account_outbox(integer, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.claim_panel_account_outbox(integer, uuid[], uuid) to service_role;

-- ── dms-panel order: never revives an erased customer's row ─────────────────
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
-- R-2103; R-2142: a deactivate row is left alone.
begin
  if p_tenant_id is null or p_customer_id is null or coalesce(btrim(p_dms_user_id), '') = '' then
    return null;
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.tenant_id = p_tenant_id) then
    return null;
  end if;
  if exists (select 1 from public.panel_account_outbox o where o.customer_id = p_customer_id and o.op = 'deactivate') then
    return null;
  end if;

  insert into public.panel_account_outbox (tenant_id, customer_id, status, source, dms_user_id, done_at)
  values (p_tenant_id, p_customer_id, 'done', 'panel-order', btrim(p_dms_user_id), now())
  on conflict (customer_id) do update
     set status = 'done',
         dms_user_id = coalesce(public.panel_account_outbox.dms_user_id, excluded.dms_user_id),
         done_at = coalesce(public.panel_account_outbox.done_at, now()),
         last_error = null, next_attempt_at = null, updated_at = now()
   where public.panel_account_outbox.tenant_id = p_tenant_id
     and public.panel_account_outbox.op = 'ensure';
  return 'done';
end;
$$;

revoke all on function public.mark_panel_account_linked(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_panel_account_linked(uuid, uuid, text) to service_role;

-- ── staff "Try again": a deactivate retries on its captured email ───────────
create or replace function public.requeue_panel_account(p_customer_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
-- R-2103; R-2108: the email is customer_primary_email. R-2142: deactivate uses dms_email.
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  if v_tenant is null or not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can retry a customer panel account.' using errcode = '42501';
  end if;

  update public.panel_account_outbox o
     set status = case
                    when o.op = 'deactivate' then
                      case when public.panel_account_email_ok(o.dms_email) then 'pending' else 'needs_email' end
                    when public.customer_primary_email(o.customer_id) is not null then 'pending'
                    else 'needs_email' end,
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

commit;
