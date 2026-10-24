-- deploy-peek: to_regprocedure('public.renew_anyway(uuid,text)') is not null and to_regprocedure('public.tg_subscriptions_service_restore_task()') is not null and exists(select 1 from pg_trigger where tgname = 'trg_subscriptions_service_restore_task') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'vendor_hold_override_for') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'service_restore_task_for')
-- deploy-key: r1796vendorhold
--
-- R-1796 (P1, 23 Oct 2026) — renewal late payment, part 2 of R-1621.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   1. The vendor renewal HOLD is DERIVED, not stored: a subscription (active or paused)
--      whose renewal_date is before today (IST) and whose term is not renewed is "on hold".
--      Paying the renewal rolls renewal_date (record_payment), so the hold ends by itself.
--      The rule lives in lib/renewals/vendor-hold.ts (the badge) and in renew_anyway below.
--      Facts (23 Oct): the app never renews at a vendor before payment — domain/hosting
--      renewals are queued only after record_payment, Google/Microsoft renew by themselves
--      (no API, R-338). So the hold is a badge for the owner, not a block on a vendor call.
--   2. subscriptions.vendor_hold_override_for (date) — the renewal_date the owner/manager
--      said "Renew anyway" for. Term-scoped: it equals renewal_date only for that term, so
--      the next term's hold shows again. Written only by renew_anyway() (owner / manager,
--      reason required, activity_log row). A direct write by anyone else is refused.
--   3. subscriptions.service_restore_task_for (date) — the term (old renewal_date) whose
--      "Turn the service back on" task was raised. ONE task per subscription per term.
--   4. trg_subscriptions_service_restore_task — BEFORE UPDATE on subscriptions: when a
--      SUSPENDED subscription (status paused + renewal_state suspended, e.g. the owner's
--      "Stop service", R-1621) becomes active AND its renewal_date moves forward (the
--      renewal was paid — record_payment rolls the term), it stamps the term and inserts one
--      owner task with the vendor steps. record_payment is NOT edited. BEFORE (not AFTER) so
--      the stamp is part of the same row write — no second UPDATE, no guard bypass.
--      Also: on any forward roll of renewal_date, an open "Stop service — …" task for the
--      old term is closed (the customer paid; there is nothing left to stop).
--
-- Test: supabase/tests/r1796_vendor_hold_restore_task.test.sql

-- ── 1. Columns ───────────────────────────────────────────────────────────────
alter table public.subscriptions
  add column if not exists vendor_hold_override_for date,
  add column if not exists service_restore_task_for date;

comment on column public.subscriptions.vendor_hold_override_for is
  'R-1796: renewal_date for which the owner/manager pressed "Renew anyway" (vendor renewal hold overridden for THAT term only). Written by renew_anyway().';
comment on column public.subscriptions.service_restore_task_for is
  'R-1796: renewal term (old renewal_date) whose "Turn the service back on" owner task was raised — one per subscription per term.';

-- ── 2. Only the owner / a manager may write them ─────────────────────────────
create or replace function public.tg_subscriptions_vendor_hold_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1796 */
begin
  if auth.uid() is null then
    return new;
  end if;
  if new.vendor_hold_override_for is not distinct from old.vendor_hold_override_for
     and new.service_restore_task_for is not distinct from old.service_restore_task_for then
    return new;
  end if;
  if public.current_user_has_role('owner', 'manager') then
    return new;
  end if;
  raise exception 'Only the owner or a manager can override a vendor renewal hold. Ask one of them to press "Renew anyway" on the Renewals page.'
    using errcode = '42501';
end;
$function$;

revoke all on function public.tg_subscriptions_vendor_hold_guard() from public, anon;

drop trigger if exists trg_subscriptions_vendor_hold_guard on public.subscriptions;
create trigger trg_subscriptions_vendor_hold_guard
  before update of vendor_hold_override_for, service_restore_task_for on public.subscriptions
  for each row execute function public.tg_subscriptions_vendor_hold_guard();

-- ── 3. "Renew anyway" — owner / manager, one term, logged ────────────────────
create or replace function public.renew_anyway(p_subscription_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1796: override the vendor renewal hold for the CURRENT term only. */
declare
  v_trusted boolean;
  v_tenant  uuid := public.current_tenant_id();
  v_sub     record;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_trusted then
    raise exception 'No company context — sign in again, then try once more.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only the owner or a manager can renew before payment. Ask one of them to press "Renew anyway" on the Renewals page.'
      using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Write why you are renewing before payment (for example "customer paying by cheque on Friday"). It goes into the activity log.'
      using errcode = '22023';
  end if;

  select s.id, s.tenant_id, s.status::text as status, s.renewal_state::text as renewal_state,
         s.renewal_date, s.vendor_hold_override_for, s.customer_name, s.plan
    into v_sub
    from public.subscriptions s
   where s.id = p_subscription_id
   for update of s;
  if not found or (v_tenant is not null and v_sub.tenant_id <> v_tenant) then
    raise exception 'That subscription was not found in your company. Refresh the Renewals page and try again.'
      using errcode = '42501';
  end if;
  if v_sub.status not in ('active', 'paused') or v_sub.renewal_date is null
     or v_sub.renewal_date >= v_today or v_sub.renewal_state = 'renewed' then
    raise exception 'This renewal is not on hold (renewal date %, status %), so there is nothing to override. Refresh the Renewals page.',
      coalesce(to_char(v_sub.renewal_date, 'FMDD Mon YYYY'), 'not set'), v_sub.status
      using errcode = '22023';
  end if;
  if v_sub.vendor_hold_override_for is not distinct from v_sub.renewal_date then
    return jsonb_build_object('subscription_id', v_sub.id, 'override_for', v_sub.renewal_date, 'already', true);
  end if;

  update public.subscriptions s
     set vendor_hold_override_for = v_sub.renewal_date
   where s.id = v_sub.id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_sub.tenant_id, auth.uid(), 'subscription.renew_anyway', 'subscription', v_sub.id::text,
          left(format('Renew anyway (unpaid) — %s · %s, term %s: %s',
                      v_sub.customer_name, coalesce(nullif(trim(v_sub.plan), ''), 'subscription'),
                      to_char(v_sub.renewal_date, 'FMDD Mon YYYY'), v_reason), 120),
          jsonb_build_object('renewal_date', v_sub.renewal_date, 'reason', left(v_reason, 500),
                             'status', v_sub.status, 'renewal_state', v_sub.renewal_state));

  return jsonb_build_object('subscription_id', v_sub.id, 'override_for', v_sub.renewal_date, 'already', false);
end;
$function$;

comment on function public.renew_anyway(uuid, text) is
  'R-1796: owner/manager override of the vendor renewal hold for the current term (vendor_hold_override_for = renewal_date) + activity_log row. Tenant fail-closed.';

revoke all on function public.renew_anyway(uuid, text) from public, anon;
grant execute on function public.renew_anyway(uuid, text) to authenticated, service_role;

-- ── 4. Paid after "Stop service" → one "Turn the service back on" task ───────
create or replace function public.tg_subscriptions_service_restore_task()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1796. Fires only when renewal_date moved FORWARD (the WHEN clause). */
declare
  v_owner uuid;
  v_steps text;
begin
  -- The customer paid this term: an open "Stop service" task for it has nothing left to do.
  update public.tasks k
     set status = 'done', completed_at = now()
   where k.tenant_id = new.tenant_id and k.subscription_id = new.id
     and k.status in ('pending', 'snoozed') and k.title like 'Stop service — %';

  if old.status::text = 'paused' and old.renewal_state::text = 'suspended'
     and new.status::text = 'active'
     and old.service_restore_task_for is distinct from old.renewal_date then
    new.service_restore_task_for := old.renewal_date;

    select u.id into v_owner
      from public.users u
     where u.tenant_id = new.tenant_id and u.is_active and u.role = 'owner'
     order by u.created_at nulls last, u.id
     limit 1;

    v_steps := case new.vendor::text
      when 'google'    then 'Google Admin → Billing → Subscriptions → reactivate this subscription.'
      when 'microsoft' then 'Microsoft Partner Center → the customer → Subscriptions → reactivate.'
      when 'hosting'   then 'Hosting panel → this account → Unsuspend.'
      when 'domain'    then 'Nothing to turn on — the domain renewal is queued by the payment.'
      else 'Turn it back on in the vendor''s admin panel by hand.'
    end;

    insert into public.tasks (tenant_id, owner_id, title, notes, kind, due_at, subscription_id)
    values (
      new.tenant_id, v_owner,
      left(format('Turn the service back on — %s · %s',
                  new.customer_name, coalesce(nullif(trim(new.plan), ''), 'subscription')), 200),
      format(E'R-1796 · The renewal due %s is now paid, so the app marked this subscription active again.\n'
             'If the service was stopped at the vendor, turn it back on there by hand '
             '(the app has no vendor access):\n• %s\n\n'
             'Then mark this task done. Open: /subscriptions',
             to_char(old.renewal_date, 'FMDD Mon YYYY'), v_steps),
      'followup', now(), new.id);
  end if;
  return new;
end;
$function$;

revoke all on function public.tg_subscriptions_service_restore_task() from public, anon;

drop trigger if exists trg_subscriptions_service_restore_task on public.subscriptions;
create trigger trg_subscriptions_service_restore_task
  before update of renewal_date on public.subscriptions
  for each row
  when (new.renewal_date > old.renewal_date)
  execute function public.tg_subscriptions_service_restore_task();
