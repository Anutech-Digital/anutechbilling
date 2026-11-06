-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_subscriptions_zzz_split_term_covers' and tgrelid = to_regclass('public.subscriptions')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.subscription_term_follows_line()') and prosrc like '%R-2533%')
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
--   The R-1445 trigger no longer copies a too-short quote-line renewal_date onto a split-billed
--   row (it keeps the filer's start + 1 year), so a payment is never refused for it.
--   The app's half: currentTermStart never returns a date before start_date, and
--   subscriptionSchedule lays no parts for a short split-billed term (same card).
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

-- ─── The way Suresh's date got in: R-1445 copies the quote line's renewal_date ──────────────
-- Body as in 20261023162200 (the only definition) plus one R-2533 rule: on a split-billed row a
-- line renewal_date shorter than one term is NOT copied — the filer's own default (start + 1
-- year, a whole annual term) stays. R-1445 must never fail a payment, and the guard above would
-- otherwise refuse the whole record_payment / reconcile for a date typed on the quote line.
create or replace function public.subscription_term_follows_line()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lines   jsonb;
  v_line    jsonb;
  v_yearly  boolean;
  v_renewal date;
  v_years   int;
  v_term    int;
  v_cycle_m int;
begin
  -- R-1445
  if new.quote_id is null or new.start_date is null or new.renewal_date is null then
    return new;
  end if;

  v_yearly := new.renewal_date = (new.start_date + interval '1 year')::date;
  if not v_yearly and new.renewal_date <> (new.start_date + interval '1 month')::date then
    return new;   -- the caller chose its own date: keep it
  end if;

  select q.line_items into v_lines
    from public.quotes q
   where q.id = new.quote_id and q.tenant_id = new.tenant_id;
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' then
    return new;
  end if;

  select t.e into v_line
    from jsonb_array_elements(v_lines) with ordinality as t(e, i)
   where jsonb_typeof(t.e) = 'object'
     and lower(btrim(coalesce(t.e->>'name', ''))) = lower(btrim(coalesce(new.plan, '')))
   order by (nullif(lower(btrim(coalesce(t.e->>'domain', ''))), '')
               is not distinct from nullif(lower(btrim(coalesce(new.domain, ''))), '')) desc,
            t.i
   limit 1;
  if v_line is null then
    return new;
  end if;

  -- 1. The date the operator saw / typed (Onboard dialog → line.renewal_date).
  if coalesce(v_line->>'renewal_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then
    begin
      v_renewal := (v_line->>'renewal_date')::date;
    exception when others then
      v_renewal := null;   -- 2026-02-30 and the like: ignore, never fail the payment
    end;
    -- R-2533: split-billed (more than one part per term) → the line date must cover one whole
    -- term, else it is the next PART's date (Suresh: 19 Dec on a 19 Jun annual half-yearly sale).
    v_term := greatest(1, coalesce(new.term_months, 12));
    v_cycle_m := case coalesce(new.billing_cycle::text, '')
                   when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6 else null end;
    if v_renewal is not null and v_cycle_m is not null and v_cycle_m < v_term
       and v_renewal < (new.start_date + make_interval(months => v_term))::date - 1 then
      raise notice 'R-2533: quote % line renewal date % is shorter than its %-month term — kept %',
        new.quote_id, v_renewal, v_term, new.renewal_date;
      v_renewal := null;
    end if;
    if v_renewal > new.start_date and v_renewal <= (new.start_date + interval '10 years')::date then
      new.renewal_date := v_renewal;
      return new;
    end if;
  end if;

  -- 2. A domain registered for several years (line.years, R-156).
  if v_yearly and coalesce(v_line->>'years', '') ~ '^\d+$' then
    v_years := (v_line->>'years')::int;
    if v_years between 2 and 10 then
      new.renewal_date := (new.start_date + make_interval(years => v_years))::date;
      new.mrr := round(coalesce(new.mrr, 0)::numeric / v_years)::int;
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.subscription_term_follows_line() is
  'R-1445: a subscription filed from a quote with the default term (start + 1 year / + 1 month) takes its line''s renewal_date (Onboard dialog), or start + years for a multi-year domain line (mrr spread over the years). Any caller-chosen date is kept. R-2533: on a split-billed row a line date shorter than one term is not copied.';

revoke all on function public.subscription_term_follows_line() from public, anon, authenticated;

drop trigger if exists trg_subscriptions_zzz_split_term_covers on public.subscriptions;
create trigger trg_subscriptions_zzz_split_term_covers
  before insert or update on public.subscriptions
  for each row
  execute function public.subscription_split_term_covers();

commit;
