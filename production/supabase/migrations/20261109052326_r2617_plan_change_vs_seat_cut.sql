-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'subscriptions_r2617_plan_change_vs_seat_cut')
-- deploy-key: r2617planchangevsseatcut
-- 20261109052326_r2617_plan_change_vs_seat_cut.sql
--
-- R-2617 (8 Nov 2026, split from R-2590 — R-2227 review low (a); money rule N5 / C3 family).
--
-- A seat cut scheduled "At end of term" (R-2252, subscription_seat_reductions timing end_of_term,
-- status scheduled, dated the renewal) is billed by the renewal quote (R-2583/R-2613). Change plan
-- (R-2227) never read it: a plan change to new seats left the cut row "scheduled" but no longer
-- matching (seats_before <> seats) — the owner still saw a cut scheduled, the renewal silently kept
-- the new seats ("seats changed" note) and the cut was cancelled at roll. Guessing how to re-base the
-- cut ("N fewer" or "down to M") is not ours to make, so the rule is the R-2589/R-2605 style REFUSAL:
--
--   while an end-of-term seat cut is scheduled for this term, the plan cannot change — remove the
--   scheduled seat cut in Manage seats first (or make the cut part of the renewal).
--
-- The app refuses it in buildPlanChange (preview AND save, lib/subscriptions/change-plan.ts). This
-- trigger is the guard under the row lock for every other path and the ms race (cut scheduled
-- between the route's read and the quote being paid):
--
--   subscriptions_r2617_plan_change_vs_seat_cut (BEFORE UPDATE OF item_id): the plan (item_id)
--   changes, the renewal date does NOT move (a renewal paid with a new plan moves it on — that is
--   R-2608's trigger, which marks the cut applied/cancelled) and a scheduled end_of_term cut is dated
--   this renewal → raise. Covers record_payment of a plan-change quote (R-2227 body sets item_id,
--   plan, seats, mrr in one update) and Correct details (correct_subscription_terms). A cascade from
--   another trigger (pg_trigger_depth() > 1) is let through, as in R-2605.
--
-- The message starts "R-2617: plan change refused" so the Razorpay webhook treats it like R-2589's
-- refusals (late-payment.server.ts PLAN_CHANGE_REFUSED_RE → settleRefusedPlanChange: owner told,
-- money kept as advance / refund, never booked wrongly).
-- Stored rows are NOT changed. auth.role() is not used; nothing here needs a role check (trigger).
-- Test: supabase/tests/r2617_plan_change_vs_seat_cut.test.sql (begin … rollback; red without this file).

begin;

create or replace function public.r2617_plan_change_vs_seat_cut()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2617: a scheduled end-of-term seat cut (R-2252) is billed by the renewal quote on the seats it
   was made on; a plan change under it leaves it stale and silently lost at renewal. Refuse the plan
   change while such a cut is scheduled for this term — the owner removes the cut first. */
declare
  v_cut public.subscription_seat_reductions%rowtype;
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;
  if old.renewal_date is null then
    return new;
  end if;
  select * into v_cut
    from public.subscription_seat_reductions r
   where r.tenant_id = new.tenant_id and r.subscription_id = new.id
     and r.status = 'scheduled' and r.timing = 'end_of_term'
     and r.effective_date = old.renewal_date
   order by r.created_at desc
   limit 1;
  if found then
    raise exception 'R-2617: plan change refused — a seat cut % → % is scheduled for the end of this term (%). Remove the scheduled seat cut in Manage seats first, then change the plan.',
      v_cut.seats_before, v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke all on function public.r2617_plan_change_vs_seat_cut() from public, anon, authenticated;

drop trigger if exists subscriptions_r2617_plan_change_vs_seat_cut on public.subscriptions;
create trigger subscriptions_r2617_plan_change_vs_seat_cut
  before update of item_id on public.subscriptions
  for each row
  when (new.item_id is distinct from old.item_id
        and new.renewal_date is not distinct from old.renewal_date)
  execute function public.r2617_plan_change_vs_seat_cut();

commit;
