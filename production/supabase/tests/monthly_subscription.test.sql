-- Regression test for 20260822120000_monthly_subscriptions.sql
--
-- THE REPORT: a tester paid Rs 38,232 in full for a MONTHLY Google Workspace quote on
-- 22 Aug 2026 and no subscription appeared. He filed it twice. record_payment created
-- subscriptions only for annual commitments, so every monthly sale was invisible in
-- /subscriptions and absent from MRR.
--
-- THE CASES (each FAILS LOUDLY -- the file is self-asserting)
--   1. A monthly quote now produces a subscription.              <- the report
--   2. ...marked billing_cycle='monthly', term_months=1.         <- so a future cadence can find it
--   3. ...with renewal_date one MONTH out.                       <- chaseable, once the ladder is term-aware
--   4. ...and MRR NOT divided by 12.                             <- the silent 12x error
--   5. An ANNUAL quote is completely unchanged.                  <- no regression
--   6. A one-off quote still produces nothing.                   <- not over-corrected
--
-- ON CASE 3, WHICH IS THE ONE WORTH ARGUING ABOUT. /api/cron/renewals has two passes and a
-- monthly row must escape both. The cadence pass needs renewal_date IS NOT NULL, so a
-- monthly subscription with a date would be emailed on a T-30 schedule that, on a 30-day
-- cycle, never stops. The lapse pass expires auto_renew=false rows whose renewal_date has
-- passed, so that escape hatch would silently expire every monthly subscription a month
-- after creation. NULL is excluded from both, and it is true: we do not track when these
-- renew yet.
--
-- ON CASE 4: both inserts derive MRR as amount/12 because an annual line covers a year. A
-- monthly line amount is already monthly. Reusing that division would have booked
-- Rs 38,232/month as Rs 3,186/month, and an MRR that is wrong by twelve times is the kind
-- of number a business plans against.
--
-- SAFETY: synthetic tenant, synthetic quotes, one transaction, ends in ROLLBACK.

begin;

select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

insert into public.tenants (id, name, email, doc_code, tier)
values ('33333333-3333-3333-3333-333333333333', 'ZZ MONTHLY TEST', 'zz-monthly@example.invalid', 'ZZMON', 'reseller');

insert into public.customers (id, tenant_id, name, state_code, state)
values ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333', 'ZZ Monthly Buyer', '07', 'Delhi');

-- Rs 38,232 for 10 seats, billed MONTHLY — the shape of Q-TEST-2026-27-0009.
-- billing_cycle is set on every one of the 45 live quotes, and the trigger
-- subscription_cycle_follows_quote copies it onto the subscription. Omitting it here made
-- the fixture disagree with itself (quote said yearly, line said monthly) and the test
-- reported a bug that only existed in the fixture.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, status, payment_status, discount_pct, billing_cycle, line_items)
values
  ('ZZ-MON-MONTHLY', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
   'ZZ Monthly Buyer', 38232, 38232, 'sent', 'none', 0, 'monthly',
   '[{"name":"Google Workspace Business Starter","qty":10,"rate":3823.2,"commitment":"monthly"}]'::jsonb),
  ('ZZ-MON-ANNUAL', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
   'ZZ Monthly Buyer', 38232, 38232, 'sent', 'none', 0, 'yearly',
   '[{"name":"Google Workspace Business Starter","qty":10,"rate":3823.2,"commitment":"annual_yearly"}]'::jsonb),
  ('ZZ-MON-ONEOFF', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444',
   'ZZ Monthly Buyer', 1500, 1500, 'sent', 'none', 0, 'yearly',
   '[{"name":"Domain Registration","qty":1,"rate":1500}]'::jsonb);

do $$
declare
  s record;
  n integer;
begin
  -- ── 1..4: the monthly quote ────────────────────────────────────────────────
  perform public.record_payment('ZZ-MON-MONTHLY', 38232, 'bank_transfer', 'ZZ-MON-1');

  select count(*) into n from public.subscriptions where quote_id = 'ZZ-MON-MONTHLY';
  if n <> 1 then
    raise exception 'CASE 1 FAIL: a paid monthly quote produced % subscriptions, expected 1', n;
  end if;

  select * into s from public.subscriptions where quote_id = 'ZZ-MON-MONTHLY';

  if s.billing_cycle <> 'monthly' then
    raise exception 'CASE 2 FAIL: billing_cycle is "%" — a future monthly cadence finds these rows by this column', s.billing_cycle;
  end if;
  if s.term_months <> 1 then
    raise exception 'CASE 2 FAIL: term_months is %, expected 1', s.term_months;
  end if;

  /* A REAL date now. It was NULL while the cadence was annual-only and would have emailed
     a monthly customer seven times a month; cadence.ts picks the ladder from term_months
     now (T-7/T-3/T-0 for a one-month term), so the honest date is safe and the
     subscription can finally be chased. */
  /* IS DISTINCT FROM, not <>. NULL <> date is NULL, not TRUE, so a plain <> silently
     passes on exactly the value this case exists to reject — the assertion would have
     been vacuous against the old function, which set NULL. Caught by running it before
     applying the migration and getting an impossible PASS. */
  /* R-1953: ist_today(), not current_date. record_payment starts the subscription on
     public.ist_today() (R-1816). current_date is the UTC date, a day behind IST from
     18:30 to 24:00 UTC, so this case failed every night in CI. Same 'today' as the code. */
  if s.renewal_date is distinct from (public.ist_today() + interval '1 month')::date then
    raise exception 'CASE 3 FAIL: renewal_date is %, expected one month out', s.renewal_date;
  end if;

  /* Rs 38,232 a month is Rs 38,232 of MRR. The /12 that is right for an annual line would
     book it as 3,186. */
  if s.mrr <> 38232 then
    raise exception 'CASE 4 FAIL: mrr is % but the line is Rs 38,232 PER MONTH (a /12 would give 3186)', s.mrr;
  end if;

  -- ── 5: the annual path must be untouched ───────────────────────────────────
  perform public.record_payment('ZZ-MON-ANNUAL', 38232, 'bank_transfer', 'ZZ-MON-2');
  select * into s from public.subscriptions where quote_id = 'ZZ-MON-ANNUAL';
  if s is null then
    raise exception 'CASE 5 FAIL: the annual quote stopped creating a subscription';
  end if;
  if s.billing_cycle <> 'yearly' or s.term_months <> 12 then
    raise exception 'CASE 5 FAIL: annual subscription now reads %/% months', s.billing_cycle, s.term_months;
  end if;
  if s.renewal_date is distinct from (public.ist_today() + interval '1 year')::date then  -- R-1953: IST, as above
    raise exception 'CASE 5 FAIL: annual renewal_date is %, expected one year out', s.renewal_date;
  end if;
  /* 38,232 a YEAR is 3,186 a month — the division that must stay for annual lines. */
  if s.mrr <> 3186 then
    raise exception 'CASE 5 FAIL: annual mrr is %, expected 3186 (38232/12)', s.mrr;
  end if;

  -- ── 6: a one-off still produces nothing ────────────────────────────────────
  perform public.record_payment('ZZ-MON-ONEOFF', 1500, 'cash', 'ZZ-MON-3');
  select count(*) into n from public.subscriptions where quote_id = 'ZZ-MON-ONEOFF';
  if n <> 0 then
    raise exception 'CASE 6 FAIL: a one-off purchase created % subscriptions — over-corrected', n;
  end if;

  raise notice 'ALL 6 CASES PASS';
end $$;

select 'PASS' as result;

rollback;
