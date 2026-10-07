-- S45 slice 1 — every money event keeps the Trial Balance in balance (Dr = Cr).
--
-- ResellerOS has no journal: the Trial Balance is DERIVED from report_balance_sheet
-- (today's balances) + report_pnl (FY to date). So "balanced posting" means: an event may
-- move heads, but Dr − Cr must not move. This test takes Dr − Cr before and after each
-- event on a fresh tenant and asserts the change is 0.
--
-- pg_temp.tb_gap() mirrors lib/accounting/trial-balance.ts + report-rpc.ts for the heads
-- these events touch (no fixed assets, no expense GST → ITC split not needed; statutory
-- dues = withheld − paid, as statutoryDues() does while nothing is overpaid).
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/tb_money_events_balanced.test.sql
--   (or: node scripts/test-sql.mjs --local tb_money_events_balanced)
--
-- Self-asserting; ROLLS BACK.

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('5e450000-0000-4000-8000-000000000001', 'S45 TB TEST', 's45@example.in', '07', 'S45T');
insert into auth.users (id, instance_id, aud, role, email) values
  ('5e450000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's45-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('5e450000-0000-4000-8000-0000000000a1', '5e450000-0000-4000-8000-000000000001', 's45-user@example.in', 'owner');
insert into public.customers (id, tenant_id, name, country, state_code, state) values
  ('5e450000-0000-4000-8000-0000000000c1', '5e450000-0000-4000-8000-000000000001', 'S45 Cust', 'India', '07', 'Delhi');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('5e450000-0000-4000-8000-0000000000b1', '5e450000-0000-4000-8000-000000000001', 'S45 HDFC', 'HDFC', 0, '2026-04-01');

-- 8 quotes, ₹11,800 each (₹10,000 + 18% GST), all intra-state.
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate,
                           line_items, status, payment_status, payment_terms_days)
select 'S45Q-' || n, '5e450000-0000-4000-8000-000000000001', '5e450000-0000-4000-8000-0000000000c1',
       'S45 Cust', 11800, 10000, 18, '[]'::jsonb, 'sent', 'awaiting', 30
  from generate_series(1, 8) n;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '5e450000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);

/* Dr − Cr of the derived Trial Balance (0 = books tally without a plug). */
create function pg_temp.tb_gap() returns bigint language plpgsql as $$
declare
  b record; p record;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_fy date;
  v_dues bigint; v_gst bigint; v_assets bigint; v_liab bigint; v_profit bigint;
begin
  select * into b from public.report_balance_sheet(null);
  v_fy := make_date(b.fy_start_year, 4, 1);
  select * into p from public.report_pnl(v_fy, v_today);
  v_dues := b.dues_salary_tds + b.dues_pf + b.dues_esi + b.dues_vendor_tds
          - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(b.dues_paid) x), 0);
  v_gst  := b.gst_output - b.bills_gst
          - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(b.tax_payments) x where x->>'kind' = 'gst'), 0);
  v_assets := b.cash_and_bank + b.undeposited_funds + b.receivables + b.project_receivable + b.tds_receivable
            + b.employee_loans + b.prepaid_advances + b.emi_unregistered_cost;
  v_liab   := b.credit_card_payable + b.payables + b.advances_from_customers + b.salary_payable + v_dues
            + b.reimbursements_payable + b.emi_loans_payable + b.business_loans_payable + v_gst;
  v_profit := (p.inv_taxable - p.cn_taxable + p.dn_taxable) - p.cogs - p.commissions
            - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(p.expense_groups) x), 0);
  return v_assets - v_liab - v_profit;
end $$;

create temp table s45_results (event text, delta bigint, must_balance boolean) on commit drop;

create function pg_temp.step(p_event text, p_before bigint, p_must boolean default true) returns bigint language plpgsql as $$
declare v_after bigint := pg_temp.tb_gap();
begin
  insert into s45_results values (p_event, v_after - p_before, p_must);
  return v_after;
end $$;

do $$
declare
  g bigint;
  v_inv text;
  v_pay uuid;
  v_txn uuid;
  v_emp uuid;
begin
  g := pg_temp.tb_gap();
  if g <> 0 then raise exception 'FAIL setup: empty tenant is not balanced (%)', g; end if;

  -- 1. Invoice issued (no advance): Dr receivable 11,800 = Cr sales 10,000 + GST 1,800.
  perform public.generate_invoice('S45Q-1');
  g := pg_temp.step('1 invoice issued', g);

  -- 2. Part payment ₹5,000 against it: Dr money received, Cr receivable.
  perform public.record_payment('S45Q-1', 5000, 'upi', 'S45-UTR-1', null);
  g := pg_temp.step('2 part payment on invoice', g);

  -- 3. Balance ₹6,800: invoice becomes paid.
  perform public.record_payment('S45Q-1', 6800, 'upi', 'S45-UTR-2', null);
  g := pg_temp.step('3 final payment settles invoice', g);

  -- 4. Payment with TDS: customer pays ₹10,800 + deducts ₹1,000 TDS (settles ₹11,800).
  perform public.generate_invoice('S45Q-2');
  g := pg_temp.step('4a invoice issued (TDS customer)', g);
  select id into v_inv from public.invoices where quote_id = 'S45Q-2';
  perform public.record_payment_with_tds('S45Q-2', 11800, 'bank_transfer', 'S45-UTR-3', null,
    1000, 10000, 10800, '194J', 10, null, v_inv, null);
  g := pg_temp.step('4b payment with TDS', g);

  -- 5. Overpayment after invoice: ₹12,800 on ₹11,800 — ₹1,000 owed back to customer.
  perform public.generate_invoice('S45Q-3');
  g := pg_temp.step('5a invoice issued', g);
  perform public.record_payment('S45Q-3', 12800, 'upi', 'S45-UTR-4', null);
  g := pg_temp.step('5b overpayment on invoice', g);

  -- 6. Credit note ₹1,180 on the PAID invoice of quote 1 (money now owed back).
  select id into v_inv from public.invoices where quote_id = 'S45Q-1';
  perform public.issue_credit_note(v_inv, 1180, 'other', 'S45 discount after payment', null);
  g := pg_temp.step('6 credit note on paid invoice', g);

  -- 7. Credit note ₹1,180 on a PENDING invoice.
  perform public.generate_invoice('S45Q-4');
  g := pg_temp.step('7a invoice issued', g);
  select id into v_inv from public.invoices where quote_id = 'S45Q-4';
  perform public.issue_credit_note(v_inv, 1180, 'other', 'S45 discount before payment', null);
  g := pg_temp.step('7b credit note on pending invoice', g);

  -- 8. Advance before invoice, then the invoice adjusts it.
  perform public.record_payment('S45Q-5', 4000, 'upi', 'S45-UTR-5', null);
  g := pg_temp.step('8a advance received (no invoice yet)', g);
  perform public.generate_invoice('S45Q-5');
  g := pg_temp.step('8b invoice adjusts the advance', g);

  -- 9. Refund of an advance (pre-invoice).
  select (public.record_payment('S45Q-6', 3000, 'upi', 'S45-UTR-6', null)->>'payment_id')::uuid into v_pay;
  g := pg_temp.step('9a advance received', g);
  perform public.refund_payment(v_pay, 'S45 test refund');
  g := pg_temp.step('9b advance refunded', g);

  -- 10. Undeposited → bank: a receipt matched to the bank line that carried it.
  select (public.record_payment('S45Q-7', 11800, 'bank_transfer', 'S45-UTR-7', null)->>'payment_id')::uuid into v_pay;
  g := pg_temp.step('10a receipt (not yet in bank)', g);
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source)
    values (gen_random_uuid(), '5e450000-0000-4000-8000-000000000001', '5e450000-0000-4000-8000-0000000000b1',
            current_date, 'NEFT S45-UTR-7', 0, 11800, 'manual') returning id into v_txn;
  -- (an unmatched bank credit is unexplained money until matched — so compare 10a → 10b)
  perform public.reconcile_bank_txn(v_txn, 'payment', v_pay::text, 'manual');
  g := pg_temp.step('10b bank line matched to the receipt', g);

  -- 11. Salary booked (unpaid): Dr salary 30,000 = Cr net payable + TDS + PF.
  insert into public.employees (id, tenant_id, name, monthly_gross)
    values (gen_random_uuid(), '5e450000-0000-4000-8000-000000000001', 'S45 Emp', 30000) returning id into v_emp;
  perform public.pay_salary(v_emp, to_char(current_date, 'YYYY-MM'), current_date, 30000, 0, 0, 0, null,
                            1000, 1800, 0, 0, '5e450000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null);
  g := pg_temp.step('11 salary booked', g);

  /* ── KNOWN GAPS (S45 slice 2: needs a real journal) — measured, printed, not asserted ──
     They are here so the size of each gap is visible on every run, and so the day one of
     them is fixed the line can flip to must_balance = true. */

  -- G1. Razorpay fee: bank line arrives ₹236 short of the receipt and is matched anyway.
  select (public.record_payment('S45Q-8', 11800, 'razorpay', 'pay_S45TEST', null)->>'payment_id')::uuid into v_pay;
  g := pg_temp.step('G1a razorpay receipt', g);
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source)
    values (gen_random_uuid(), '5e450000-0000-4000-8000-000000000001', '5e450000-0000-4000-8000-0000000000b1',
            current_date, 'RAZORPAY SETTLEMENT', 0, 11564, 'manual') returning id into v_txn;
  perform public.reconcile_bank_txn(v_txn, 'payment', v_pay::text, 'manual');
  g := pg_temp.step('G1b razorpay settlement net of fee (KNOWN GAP)', g, false);

  -- G2. Expense paid in cash, no bank line: Dr expense, no Cr anywhere.
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values ('EXP-S45-1', '5e450000-0000-4000-8000-000000000001', 'Office Supplies', 'S45 Shop', current_date, 500, 0, 'cash', 'S45 cash expense');
  g := pg_temp.step('G2 cash expense, no bank line (KNOWN GAP)', g, false);

  -- G3. Salary with an "other" deduction: the ₹500 withheld lands in no liability.
  perform public.pay_salary(v_emp, to_char(current_date - 31, 'YYYY-MM'), current_date, 30000, 0, 0, 0, null,
                            0, 0, 0, 500, '5e450000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null);
  g := pg_temp.step('G3 salary other deduction (KNOWN GAP)', g, false);
end $$;

do $$
declare r record; v_bad text := '';
begin
  for r in select * from s45_results loop
    raise notice '% → TB moves by %', rpad(r.event, 45), r.delta;
    if r.must_balance and r.delta <> 0 then
      v_bad := v_bad || format(E'\n  %s: Dr − Cr moved by %s', r.event, r.delta);
    end if;
  end loop;
  if v_bad <> '' then
    raise exception 'FAIL: unbalanced money events:%', v_bad;
  end if;
  raise notice 'PASS: tb_money_events_balanced';
end $$;

rollback;
