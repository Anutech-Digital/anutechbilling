-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'subscriptions_term_follows_line' and tgrelid = to_regclass('public.subscriptions'))
-- deploy-key: r1445termfollowsline
-- 20261023162200_r1445_subscription_term_follows_line.sql
--
-- R-1445 (+ the R-1442 follow-up) — a subscription filed from a quote follows ITS LINE's term.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   1. R-1445 (Pratik, staging 16 Oct): a domain paid for 3 years. The quote builder already
--      has "Register for 1-10 years" on a domain line (R-156) and the line's rate is the whole
--      term's price — but every filing path (record_payment, activate_quote_on_credit,
--      file_invoiced_quote_subscriptions; latest bodies 20261021023154 / 20261019164713) writes
--      renewal_date = start + 1 year. So the subscription came up for renewal after ONE year,
--      and its mrr was the 3-year price / 12 (three times too high).
--   2. R-1442 follow-up: Onboard subscription → "Payment Received". The dialog shows a
--      Renewal / Expiry date (default start + 12 months - 1 day, editable). record_payment
--      ignored it and wrote start + 1 year, so a hand-edited expiry was lost on the paid path.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   One BEFORE INSERT trigger on subscriptions — the same pattern, and the same reason, as
--   subscriptions_cycle_follows_quote (20260817120000): the rule is about the ROW, several
--   functions insert it, and re-deploying 800 lines of record_payment to change one date is a
--   poor trade. It acts ONLY when the insert carries the filers' own default
--   (renewal_date = start_date + 1 year, or + 1 month) and the row has a quote_id:
--     - the quote line for this row (same name as the plan; same domain preferred) has a
--       `renewal_date` after the start (at most 10 years out) → that date;
--     - else, on a yearly default, the line has `years` 2..10 → renewal = start + years, and
--       mrr = the filed mrr / years (the rate was the whole term's price).
--   Any other insert — a caller that chose its own date (Onboard postpaid, import, renewals,
--   the cart's domain subscriptions, which have no quote_id) — is left exactly as it was.
--   term_months is not touched: after the first term a domain renews yearly, as the cart's
--   domain subscriptions already do (lib/domains/renewal.ts domainSubscriptionInsert).
--
-- No data is changed. Existing subscriptions keep their dates.

begin;

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
  'R-1445: a subscription filed from a quote with the default term (start + 1 year / + 1 month) takes its line''s renewal_date (Onboard dialog), or start + years for a multi-year domain line (mrr spread over the years). Any caller-chosen date is kept.';

-- Trigger function only: nobody calls it.
revoke all on function public.subscription_term_follows_line() from public, anon, authenticated;

drop trigger if exists subscriptions_term_follows_line on public.subscriptions;
create trigger subscriptions_term_follows_line
  before insert on public.subscriptions
  for each row
  execute function public.subscription_term_follows_line();

commit;
