-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_subscriptions_zzz_split_term_covers' and tgrelid = to_regclass('public.subscriptions'))
-- deploy-key: r2533splittermcovers
-- 20261106132256_r2533_split_billed_term_covers.sql
--
-- R-2533 (6 Nov 2026, found by w-term-scan) — a split-billed subscription's renewal date must
-- cover at least one whole term from its start date.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Suresh Kumar & Co (staging sub 52a285c1): start 19 Jun 2026, renewal 19 Dec 2026, term 12
--   months, half-yearly. The renewal date was the next HALF, not the end of the year. The billing
--   schedule counts the term back from the renewal date (subscription-schedule.ts
--   currentTermStart: 20 Dec 2026 − 12 months = 20 Dec 2025), so part #1 ran 20 Dec 2025 –
--   20 Jun 2026 and INV-A378-26-0001 was dated 20 Dec 2025 — six months before the sale.
--   R-2095 closed the bank-receipt way in (bank_credit_pay_item); the R-1445 trigger
--   (subscription_term_follows_line) still takes any line renewal date after the start, and the
--   Onboard expiry, "Correct details", imports and a quote line's renewal_date can all write it.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   One BEFORE INSERT OR UPDATE trigger on subscriptions, named to fire LAST (after
--   subscriptions_cycle_follows_quote and subscriptions_term_follows_line have set the cycle and
--   the renewal date, and after trg_subscriptions_zz_term_amount). For a split-billed row — paid
--   monthly / quarterly / half-yearly with more than one part per term — it refuses
--   renewal_date < start_date + term_months − 1 day (the inclusive last day of the first term;
--   the anniversary shape is one day later and passes too). Renewed rows are later still.
--   On UPDATE it checks only when start_date, renewal_date, term_months or billing_cycle change,
--   so existing rows keep working for every other edit (status, seats, payments).
--   Cancelled / expired rows are left alone: cancelling writes the last day of service as
--   renewal_date, mid-term on purpose (cancel_subscription, R-1711).
--   The app's half: currentTermStart never returns a date before start_date (same card).
--
--   The SQL twin of currentTermStart (correct_subscription_commitment's v_tstart, latest body
--   20261031032023) is left as it is: it only asks "is today inside the current term" to stop a
--   mid-term shortening, and a clamp changes its answer only on days before start_date.
--
-- Staging read-only check (6 Nov 2026): 14 split-billed rows; the only one this refuses is
-- 52a285c1 (Suresh), which is being repaired separately. No data is changed here.

begin;

create or replace function public.subscription_split_term_covers()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_term     int;
  v_cycle_m  int;
  v_min      date;
  v_label    text;
begin
  -- R-2533
  if new.start_date is null or new.renewal_date is null or new.billing_cycle is null then
    return new;
  end if;
  -- An ended subscription's renewal_date is its last day of service (cancel_subscription writes
  -- the last covered day mid-term on purpose) — not a term end; nothing more is laid from it.
  if new.status::text in ('cancelled', 'expired') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.start_date   is not distinct from old.start_date
     and new.renewal_date is not distinct from old.renewal_date
     and new.term_months  is not distinct from old.term_months
     and new.billing_cycle is not distinct from old.billing_cycle then
    return new;
  end if;

  v_term := greatest(1, coalesce(new.term_months, 12));
  v_cycle_m := case new.billing_cycle::text
                 when 'monthly' then 1
                 when 'quarterly' then 3
                 when 'half_yearly' then 6
                 else null end;
  if v_cycle_m is null or v_cycle_m >= v_term then
    return new;   -- one invoice per term: not split-billed
  end if;

  v_min := (new.start_date + make_interval(months => v_term))::date - 1;
  if new.renewal_date < v_min then
    v_label := replace(new.billing_cycle::text, '_', '-');
    raise exception 'The renewal date % is too early. This subscription is paid % on a %-month term that starts %, so its renewal date must be on or after % (the last day of the term). Set the renewal date to % — the % parts are made from it automatically.',
      to_char(new.renewal_date, 'DD Mon YYYY'), v_label, v_term,
      to_char(new.start_date, 'DD Mon YYYY'), to_char(v_min, 'DD Mon YYYY'),
      to_char(v_min, 'DD Mon YYYY'), v_label
      using errcode = '22023';
  end if;
  return new;
end;
$function$;

comment on function public.subscription_split_term_covers() is
  'R-2533: a split-billed subscription (more than one part per term) must have renewal_date >= start_date + term_months - 1 day, so its term can never be counted back to before the sale.';

-- Trigger function only: nobody calls it.
revoke all on function public.subscription_split_term_covers() from public, anon, authenticated;

drop trigger if exists trg_subscriptions_zzz_split_term_covers on public.subscriptions;
create trigger trg_subscriptions_zzz_split_term_covers
  before insert or update on public.subscriptions
  for each row
  execute function public.subscription_split_term_covers();

commit;
