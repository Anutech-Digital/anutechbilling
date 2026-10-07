-- deploy-peek: (exists(select 1 from pg_trigger where tgname='trg_invoices_overdue_resume') and exists(select 1 from information_schema.columns where table_schema='public' and table_name='tenants' and column_name='overdue_suspend_days') and exists(select 1 from pg_proc where proname='decide_invoice_write_off' and pronamespace='public'::regnamespace))
-- deploy-key: overduesuspend
-- 20261007281600_overdue_auto_suspend.sql
--
-- R-116 (7 Oct 2026) — pause a subscription automatically when its invoice stays unpaid, turn
-- it back on when the invoice is settled, and suggest write-offs for very old invoices.
--
-- EXTENDS what exists. `tenants.auto_suspend_on_overdue` (default false) was already the
-- per-company switch read by /api/cron/invoice-dunning; it had no screen and a fixed Day-14
-- rule. Now:
--   1. tenants.overdue_suspend_days (default 15, 1..365) — pause after N days overdue.
--   2. subscriptions.suspend_reason / suspended_by ('automation' | 'user') /
--      suspended_invoice_id — WHY and BY WHOM it was paused, and which invoice caused it.
--      Status stays the existing 'paused' (+ suspended_at, already there) — no new enum value,
--      so every screen that knows 'paused' keeps working.
--   3. trg_invoices_overdue_resume — when the invoice that caused an AUTOMATIC pause is settled
--      (paid, void, or nothing left to pay after receipts / credit notes) the subscription goes
--      back to 'active' straight away and a row is written to ai_action_log. A pause made by a
--      person is never undone by this trigger.
--   4. invoice_write_off_drafts + suggest_invoice_write_off() / decide_invoice_write_off() —
--      an invoice more than 180 days overdue can be SUGGESTED for write-off. That only creates
--      a draft; only the owner confirms or dismisses it. Nothing here touches the books or the
--      invoice — the bad-debt entry stays the accountant's step.
--
-- No Google/Microsoft call anywhere: this is app status only (provisioning is a separate card).
-- Test: supabase/tests/overdue_auto_suspend.test.sql (begin ... rollback).

begin;

-- ── 1. Per-company threshold ─────────────────────────────────────────────────
alter table public.tenants
  add column if not exists overdue_suspend_days integer not null default 15;
alter table public.tenants drop constraint if exists tenants_overdue_suspend_days_range;
alter table public.tenants
  add constraint tenants_overdue_suspend_days_range check (overdue_suspend_days between 1 and 365);
comment on column public.tenants.overdue_suspend_days is
  'R-116: with auto_suspend_on_overdue on, pause a subscription once its oldest unpaid invoice is more than this many days overdue (IST). Default 15.';

-- ── 2. Why / by whom a subscription was paused ────────────────────────────────
alter table public.subscriptions
  add column if not exists suspend_reason text,
  add column if not exists suspended_by text,
  add column if not exists suspended_invoice_id text;
alter table public.subscriptions drop constraint if exists subscriptions_suspended_by_check;
alter table public.subscriptions
  add constraint subscriptions_suspended_by_check
  check (suspended_by is null or suspended_by in ('automation', 'user'));
alter table public.subscriptions drop constraint if exists subscriptions_suspended_invoice_fkey;
alter table public.subscriptions
  add constraint subscriptions_suspended_invoice_fkey
  foreign key (suspended_invoice_id) references public.invoices(id) on delete set null;
create index if not exists subscriptions_suspended_invoice_idx
  on public.subscriptions (suspended_invoice_id) where suspended_invoice_id is not null;

commit;

begin;

-- ── 3. Turn the service back on when the invoice is settled ──────────────────
create or replace function public.tg_invoice_overdue_resume()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due integer;
begin
  v_due := case
    when new.status::text in ('paid', 'void') then 0
    else greatest(0, coalesce(new.net_payable, new.amount, 0) - coalesce(new.paid_amount, 0))
  end;
  if v_due > 0 then
    return new;
  end if;

  with resumed as (
    update public.subscriptions s
       set status = 'active',
           suspended_at = null,
           suspend_reason = null,
           suspended_by = null,
           suspended_invoice_id = null
     where s.tenant_id = new.tenant_id
       and s.suspended_invoice_id = new.id
       and s.suspended_by = 'automation'
       and s.status = 'paused'
    returning s.id, s.customer_name
  )
  insert into public.ai_action_log (tenant_id, action, outcome, reason, mode, entity, entity_id, facts)
  select new.tenant_id, 'subscription.overdue_resume', 'did',
         format('Invoice %s is settled, so the service for %s was turned back on.', new.id, r.customer_name),
         'auto', 'subscription', r.id::text,
         jsonb_build_object('invoice_id', new.id, 'invoice_status', new.status::text, 'actor', 'automation')
    from resumed r;

  return new;
end;
$$;

revoke all on function public.tg_invoice_overdue_resume() from public;
revoke all on function public.tg_invoice_overdue_resume() from anon;
grant execute on function public.tg_invoice_overdue_resume() to authenticated, service_role;

drop trigger if exists trg_invoices_overdue_resume on public.invoices;
create trigger trg_invoices_overdue_resume
  after update of status, paid_amount, net_payable, amount on public.invoices
  for each row
  execute function public.tg_invoice_overdue_resume();

commit;

begin;

-- ── 4. Write-off suggestions (draft only; owner decides) ─────────────────────
create table if not exists public.invoice_write_off_drafts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  invoice_id   text not null references public.invoices(id) on delete cascade,
  amount       integer not null check (amount > 0),
  days_overdue integer not null,
  reason       text not null,
  status       text not null default 'draft' check (status in ('draft', 'confirmed', 'dismissed')),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  decided_by   uuid,
  decided_at   timestamptz
);
comment on table public.invoice_write_off_drafts is
  'R-116: suggested write-offs for invoices >180 days overdue. Draft until the owner confirms or dismisses. Does not post any accounting entry.';
create unique index if not exists invoice_write_off_drafts_one_open
  on public.invoice_write_off_drafts (tenant_id, invoice_id) where status = 'draft';
create index if not exists invoice_write_off_drafts_tenant_idx
  on public.invoice_write_off_drafts (tenant_id, created_at desc);

alter table public.invoice_write_off_drafts enable row level security;
revoke all on table public.invoice_write_off_drafts from anon;
grant select on table public.invoice_write_off_drafts to authenticated;
grant all on table public.invoice_write_off_drafts to service_role;

drop policy if exists invoice_write_off_drafts_select on public.invoice_write_off_drafts;
create policy invoice_write_off_drafts_select on public.invoice_write_off_drafts
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()));
drop policy if exists invoice_write_off_drafts_service_role on public.invoice_write_off_drafts;
create policy invoice_write_off_drafts_service_role on public.invoice_write_off_drafts
  to service_role using (true) with check (true);

create or replace function public.suggest_invoice_write_off(p_invoice_id text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_inv    record;
  v_due    integer;
  v_days   integer;
  v_id     uuid;
begin
  if v_tenant is null then
    raise exception 'You are not signed in to a company. Sign in again and retry.'
      using errcode = '42501';
  end if;

  select i.id, i.status::text as status, i.amount, i.net_payable, i.paid_amount, i.due_date
    into v_inv
    from public.invoices i
   where i.id = p_invoice_id and i.tenant_id = v_tenant;
  if not found then
    raise exception 'Invoice % was not found in your company. Refresh the page and pick it again.', p_invoice_id
      using errcode = 'P0002';
  end if;
  if v_inv.status not in ('pending', 'overdue') then
    raise exception 'Invoice % is %, so there is nothing to write off.', p_invoice_id, v_inv.status
      using errcode = '22023';
  end if;

  v_due := greatest(0, coalesce(v_inv.net_payable, v_inv.amount, 0) - coalesce(v_inv.paid_amount, 0));
  if v_due <= 0 then
    raise exception 'Invoice % has nothing left to pay, so there is nothing to write off.', p_invoice_id
      using errcode = '22023';
  end if;
  if v_inv.due_date is null then
    raise exception 'Invoice % has no due date. Set one on the invoice first.', p_invoice_id
      using errcode = '22023';
  end if;
  v_days := (now() at time zone 'Asia/Kolkata')::date - v_inv.due_date;
  if v_days <= 180 then
    raise exception 'Invoice % is % days overdue. Write-off is suggested only after 180 days.', p_invoice_id, v_days
      using errcode = '22023';
  end if;

  select d.id into v_id
    from public.invoice_write_off_drafts d
   where d.tenant_id = v_tenant and d.invoice_id = p_invoice_id and d.status = 'draft';
  if v_id is not null then
    return v_id;
  end if;

  insert into public.invoice_write_off_drafts (tenant_id, invoice_id, amount, days_overdue, reason, created_by)
  values (v_tenant, p_invoice_id, v_due, v_days,
          format('%s days overdue with %s still unpaid.', v_days, v_due), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.suggest_invoice_write_off(text) from public;
revoke all on function public.suggest_invoice_write_off(text) from anon;
grant execute on function public.suggest_invoice_write_off(text) to authenticated, service_role;

create or replace function public.decide_invoice_write_off(p_draft_id uuid, p_decision text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_rows   integer;
begin
  if v_tenant is null then
    raise exception 'You are not signed in to a company. Sign in again and retry.'
      using errcode = '42501';
  end if;
  if not public.current_user_is_owner() then
    raise exception 'Only the company owner can confirm or dismiss a write-off. Ask the owner to open Accounting > Aging.'
      using errcode = '42501';
  end if;
  if p_decision not in ('confirmed', 'dismissed') then
    raise exception 'Unknown decision "%". Use confirmed or dismissed.', p_decision
      using errcode = '22023';
  end if;

  update public.invoice_write_off_drafts d
     set status = p_decision, decided_by = auth.uid(), decided_at = now()
   where d.id = p_draft_id and d.tenant_id = v_tenant and d.status = 'draft';
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'This write-off draft was not found or was already decided. Refresh the page.'
      using errcode = 'P0002';
  end if;
  return p_decision;
end;
$$;

revoke all on function public.decide_invoice_write_off(uuid, text) from public;
revoke all on function public.decide_invoice_write_off(uuid, text) from anon;
grant execute on function public.decide_invoice_write_off(uuid, text) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
