-- Regression test: S33 (migration 20260928120000_trial_balance_daybook_msme.sql)
--   report_day_book, tds_mark_26as_verified, vendors.udyam/msme_category, msme_payables_aging
--
-- Kya saabit karta hai:
--   1. Day Book me har voucher prakaar EXACT gina hua (count + rupaye), draft/void invoice
--      aur salary_payments (jo pehle se expense row hai) nahi; payment ka din IST me.
--   2. 26AS apply sirf pending_cert/cert_received badalta hai — claimed row aur doosre
--      tenant ki row nahi; future tareekh refuse.
--   3. Udyam format / category constraints.
--   4. MSME aging: sirf micro/small (aur unknown) Udyam vendors, id YA naam se jude bill,
--      45 din ke baad over_limit; medium, non-MSME, paid, doosra tenant — koi nahi.
--   5. Bina tenant ke login → raise.
-- Fixture apna data khud banata hai (L11). Poora `begin … rollback`.

begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('d3300000-0000-0000-0000-0000000000a1', 'S33 TEST A', 's33-a@example.in', '07'),
  ('d3300000-0000-0000-0000-0000000000b1', 'S33 TEST B', 's33-b@example.in', '07');
insert into auth.users (id, email) values
  ('d3300000-0000-0000-0000-0000000000a2', 's33-user-a@example.test'),
  ('d3300000-0000-0000-0000-0000000000c2', 's33-orphan@example.test');
-- R-1004: the day-book reader is an accountant. users.role defaults to 'sales', and since
-- R-1004 sales reads only payments of customers its team manages.
insert into public.users (id, tenant_id, email, role) values
  ('d3300000-0000-0000-0000-0000000000a2', 'd3300000-0000-0000-0000-0000000000a1', 's33-user-a@example.in', 'accountant');

insert into public.customers (id, tenant_id, name) values
  ('d3300000-0000-0000-0000-00000000c001', 'd3300000-0000-0000-0000-0000000000a1', 'S33 Customer'),
  ('d3300000-0000-0000-0000-00000000c0b1', 'd3300000-0000-0000-0000-0000000000b1', 'S33 Customer B');

-- ── Day Book fixture (July 2026) ─────────────────────────────────────────────
-- Sales: INV1 11800 + INV2 5900 = 17700 (draft 1111 aur void 2222 nahi; June wala nahi)
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, taxable_value, tax_amount, tax_rate, status, invoice_date) values
  ('S33-INV1', 'd3300000-0000-0000-0000-0000000000a1', 'd3300000-0000-0000-0000-00000000c001', 'S33 Customer', 11800, 11800, 10000, 1800, 18, 'pending', '2026-07-05'),
  ('S33-INV2', 'd3300000-0000-0000-0000-0000000000a1', 'd3300000-0000-0000-0000-00000000c001', 'S33 Customer',  5900,  5900,  5000,  900, 18, 'paid',    '2026-07-20'),
  ('S33-INV3', 'd3300000-0000-0000-0000-0000000000a1', 'd3300000-0000-0000-0000-00000000c001', 'S33 Customer',  1111,  1111,   942,  169, 18, 'draft',   '2026-07-21'),
  ('S33-INV4', 'd3300000-0000-0000-0000-0000000000a1', 'd3300000-0000-0000-0000-00000000c001', 'S33 Customer',  2222,  2222,  1883,  339, 18, 'void',    '2026-07-22'),
  ('S33-INV5', 'd3300000-0000-0000-0000-0000000000a1', 'd3300000-0000-0000-0000-00000000c001', 'S33 Customer',  3333,  3333,  2825,  508, 18, 'paid',    '2026-06-30'),
  ('S33-INVB', 'd3300000-0000-0000-0000-0000000000b1', 'd3300000-0000-0000-0000-00000000c0b1', 'S33 Customer B', 77777, 77777, 65913, 11864, 18, 'pending', '2026-07-05');
insert into public.quotes (id, tenant_id, customer_id, customer_name) values
  ('S33-Q1', 'd3300000-0000-0000-0000-0000000000a1', 'd3300000-0000-0000-0000-00000000c001', 'S33 Customer');
-- Receipts: P1 30 Jun 20:00 UTC = 1 Jul 01:30 IST → July me (IST din). P2 refunded 15 Jul → Receipt + Refund.
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, reference, status, received_at, refunded_at, receipt_voucher_no, refund_reason) values
  ('d3300000-0000-0000-0000-0000000fa001', 'd3300000-0000-0000-0000-0000000000a1', 'S33-Q1', 'd3300000-0000-0000-0000-00000000c001', 4000, 'upi', 'UTR9', 'received', '2026-06-30 20:00+00', null, 'S33-RV1', null),
  ('d3300000-0000-0000-0000-0000000fa002', 'd3300000-0000-0000-0000-0000000000a1', 'S33-Q1', 'd3300000-0000-0000-0000-00000000c001', 1500, 'upi', null,   'refunded', '2026-07-10 06:00+00', '2026-07-15 06:00+00', 'S33-RV2', 'duplicate');
insert into public.project_sales (id, tenant_id, customer_id, customer_name, title, taxable_amount, gst_amount, total_amount, status) values
  ('d3300000-0000-0000-0000-00000000f001', 'd3300000-0000-0000-0000-0000000000a1', 'd3300000-0000-0000-0000-00000000c001', 'S33 Customer', 'S33 App', 10000, 1800, 11800, 'active');
insert into public.project_payments (tenant_id, project_id, amount, received_at, reference) values
  ('d3300000-0000-0000-0000-0000000000a1', 'd3300000-0000-0000-0000-00000000f001', 2500, '2026-07-12', 'NEFT-77');
insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, credit_date, reason_code, amount, taxable_value, tax_amount, tax_rate, inter_state) values
  ('S33-CN1', 'd3300000-0000-0000-0000-0000000000a1', 'S33-INV2', 'd3300000-0000-0000-0000-00000000c001', 'S33 Customer', '2026-07-25', 'other', 590, 500, 90, 18, false);
insert into public.debit_notes (id, tenant_id, invoice_id, customer_id, customer_name, debit_date, reason_code, amount, taxable_value, tax_amount, tax_rate, inter_state) values
  ('S33-DN1', 'd3300000-0000-0000-0000-0000000000a1', 'S33-INV1', 'd3300000-0000-0000-0000-00000000c001', 'S33 Customer', '2026-07-26', 'other', 1180, 1000, 180, 18, false);

-- ── Vendors (MSME) ───────────────────────────────────────────────────────────
insert into public.vendors (id, tenant_id, name, udyam, msme_category) values
  ('d3300000-0000-0000-0000-00000000fe01', 'd3300000-0000-0000-0000-0000000000a1', 'Micro Supplies', 'UDYAM-DL-01-0000001', 'micro'),
  ('d3300000-0000-0000-0000-00000000fe02', 'd3300000-0000-0000-0000-0000000000a1', 'Medium Corp',    'UDYAM-MH-02-0000002', 'medium'),
  ('d3300000-0000-0000-0000-00000000fe03', 'd3300000-0000-0000-0000-0000000000a1', 'Plain Vendor',   null, null),
  ('d3300000-0000-0000-0000-00000000fe04', 'd3300000-0000-0000-0000-0000000000a1', 'MSME Traders',   'UDYAM-KA-03-0000003', 'small'),
  ('d3300000-0000-0000-0000-00000000fe05', 'd3300000-0000-0000-0000-0000000000a1', 'Unknown Cat Co', 'UDYAM-UP-04-0000004', null),
  ('d3300000-0000-0000-0000-00000000feb1', 'd3300000-0000-0000-0000-0000000000b1', 'Micro Supplies', 'UDYAM-DL-01-0000009', 'micro');

-- Bills / expenses (as of 2026-09-28):
--   VB1 Micro, 2026-08-01 (58 din), 11800 − 1800 paid = 10000 due → OVER
--   VB2 Micro, 2026-09-18 (10 din), 5000 due → within
--   VB3 Micro, fully paid → nahi
--   E1  'msme  traders ' (naam se, vendor_id null) 2026-07-30 (60 din) 7000 → OVER
--   E2  Medium Corp (id) 2026-07-01 9000 → nahi (43B(h) medium par nahi)
--   E3  Plain Vendor 2026-07-01 4000 → nahi (Udyam nahi)
--   E4  Micro (id) paid → nahi
--   E5  Unknown Cat Co (id) 2026-08-10 (49 din) 3000 → OVER (category unknown = covered)
--   E6  Micro (id) July Day Book ke liye bhi: 2026-07-08 paid 2026-07-18
--   EB  tenant B Micro 2026-07-01 → nahi
insert into public.vendor_bills (id, tenant_id, vendor_name, vendor_id, bill_no, bill_date, category, subtotal, cgst, sgst, igst, total, status, paid_amount) values
  ('S33-VB1', 'd3300000-0000-0000-0000-0000000000a1', 'Micro Supplies', 'd3300000-0000-0000-0000-00000000fe01', 'MS-1', '2026-08-01', 'COGS-Google', 10000, 900, 900, 0, 11800, 'partial', 1800),
  ('S33-VB2', 'd3300000-0000-0000-0000-0000000000a1', 'Micro Supplies', 'd3300000-0000-0000-0000-00000000fe01', 'MS-2', '2026-09-18', 'COGS-Google',  5000,   0,   0, 0,  5000, 'unpaid',     0),
  ('S33-VB3', 'd3300000-0000-0000-0000-0000000000a1', 'Micro Supplies', 'd3300000-0000-0000-0000-00000000fe01', 'MS-3', '2026-07-14', 'COGS-Google',  2000,   0,   0, 0,  2000, 'paid',    2000),
  ('S33-VBB', 'd3300000-0000-0000-0000-0000000000b1', 'Micro Supplies', 'd3300000-0000-0000-0000-00000000feb1', 'MS-B', '2026-07-01', 'COGS-Google', 66666,   0,   0, 0, 66666, 'unpaid',     0);
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_no, paid, paid_date, payment_method) values
  ('S33-E1', 'd3300000-0000-0000-0000-0000000000a1', 'Supplies', 'msme  traders ', null,                                   '2026-07-30', 7000, 0, 'MT-1', false, null, null),
  ('S33-E2', 'd3300000-0000-0000-0000-0000000000a1', 'Supplies', 'Medium Corp',    'd3300000-0000-0000-0000-00000000fe02', '2026-07-01', 9000, 0, null,   false, null, null),
  ('S33-E3', 'd3300000-0000-0000-0000-0000000000a1', 'Supplies', 'Plain Vendor',   'd3300000-0000-0000-0000-00000000fe03', '2026-07-01', 4000, 0, null,   false, null, null),
  ('S33-E4', 'd3300000-0000-0000-0000-0000000000a1', 'Supplies', 'Micro Supplies', 'd3300000-0000-0000-0000-00000000fe01', '2026-06-01', 1000, 0, null,   true,  '2026-06-05', 'bank'),
  ('S33-E5', 'd3300000-0000-0000-0000-0000000000a1', 'Supplies', 'Unknown Cat Co', 'd3300000-0000-0000-0000-00000000fe05', '2026-08-10', 3000, 0, null,   false, null, null),
  ('S33-E6', 'd3300000-0000-0000-0000-0000000000a1', 'Software', 'Micro Supplies', 'd3300000-0000-0000-0000-00000000fe01', '2026-07-08', 1200, 0, 'SW-7', true,  '2026-07-18', 'card'),
  -- Salary expense rows (20260929185929): Journal voucher, Purchase nahi. Paid wali ka bhugtan Payment hi.
  ('S33-E7', 'd3300000-0000-0000-0000-0000000000a1', 'Salaries', 'S33 Employee', null, '2026-07-31', 30000, 0, 'SAL-7', true,  '2026-07-31', 'bank'),
  ('S33-E8', 'd3300000-0000-0000-0000-0000000000a1', 'Director''s Remuneration', 'S33 Director', null, '2026-07-31', 50000, 0, 'DIR-7', false, null, null),
  ('S33-EB', 'd3300000-0000-0000-0000-0000000000b1', 'Supplies', 'Micro Supplies', 'd3300000-0000-0000-0000-00000000feb1', '2026-07-01', 5555, 0, null,   false, null, null);

-- Salary: har salary ek expense row bhi hoti hai; Day Book salary_payments se kuch na le.
insert into public.employees (id, tenant_id, name) values
  ('d3300000-0000-0000-0000-00000000e401', 'd3300000-0000-0000-0000-0000000000a1', 'S33 Employee');
insert into public.salary_payments (tenant_id, employee_id, period, pay_date, gross, net, paid_amount, paid_status) values
  ('d3300000-0000-0000-0000-0000000000a1', 'd3300000-0000-0000-0000-00000000e401', '2026-07', '2026-07-31', 30000, 28000, 28000, 'paid');

-- ── TDS receivable (26AS apply) ──────────────────────────────────────────────
insert into public.tds_receivable (id, tenant_id, customer_name, customer_tan, section, rate_pct, gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, status) values
  ('S33-T1', 'd3300000-0000-0000-0000-0000000000a1', 'S33 Customer', 'DELA12345B', '194J', 10, 10000, 1000, 9000, 'FY2627', '2026-05-20', 'pending_cert'),
  ('S33-T2', 'd3300000-0000-0000-0000-0000000000a1', 'S33 Customer', 'DELA12345B', '194J', 10,  5000,  500, 4500, 'FY2627', '2026-06-20', 'cert_received'),
  ('S33-T3', 'd3300000-0000-0000-0000-0000000000a1', 'S33 Customer', 'DELA12345B', '194J', 10,  7000,  700, 6300, 'FY2526', '2025-06-20', 'claimed'),
  ('S33-TB', 'd3300000-0000-0000-0000-0000000000b1', 'S33 Customer B', 'DELB12345C', '194J', 10, 5000, 500, 4500, 'FY2627', '2026-06-20', 'pending_cert');

-- ── 3. Constraints (fixture ke saath hi, postgres role me) ───────────────────
do $$
declare ok int := 0;
begin
  begin
    insert into public.vendors (tenant_id, name, udyam) values ('d3300000-0000-0000-0000-0000000000a1', 'Bad Udyam', 'UDYAM-DL-1-123');
  exception when check_violation then ok := ok + 1; end;
  begin
    insert into public.vendors (tenant_id, name, msme_category) values ('d3300000-0000-0000-0000-0000000000a1', 'Cat no Udyam', 'micro');
  exception when check_violation then ok := ok + 1; end;
  begin
    insert into public.vendors (tenant_id, name, udyam, msme_category) values ('d3300000-0000-0000-0000-0000000000a1', 'Bad Cat', 'UDYAM-DL-01-0000005', 'large');
  exception when check_violation then ok := ok + 1; end;
  if ok <> 3 then raise exception 'FAIL 3: only % of 3 bad vendor MSME rows were refused', ok; end if;
  raise notice 'PASS 3: udyam format, category values and category-needs-udyam are enforced';
end $$;

-- ── Identity: tenant A ka user ───────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"d3300000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;

-- ── 1. Day Book ──────────────────────────────────────────────────────────────
do $$
declare j jsonb; r record; v_n int;
begin
  j := public.report_day_book('2026-07-01', '2026-07-31');
  for r in
    select x->>'voucher' as voucher, count(*) as n, sum((x->>'amount')::bigint) as amt
      from jsonb_array_elements(j) x group by 1
  loop
    if (r.voucher, r.n, r.amt) not in (
         ('Sales', 2, 17700),          -- INV1 + INV2
         ('Receipt', 3, 8000),         -- P1 4000 (IST 1 Jul) + P2 1500 + project 2500
         ('Refund', 1, 1500),
         ('Credit Note', 1, 590),
         ('Debit Note', 1, 1180),
         ('Purchase', 5, 23200),       -- E1 7000 + E2 9000 + E3 4000 + E6 1200 + VB3 2000 (salary nahi)
         ('Journal', 2, 80000),        -- E7 Salaries 30000 + E8 Director's Remuneration 50000
         ('Payment', 2, 31200)) then   -- E6 1200 + E7 salary ka bhugtan 30000
      raise exception 'FAIL 1: day book % = % rows / ₹% — %', r.voucher, r.n, r.amt, j;
    end if;
  end loop;
  select count(distinct x->>'voucher') into v_n from jsonb_array_elements(j) x;
  if v_n <> 8 then raise exception 'FAIL 1: expected all 8 voucher types, got % — %', v_n, j; end if;
  if not j @> '[{"voucher":"Journal","reference":"SAL-7","narration":"Salaries"}]'::jsonb
     or j @> '[{"voucher":"Purchase","reference":"SAL-7"}]'::jsonb then
    raise exception 'FAIL 1: a salary expense must be a Journal voucher, never Purchase: %', j;
  end if;
  if not j @> '[{"voucher":"Receipt","reference":"S33-RV1","date":"2026-07-01","narration":"upi · UTR9","party":"S33 Customer"}]'::jsonb then
    raise exception 'FAIL 1: P1 should sit on 1 Jul (IST day of 30 Jun 20:00 UTC): %', j;
  end if;
  if j::text like '%S33-INV3%' or j::text like '%S33-INV4%' or j::text like '%77777%' or j::text like '%28000%' then
    raise exception 'FAIL 1: draft/void invoice, tenant B, or a salary_payments row leaked into the day book: %', j;
  end if;
  -- Order: date, phir voucher kram.
  if (j->0->>'date') <> '2026-07-01' then raise exception 'FAIL 1: not in date order: %', j->0; end if;

  begin
    perform public.report_day_book('2026-01-01', '2027-03-31');
    raise exception 'FAIL 1: a 455-day range was not refused';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS 1: day book — every voucher type counted exactly, IST day, no draft/void/salary/tenant-B';
end $$;

-- ── 2. 26AS apply ────────────────────────────────────────────────────────────
do $$
declare v_n int; v_s text; v_d date;
begin
  v_n := public.tds_mark_26as_verified(array['S33-T1', 'S33-T2', 'S33-T3', 'S33-TB'], '2026-09-20');
  if v_n <> 2 then raise exception 'FAIL 2: expected 2 rows verified (T1, T2), got %', v_n; end if;
  select status, appears_in_26as_date into v_s, v_d from public.tds_receivable where id = 'S33-T1';
  if v_s <> 'verified_26as' or v_d <> '2026-09-20' then raise exception 'FAIL 2: T1 is % / %', v_s, v_d; end if;
  select status into v_s from public.tds_receivable where id = 'S33-T3';
  if v_s <> 'claimed' then raise exception 'FAIL 2: a CLAIMED row was pulled back to %', v_s; end if;
  begin
    perform public.tds_mark_26as_verified(array['S33-T1'], (now() at time zone 'Asia/Kolkata')::date + 5);
    raise exception 'FAIL 2: a future 26AS date was accepted';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS 2: 26AS apply touches only open rows of this tenant';
end $$;

reset role;
do $$
declare v_s text;
begin
  select status into v_s from public.tds_receivable where id = 'S33-TB';
  if v_s <> 'pending_cert' then raise exception 'FAIL 2b: tenant B''s TDS row changed to % from tenant A''s call', v_s; end if;
  raise notice 'PASS 2b: tenant B row untouched';
end $$;
select set_config('request.jwt.claims',
  '{"sub":"d3300000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
set local role authenticated;

-- ── 4. MSME payables aging ───────────────────────────────────────────────────
do $$
declare j jsonb; v_over bigint; v_total bigint; v_n int;
begin
  select jsonb_agg(to_jsonb(m)), count(*), sum(m.amount_due), sum(m.amount_due) filter (where m.over_limit)
    into j, v_n, v_total, v_over
    from public.msme_payables_aging('2026-09-28') m;
  if v_n <> 4 then raise exception 'FAIL 4: expected 4 MSME payables (VB1, VB2, E1, E5), got % — %', v_n, j; end if;
  if v_total <> 25000 then raise exception 'FAIL 4: total due expected 25000 (10000+5000+7000+3000), got %', v_total; end if;
  if v_over <> 20000 then raise exception 'FAIL 4: over-45-days expected 20000 (VB1 + E1 + E5), got % — %', v_over, j; end if;
  if not j @> '[{"doc_id":"S33-E1","vendor_name":"MSME Traders","msme_category":"small","days_outstanding":60,"deadline":"2026-09-13","over_limit":true}]'::jsonb then
    raise exception 'FAIL 4: name-matched expense E1 wrong: %', j;
  end if;
  if not j @> '[{"doc_id":"S33-VB2","days_outstanding":10,"over_limit":false}]'::jsonb then
    raise exception 'FAIL 4: VB2 (10 days) should be within the limit: %', j;
  end if;
  if (j->0->>'over_limit')::boolean is not true then raise exception 'FAIL 4: over-limit rows must come first: %', j; end if;
  raise notice 'PASS 4: MSME aging — micro/small/unknown only, id or name link, 45-day flag exact';
end $$;

-- ── 5. Bina tenant ────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"d3300000-0000-0000-0000-0000000000c2","role":"authenticated"}', true);
do $$
declare ok int := 0;
begin
  begin perform public.report_day_book('2026-07-01', '2026-07-31'); exception when insufficient_privilege then ok := ok + 1; end;
  begin perform public.tds_mark_26as_verified(array['S33-T1'], '2026-09-20'); exception when insufficient_privilege then ok := ok + 1; end;
  begin perform public.msme_payables_aging(null); exception when insufficient_privilege then ok := ok + 1; end;
  if ok <> 3 then raise exception 'FAIL 5: only % of 3 functions refused a login with no tenant', ok; end if;
  raise notice 'PASS 5: no-tenant login refused';
end $$;

reset role;
do $$
begin
  if has_function_privilege('anon', 'public.report_day_book(date, date)', 'execute')
     or has_function_privilege('anon', 'public.tds_mark_26as_verified(text[], date)', 'execute')
     or has_function_privilege('anon', 'public.msme_payables_aging(date)', 'execute') then
    raise exception 'FAIL 6: anon can execute an S33 function';
  end if;
  raise notice 'PASS 6: anon has no execute';
end $$;

select 'PASS trial_balance_daybook_msme' as result;
rollback;
