-- deploy-key: cancelsub
-- deploy-peek: exists(select 1 from pg_proc where proname='cancel_subscription' and pronamespace='public'::regnamespace)
-- 20261009151000_cancel_subscription  (R-484 / R-455)
--
-- WHAT WAS WRONG (Abhishek, Scenario 10)
--   Verma Clinic paid ₹956 for a monthly plan, then left. Payments → Refund booked the
--   refund correctly (RFV voucher, payment 'refunded') — and then:
--     - the subscription stayed 'active': in MRR, in Renewals, renewing 8 Nov;
--     - the list said "₹956 due" and the panel "Owed ₹956" — for a customer who has gone
--       and has been paid back.
--   The only red button, "Cancel / delete subscription", only DELETES (for a wrong entry,
--   and blocked for a paid sale). There was no way to END a real subscription; "Correct
--   details → Status: cancelled" says it only fixes the record, and left the ₹956 due.
--
-- WHAT THIS ADDS
--   subscriptions.cancelled_at / cancel_reason / cancel_due_cleared — what ended it, when,
--   and how much due was closed. Not write_off_reason: a write-off means "uncollectable"
--   and shows a red "Written off" badge, wrong for a customer who was refunded and left.
--   (contract_amendments is append-only and its trigger writes the row, so the reason
--   cannot be added there afterwards.)
--
--   cancel_subscription(subscription, last_day, reason, clear_due):
--     - status 'cancelled', auto_renew off — out of MRR and the renewal run (both read
--       status = 'active' only); the history ledger records the status change itself;
--     - renewal_date moved IN to the last day of service when that is earlier (renewal_date
--       is the inclusive last covered day);
--     - clear_due: the ₹ still shown as due is closed (outstanding_amount 0), and the
--       amount is kept in cancel_due_cleared so it is never silently lost.
--   Nothing is deleted. The quote, payments, refund voucher and invoices stay as they are.
--
-- WHO: owner / manager / accountant — the same three that may refund (R-042). A session
-- with no JWT (psql, SQL tests) is left alone, as refund_payment does.

begin;

alter table public.subscriptions add column if not exists cancelled_at timestamptz;
alter table public.subscriptions add column if not exists cancel_reason text;
alter table public.subscriptions add column if not exists cancel_due_cleared integer;

comment on column public.subscriptions.cancelled_at is
  'R-455: when cancel_subscription() ended it. Null for rows cancelled before 9 Oct 2026 or via Correct details.';
comment on column public.subscriptions.cancel_reason is
  'R-455: why it ended, as typed by the person who cancelled it.';
comment on column public.subscriptions.cancel_due_cleared is
  'R-455: ₹ of outstanding_amount closed at cancel (e.g. refunded and left). 0/null = nothing cleared.';

create or replace function public.cancel_subscription(
  p_subscription_id uuid,
  p_last_day        date,
  p_reason          text,
  p_clear_due       boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_sub     record;
  v_last    date := coalesce(p_last_day, (now() at time zone 'Asia/Kolkata')::date);
  v_end     date;
  v_cleared integer := 0;
begin
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Write why the subscription is ending (at least 5 characters) — it is kept on the record.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if not found then
    raise exception 'Subscription not found — refresh the page; it may have been deleted.';
  end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated'))
     or (v_tenant is not null and v_sub.tenant_id is distinct from v_tenant) then
    raise exception 'Subscription not in your workspace' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(auth.role(), '') in ('anon', 'authenticated')
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can cancel a subscription — it takes it out of MRR and renewals. Ask one of them (Subscriptions → the subscription → Cancel subscription).'
      using errcode = 'insufficient_privilege';
  end if;
  if v_sub.status = 'cancelled' then
    raise exception 'This subscription is already cancelled. To bring it back, use Correct details → Status.'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sub.start_date is not null and v_last < v_sub.start_date then
    raise exception 'The last day (%) is before the subscription started (%). Pick a date on or after the start.', v_last, v_sub.start_date
      using errcode = 'invalid_parameter_value';
  end if;

  if p_clear_due and coalesce(v_sub.outstanding_amount, 0) > 0 then
    v_cleared := v_sub.outstanding_amount;
  end if;
  v_end := case when v_sub.renewal_date is null or v_last < v_sub.renewal_date then v_last else v_sub.renewal_date end;

  update public.subscriptions
     set status             = 'cancelled',
         auto_renew         = false,
         renewal_date       = v_end,
         outstanding_amount = case when v_cleared > 0 then 0 else outstanding_amount end,
         cancelled_at       = now(),
         cancel_reason      = left(trim(p_reason), 500),
         cancel_due_cleared = v_cleared
   where id = p_subscription_id;

  return jsonb_build_object(
    'subscription_id', p_subscription_id,
    'status',          'cancelled',
    'last_day',        v_end,
    'due_cleared',     v_cleared
  );
end $$;

comment on function public.cancel_subscription(uuid, date, text, boolean) is
  'R-455: end a real subscription (status cancelled, auto_renew off, renewal_date = last day). p_clear_due closes the remaining due (kept in cancel_due_cleared). Deletes nothing. owner/manager/accountant.';

revoke all on function public.cancel_subscription(uuid, date, text, boolean) from public, anon;
grant execute on function public.cancel_subscription(uuid, date, text, boolean) to authenticated, service_role;

commit;
