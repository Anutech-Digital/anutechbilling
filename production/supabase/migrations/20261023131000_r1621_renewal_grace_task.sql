-- deploy-peek: to_regprocedure('public.raise_renewal_grace_task(uuid)') is not null and to_regprocedure('public.renewal_grace_decide(uuid,text,integer)') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customers' and column_name = 'trusted_grace_days') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'grace_task_for') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'grace_period_days' and column_default = '7')
-- deploy-key: r1621gracetask
--
-- R-1621 (P1, 23 Oct 2026) — renewal late payment: 7-day grace, trusted customers, and the
-- service is stopped only when the OWNER says so.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   * tenants.grace_period_days defaulted to 0: a new company suspended the day after the
--     renewal date, with no breathing room for a customer whose payment is a day late.
--   * Nobody could give a long-standing customer more room than everybody else.
--   * When grace ended, the renewals cron flipped the subscription to 'paused' by itself
--     (api/cron/renewals/route.ts, the suspend step) and created no task — while the REAL
--     service at Google / Microsoft / the hosting panel kept running, because the app has no
--     vendor API (R-338). The app said "suspended", the customer still had service, and no
--     one was told to act.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   1. tenants.grace_period_days DEFAULT 7 — NEW companies only. Existing rows are NOT
--      changed: a 0 there cannot be told apart from "the owner chose 0" (no audit trail), so
--      raising them is Pardeep's data decision (needsDecision on the card, with the SQL).
--   2. customers.trusted_grace_days (1..60, null = the company's grace) — a trusted
--      customer's own grace. Only an owner or manager may set or change it (trigger below,
--      current_user_has_role — which also requires the MFA session, R-731). System writes
--      (auth.uid() null: imports, service role) pass.
--   3. subscriptions.grace_until (date) — "+N days" given by the owner for THIS term; a date
--      on or before the renewal date is stale (a new term) and means nothing.
--      subscriptions.grace_task_for (date) — the renewal_date whose "Stop service" task was
--      raised: ONE task per subscription per term, however often the cron runs.
--   4. raise_renewal_grace_task(sub) — service role only (the cron). When grace has ended it
--      stamps grace_task_for and inserts the owner's task in ONE transaction (§17b). The
--      subscription is NOT paused here any more: stopping is the owner's decision.
--   5. renewal_grace_decide(sub, 'stop' | 'extend', days) — owner / manager:
--        stop   → exactly the old automatic pause (status 'paused', renewal_state
--                 'suspended', suspended_at) plus suspended_by 'user' and a reason, and the
--                 task is closed. Paying the renewal later turns it back on as before —
--                 record_payment sets status 'active' when it rolls the term
--                 (20261021023154 ~686).
--        extend → grace_until moves N (1..30) days on from the later of today and the current
--                 grace end; the open task is moved to the day after the new end.
--   The grace rule lives in TWO places on purpose and they must agree: here (extend) and
--   lib/renewals/cadence.ts effectiveGraceDays (the cron). Both read
--   coalesce(customer.trusted_grace_days, tenant.grace_period_days) and grace_until.
--   No late fee is added (R-1569's setting is untouched).
--
-- Test: supabase/tests/r1621_renewal_grace_task.test.sql

-- ── 1. New companies get 7 days ──────────────────────────────────────────────
alter table public.tenants alter column grace_period_days set default 7;

-- ── 2. A trusted customer's own grace ────────────────────────────────────────
alter table public.customers
  add column if not exists trusted_grace_days smallint;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'customers_trusted_grace_days_range'
                    and conrelid = 'public.customers'::regclass) then
    alter table public.customers
      add constraint customers_trusted_grace_days_range
      check (trusted_grace_days is null or trusted_grace_days between 1 and 60);
  end if;
end $$;

comment on column public.customers.trusted_grace_days is
  'R-1621: grace days after the renewal date for THIS customer (trusted). Null = the company''s grace_period_days. Owner/manager only (trg_customers_trusted_grace_guard).';

create or replace function public.tg_customers_trusted_grace_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1621 */
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.trusted_grace_days is not distinct from old.trusted_grace_days then
    return new;
  end if;
  if tg_op = 'INSERT' and new.trusted_grace_days is null then
    return new;
  end if;
  if public.current_user_has_role('owner', 'manager') then
    return new;
  end if;
  raise exception 'Only the owner or a manager can give a customer extra grace days. Ask one of them to set it on the customer page (Renewal grace).'
    using errcode = '42501';
end;
$function$;

revoke all on function public.tg_customers_trusted_grace_guard() from public, anon;

drop trigger if exists trg_customers_trusted_grace_guard on public.customers;
create trigger trg_customers_trusted_grace_guard
  before insert or update of trusted_grace_days on public.customers
  for each row execute function public.tg_customers_trusted_grace_guard();

-- ── 3. Per-term extension + the one-task stamp ───────────────────────────────
alter table public.subscriptions
  add column if not exists grace_until date,
  add column if not exists grace_task_for date;

comment on column public.subscriptions.grace_until is
  'R-1621: last grace day given by the owner ("+N days") for the current term. Ignored when on or before renewal_date (a new term).';
comment on column public.subscriptions.grace_task_for is
  'R-1621: renewal_date whose "Stop service" owner task was raised — one task per subscription per term.';

create or replace function public.tg_subscriptions_grace_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1621 */
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.grace_until is not distinct from old.grace_until
     and new.grace_task_for is not distinct from old.grace_task_for then
    return new;
  end if;
  if public.current_user_has_role('owner', 'manager') then
    return new;
  end if;
  raise exception 'Only the owner or a manager can give a subscription more grace days. Ask one of them to press "+ days" on the Renewals page.'
    using errcode = '42501';
end;
$function$;

revoke all on function public.tg_subscriptions_grace_guard() from public, anon;

drop trigger if exists trg_subscriptions_grace_guard on public.subscriptions;
create trigger trg_subscriptions_grace_guard
  before update of grace_until, grace_task_for on public.subscriptions
  for each row execute function public.tg_subscriptions_grace_guard();

-- ── 4. Grace over → the owner's task (cron only) ─────────────────────────────
create or replace function public.raise_renewal_grace_task(p_subscription_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1621: one "Stop service" task per subscription per term. Service role only. */
declare
  v_trusted boolean;
  v_sub     record;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_grace   integer;
  v_end     date;
  v_due     integer;
  v_owner   uuid;
  v_task    uuid;
  v_title   text;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted then
    raise exception 'Grace-end tasks are raised by the daily renewals job only. Open Renewals to act on a renewal yourself.'
      using errcode = '42501';
  end if;

  select s.id, s.tenant_id, s.status::text as status, s.renewal_state::text as renewal_state,
         s.renewal_date, s.grace_until, s.grace_task_for, s.customer_id, s.customer_name, s.plan,
         s.renewal_quote_id, coalesce(s.outstanding_amount, 0) as outstanding,
         coalesce(c.trusted_grace_days, t.grace_period_days, 0) as grace_days
    into v_sub
    from public.subscriptions s
    join public.tenants t on t.id = s.tenant_id
    left join public.customers c on c.id = s.customer_id and c.tenant_id = s.tenant_id
   where s.id = p_subscription_id
   for update of s;
  if not found then
    return jsonb_build_object('raised', false, 'why', 'not_found');
  end if;
  if v_sub.status <> 'active' or v_sub.renewal_date is null
     or v_sub.renewal_state in ('renewed', 'suspended') then
    return jsonb_build_object('raised', false, 'why', 'not_due');
  end if;

  v_grace := v_sub.grace_days;
  v_end := v_sub.renewal_date + v_grace;
  if v_sub.grace_until is not null and v_sub.grace_until > v_sub.renewal_date then
    v_end := greatest(v_end, v_sub.grace_until);
  end if;
  if v_today <= v_end then
    return jsonb_build_object('raised', false, 'why', 'in_grace', 'grace_end', v_end);
  end if;
  if v_sub.grace_task_for is not distinct from v_sub.renewal_date then
    return jsonb_build_object('raised', false, 'why', 'already_raised');
  end if;

  select greatest(0, q.amount - coalesce((select sum(p.amount) from public.payments p
                                            where p.quote_id = q.id and p.status = 'received'), 0))
    into v_due
    from public.quotes q
   where q.id = v_sub.renewal_quote_id and q.tenant_id = v_sub.tenant_id;
  v_due := coalesce(v_due, 0) + greatest(0, v_sub.outstanding);

  select u.id into v_owner
    from public.users u
   where u.tenant_id = v_sub.tenant_id and u.is_active and u.role = 'owner'
   order by u.created_at nulls last, u.id
   limit 1;

  v_title := left(format('Stop service — %s · %s · ₹%s due',
                         v_sub.customer_name, coalesce(nullif(trim(v_sub.plan), ''), 'subscription'),
                         to_char(v_due, 'FM99,99,99,999')), 200);

  update public.subscriptions set grace_task_for = v_sub.renewal_date where id = v_sub.id;

  insert into public.tasks (tenant_id, owner_id, title, notes, kind, due_at, subscription_id)
  values (
    v_sub.tenant_id, v_owner, v_title,
    format(E'R-1621 · The renewal due %s is not paid and the grace (%s days) ended on %s.\n'
           'Amount due: ₹%s%s.\n'
           'Open: /renewals?view=grace\n\n'
           'Your call — on the Renewals page, "Grace over" list:\n'
           '• Stop service → the app marks it suspended. Then stop it at the vendor by hand '
           '(the app has no vendor access): Google Admin → Billing → suspend the subscription; '
           'Microsoft Partner Center → suspend; hosting panel → suspend the account. '
           'A domain needs nothing — it lapses by itself.\n'
           '• + days → give the customer more time; this task comes back when it ends.\n\n'
           'When the customer pays the renewal, the subscription turns active again by itself — '
           'then turn the service back on at the vendor.',
           to_char(v_sub.renewal_date, 'FMDD Mon YYYY'), v_grace, to_char(v_end, 'FMDD Mon YYYY'),
           to_char(v_due, 'FM99,99,99,999'),
           case when v_sub.renewal_quote_id is not null then format(' (renewal quote %s)', v_sub.renewal_quote_id) else '' end),
    'followup', now(), v_sub.id)
  returning id into v_task;

  return jsonb_build_object('raised', true, 'task_id', v_task, 'due', v_due, 'grace_end', v_end);
end;
$function$;

comment on function public.raise_renewal_grace_task(uuid) is
  'R-1621: grace over → one owner task "Stop service" per subscription per term (grace_task_for). Does not pause anything. Service role (renewals cron) only.';

revoke all on function public.raise_renewal_grace_task(uuid) from public, anon, authenticated;
grant execute on function public.raise_renewal_grace_task(uuid) to service_role;

-- ── 5. The owner decides: stop, or give more days ────────────────────────────
create or replace function public.renewal_grace_decide(
  p_subscription_id uuid,
  p_action          text,
  p_days            integer default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1621: owner / manager — 'stop' the service after grace, or 'extend' grace by N days. */
declare
  v_trusted boolean;
  v_tenant  uuid := public.current_tenant_id();
  v_sub     record;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_end     date;
  v_new     date;
  v_closed  integer := 0;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_trusted then
    raise exception 'No company context — sign in again, then try once more.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only the owner or a manager can stop a service or give more grace days. Ask one of them — the task is on their Tasks list.'
      using errcode = '42501';
  end if;
  if p_action not in ('stop', 'extend') then
    raise exception 'Unknown action "%". Use Stop service or + days on the Renewals page.', p_action
      using errcode = '22023';
  end if;

  select s.id, s.tenant_id, s.status::text as status, s.renewal_state::text as renewal_state,
         s.renewal_date, s.grace_until, s.customer_name,
         coalesce(c.trusted_grace_days, t.grace_period_days, 0) as grace_days
    into v_sub
    from public.subscriptions s
    join public.tenants t on t.id = s.tenant_id
    left join public.customers c on c.id = s.customer_id and c.tenant_id = s.tenant_id
   where s.id = p_subscription_id
   for update of s;
  if not found or (v_tenant is not null and v_sub.tenant_id <> v_tenant) then
    raise exception 'That subscription was not found in your company. Refresh the Renewals page and try again.'
      using errcode = '42501';
  end if;
  if v_sub.status <> 'active' then
    raise exception 'This subscription is already %, so there is nothing to stop or extend. Open it on the Subscriptions page to see why.', v_sub.status
      using errcode = '22023';
  end if;
  if v_sub.renewal_state = 'renewed' or v_sub.renewal_date is null or v_sub.renewal_date >= v_today then
    raise exception 'This renewal is not overdue (renewal date % ), so it needs no decision. Refresh the Renewals page.', coalesce(to_char(v_sub.renewal_date, 'FMDD Mon YYYY'), 'not set')
      using errcode = '22023';
  end if;

  if p_action = 'stop' then
    update public.subscriptions s
       set status         = 'paused',
           renewal_state  = 'suspended',
           suspended_at   = now(),
           suspended_by   = 'user',
           suspend_reason = left(format('Renewal due %s not paid after grace — service stopped by the owner (R-1621).',
                                        to_char(v_sub.renewal_date, 'FMDD Mon YYYY')), 500)
     where s.id = v_sub.id;

    update public.tasks k
       set status = 'done'
     where k.tenant_id = v_sub.tenant_id and k.subscription_id = v_sub.id
       and k.status in ('pending', 'snoozed') and k.title like 'Stop service — %';
    get diagnostics v_closed = row_count;

    return jsonb_build_object('subscription_id', v_sub.id, 'action', 'stop', 'status', 'paused',
                              'tasks_closed', v_closed);
  end if;

  -- extend
  if p_days is null or p_days < 1 or p_days > 30 then
    raise exception 'Give between 1 and 30 more days. For a longer break, set Renewal grace on the customer page (trusted customer).'
      using errcode = '22023';
  end if;
  v_end := v_sub.renewal_date + v_sub.grace_days;
  if v_sub.grace_until is not null and v_sub.grace_until > v_sub.renewal_date then
    v_end := greatest(v_end, v_sub.grace_until);
  end if;
  v_new := greatest(v_end, v_today) + p_days;

  update public.subscriptions s set grace_until = v_new where s.id = v_sub.id;

  update public.tasks k
     set due_at = ((v_new + 1)::timestamp + interval '9 hours') at time zone 'Asia/Kolkata',
         status = 'pending',
         notes  = left(coalesce(k.notes, '') || format(E'\n\n+%s days given on %s — grace now ends %s.',
                                                      p_days, to_char(v_today, 'FMDD Mon YYYY'),
                                                      to_char(v_new, 'FMDD Mon YYYY')), 4000)
   where k.tenant_id = v_sub.tenant_id and k.subscription_id = v_sub.id
     and k.status in ('pending', 'snoozed') and k.title like 'Stop service — %';

  return jsonb_build_object('subscription_id', v_sub.id, 'action', 'extend', 'grace_until', v_new);
end;
$function$;

comment on function public.renewal_grace_decide(uuid, text, integer) is
  'R-1621: owner/manager after grace — stop (pause + suspended, task closed) or extend grace 1..30 days (grace_until, task moved). Tenant fail-closed.';

revoke all on function public.renewal_grace_decide(uuid, text, integer) from public, anon;
grant execute on function public.renewal_grace_decide(uuid, text, integer) to authenticated, service_role;
