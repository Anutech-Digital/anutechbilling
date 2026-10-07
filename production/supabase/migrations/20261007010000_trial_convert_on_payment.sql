-- R-282: a trial started from an accepted quote converts when the payment lands.
--
-- "Start trial (pay later)" on an accepted, unpaid quote puts the quote's lead at stage 'trial'
-- with trial_started_at / trial_expires_at, and writes three owner tasks titled "Trial …"
-- (lib/trials/start-from-quote.ts). An accepted quote already has its customer (accept_quote
-- converts the lead), so the payment goes down record_payment's third branch — which only stamps
-- trial_converted_at when the lead is at 'won'. A lead at 'trial' was left there: the payment was
-- in, the trial still read "running", and the "Trial ends today" task still fired.
--
-- This runs on the payment row itself, so it holds for every way a payment arrives (Record
-- payment, Razorpay webhook, bank match), not only the one screen:
--   1. the quote's lead, if it has a trial that is not yet converted → trial_converted_at = now(),
--      and stage 'trial' → 'won' (the deal is paid);
--   2. that lead's still-open tasks whose title starts with 'Trial' → 'cancelled'
--      (a trial that has been paid for needs no "send payment link" or "trial ends" reminder).
-- Nothing else: no message, no suspension, no money columns touched.
--
-- Idempotent: a second payment finds trial_converted_at set and no open trial tasks.
-- Proved by supabase/tests/trial_convert_on_payment.test.sql.

create or replace function public.fn_trial_convert_on_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_id text;
begin
  if new.status is distinct from 'received' then
    return new;
  end if;

  select q.lead_id into v_lead_id
    from public.quotes q
   where q.id = new.quote_id and q.tenant_id = new.tenant_id;
  if v_lead_id is null then
    return new;
  end if;

  update public.leads
     set trial_converted_at = now(),
         stage = case when stage = 'trial' then 'won'::public.lead_stage else stage end
   where id = v_lead_id
     and tenant_id = new.tenant_id
     and trial_started_at is not null
     and trial_converted_at is null;

  update public.tasks
     set status = 'cancelled'
   where tenant_id = new.tenant_id
     and lead_id = v_lead_id
     and status in ('pending', 'snoozed')
     and title like 'Trial%'
     and exists (select 1 from public.leads l
                  where l.id = v_lead_id and l.tenant_id = new.tenant_id
                    and l.trial_started_at is not null);

  return new;
end;
$$;

comment on function public.fn_trial_convert_on_payment() is
  'R-282: a received payment converts the quote''s lead trial (trial_converted_at, trial→won) and cancels its open "Trial…" tasks.';

drop trigger if exists trg_trial_convert_on_payment on public.payments;
create trigger trg_trial_convert_on_payment
  after insert on public.payments
  for each row execute function public.fn_trial_convert_on_payment();
