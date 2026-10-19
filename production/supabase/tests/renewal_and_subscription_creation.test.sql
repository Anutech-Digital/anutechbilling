-- Regression tests: renewal roll-forward + monthly-flex subscription behaviour
-- Use-cases R-07 and P-05 (see docs/SPINE-TEST-USE-CASES.md). Run on a dev/test
-- DB (NOT prod). Self-asserting (RAISEs on failure); each in a rolled-back txn.
--   psql "$DATABASE_URL" -f renewal_and_subscription_creation.test.sql

-- ── R-07: paying a renewal quote rolls the EXISTING sub forward (no new sub) ──
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('aaaaaaaa-0000-0000-0000-0000000000a1', 'REN TEST', 'ren@example.in', '07');
insert into public.customers (id, tenant_id, name)
  values ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'Ren Cust');
-- seed PO series high so the roll-forward's auto-PO doesn't hit the global PO-id collision
insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values ('aaaaaaaa-0000-0000-0000-0000000000a1', 'purchase_order', public.indian_fiscal_year(current_date), 'PO', 9000);
-- quote FIRST (subscription.renewal_quote_id FKs to it)
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items)
  values ('Q-REN-T', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'Ren Cust', 103680, 'sent', 'awaiting',
          '[{"name":"Google Workspace Standard","qty":10,"rate":10368,"commitment":"annual_yearly"}]'::jsonb);
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date, renewal_state, renewal_quote_id)
  values (gen_random_uuid(), 'aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-0000000000c1',
          'Ren Cust', 'Google Workspace Standard', 'google', 10, 7200, 'active', current_date, 'reminder_2', 'Q-REN-T');

do $$
declare n integer; st text; advanced boolean; cleared boolean;
begin
  perform public.record_payment('Q-REN-T', 103680, 'razorpay', 'rzp_ren');
  select count(*), max(renewal_state),
         bool_and(renewal_date = (current_date + interval '12 months')::date),
         bool_and(renewal_quote_id is null)
    into n, st, advanced, cleared
    from public.subscriptions where customer_id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
  if n <> 1 then raise exception 'FAIL renewal: expected 1 sub (no duplicate), got %', n; end if;
  if st <> 'renewed' then raise exception 'FAIL renewal: expected renewal_state=renewed, got %', st; end if;
  if not advanced then raise exception 'FAIL renewal: renewal_date not advanced 12 months'; end if;
  if not cleared then raise exception 'FAIL renewal: renewal_quote_id not cleared'; end if;
  raise notice 'PASS R-07: renewal rolled forward, 1 sub, +12mo, renewed';
end $$;
rollback;

-- ── P-05: a monthly-flex sale creates a ONE-MONTH subscription ──────────────
-- Open question #29 was answered on 22 Aug 2026: it should, and 85a5d67 made it so.
--
-- Until then this case asserted `expected 0 subs (flex = no annual sub)` and its own note
-- said "if that changes, update this test". The behaviour changed that morning and this file
-- kept asserting the old answer — nobody saw it, because `supabase/tests/` is in neither CI
-- nor the Stop hook. It was still red when the suite was finally run that evening.
--
-- All four numbers below were measured against the live DB, not assumed, and each one is a
-- bug that shipped this month:
--   term_months = 1   → picks the monthly reminder ladder instead of the annual one (069617e)
--   mrr         = 3900 → the FULL month, not a twelfth of it. The rebuild path returned 325
--                        here and that number would have gone into every revenue report (da19166)
--   renewal      = start + 1 MONTH, not + 1 year (da19166)
begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.tenants (id, name, email, state_code)
  values ('aaaaaaaa-0000-0000-0000-0000000000a2', 'FLEX TEST', 'flex@example.in', '07');
insert into public.customers (id, tenant_id, name)
  values ('aaaaaaaa-0000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'Flex Cust');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items)
  values ('Q-FLEX-T', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'Flex Cust', 3900, 'sent', 'awaiting',
          '[{"name":"Google Workspace Standard","qty":5,"rate":780,"commitment":"monthly"}]'::jsonb);
do $$
declare n integer; v_mrr integer; v_term integer; v_start date; v_renew date;
begin
  perform public.record_payment('Q-FLEX-T', 3900, 'razorpay', 'rzp_flex');
  select count(*), max(mrr), max(term_months), max(start_date), max(renewal_date)
    into n, v_mrr, v_term, v_start, v_renew
    from public.subscriptions where customer_id = 'aaaaaaaa-0000-0000-0000-0000000000c2';

  if n <> 1 then raise exception 'FAIL monthly-flex: expected 1 subscription, got %', n; end if;
  if v_term <> 1 then raise exception 'FAIL monthly-flex: term_months should be 1 (it picks the reminder ladder), got %', v_term; end if;

  /* 780 x 5 seats = 3900 for ONE month. A twelfth of it is 325, which is what the rebuild
     path used to hand back — so this assertion is the one that would have caught da19166. */
  if v_mrr <> 3900 then raise exception 'FAIL monthly-flex: mrr should be 3900 (the full month), got % — a twelfth would be 325', v_mrr; end if;

  /* Relative to start_date, not to a fixed date, so the test does not rot overnight. */
  if v_renew <> (v_start + interval '1 month')::date then
    raise exception 'FAIL monthly-flex: renewal should be start + 1 month (% + 1mo), got %', v_start, v_renew;
  end if;

  raise notice 'PASS P-05: monthly-flex created 1 sub, term 1, mrr 3900, renewal +1 month';
end $$;
rollback;

-- One visible row, because a NOTICE does not survive `supabase db query -f`: an empty result
-- with exit 0 looks identical to a file that asserted nothing.
select 'PASS' as renewal_and_subscription_creation;
