-- Regression test: R-2624 — the P&L "Management (matched)" view spreads prepaid multi-month
-- revenue over the months it pays for (yearly invoice = 1/12 a month), remainder in the last month.
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2624_pnl_revenue_matched.test.sql
--
-- Fixture (tenant A; every document dated Sep..Dec 2026):
--   Y1   1 Oct  ₹12,000 yearly quote (annual_yearly, billing yearly)     → 1,000 × Oct..Sep
--   RND  5 Oct  ₹1,000 annual line, no quote                             → 83 × 11 + 87 (Sep 2027)
--   QTR 10 Oct  ₹3,000 billing part 1 Oct..1 Jan (period_end = next part's start) → 1,000 × Oct..Dec
--   PRO 25 Sep  ₹700 '(pro-rata from 2026-09-25 to 2027-03-31)' add-seats → 100 × Sep..Mar
--   ONE 12 Oct  ₹500 one-off quote                                       → Oct only
--   MIX 15 Oct  ₹1,200 annual Google line + ₹300 setup line (no commitment) → 100 × Oct..Sep + 300 Oct
--   REN 20 Oct  ₹2,400 renewal quote, extension_months 24                → 100 × Oct 2026..Sep 2028
--   LNG 21 Oct  ₹4,800 extension quote, extension_months 48 (over 36)    → Oct only
--   CN-Y1 15 Dec credit note ₹9,000 on Y1                                → −900 × Dec..Sep
--   DRF / VOI  draft and void invoices                                   → never revenue
--   OPN 31 Mar Zoho opening invoice (not a sale)                         → never revenue (a credit note on it is refused)
--   Tenant B: one yearly invoice (must never show).
-- A. Oct 2026 Management revenue and the Y1 row; GST view (report_pnl) still has ₹12,000 in Oct.
-- B. Rounding: RND's months add to 1,000 with 87 in Sep 2027; a range cutting a month (1–15 Oct)
--    takes Y1's October by days (1,000 × 15 / 31 = 484).
-- C. QTR: 1,000 in Oct, Nov, Dec and nothing in Jan.
-- D. PRO: 100 in Sep 2026 and Mar 2027, nothing in Apr; revenue_period_months anniversary = 12.
-- E. ONE / MIX setup / LNG: invoice month only.
-- F. CN-Y1: Nov untouched (1,000), Dec..Sep 1,000 − 900 = 100.
-- G. Draft / void invoices never appear.
-- H. Over every service month the total = report_pnl revenue of the same documents, and each
--    family = report_pnl_revenue_by_product; report_pnl_revenue_matched = sum of its lines.
-- I. revenue_period_months / revenue_line_service_period rules (broken range, >36 → invoice month).
-- J. No company → refused; tenant B never appears.
-- K. Review fixes: a one_time line stays in its month (OT); a line start_date moves the term (SD);
--    a renewal starts the day after renewal_term_date (RN2); an invoice dated 5 Nov for Sep..Oct
--    counts in Sep and Oct (LATE); ₹10 over 12 months has no ₹0 drill rows (TEN).

begin;

insert into public.tenants (id, name, email, state_code) values
  ('d2624000-0000-0000-0000-0000000000a1', 'R2624 A', 'r2624-a@example.in', '07'),
  ('d2624000-0000-0000-0000-0000000000b1', 'R2624 B', 'r2624-b@example.in', '07');
insert into auth.users (id, email) values
  ('d2624000-0000-0000-0000-0000000000a2', 'r2624-user-a@example.test'),
  ('d2624000-0000-0000-0000-0000000000b2', 'r2624-user-b@example.test'),
  ('d2624000-0000-0000-0000-0000000000c2', 'r2624-nobody@example.test');
insert into public.users (id, tenant_id, email, role) values
  ('d2624000-0000-0000-0000-0000000000a2', 'd2624000-0000-0000-0000-0000000000a1', 'r2624-user-a@example.in', 'owner'),
  ('d2624000-0000-0000-0000-0000000000b2', 'd2624000-0000-0000-0000-0000000000b1', 'r2624-user-b@example.in', 'owner');

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('R2624-GW', 'd2624000-0000-0000-0000-0000000000a1', 'Business Starter', 'google', 1000, 600);

insert into public.quotes (id, tenant_id, customer_name, billing_cycle, is_one_off, is_add_seats, is_renewal, is_extension, extension_months, line_items) values
  ('Q-R2624-Y1',  'd2624000-0000-0000-0000-0000000000a1', 'Cust Y', 'yearly', false, false, false, false, 12,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":12000,"commitment":"annual_yearly"}]'),
  ('Q-R2624-PRO', 'd2624000-0000-0000-0000-0000000000a1', 'Cust P', 'yearly', false, true, false, false, 12,
   '[{"id":"l1","name":"Business Starter · +1 seats (pro-rata from 2026-09-25 to 2027-03-31)","item_id":"R2624-GW","qty":1,"rate":700,"commitment":"annual_yearly"}]'),
  ('Q-R2624-ONE', 'd2624000-0000-0000-0000-0000000000a1', 'Cust O', 'yearly', true, false, false, false, 12,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":500,"commitment":"annual_yearly"}]'),
  ('Q-R2624-REN', 'd2624000-0000-0000-0000-0000000000a1', 'Cust R', 'yearly', false, false, true, false, 24,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":2400,"commitment":"annual_yearly"}]'),
  ('Q-R2624-LNG', 'd2624000-0000-0000-0000-0000000000a1', 'Cust L', 'yearly', false, false, false, true, 48,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":4800,"commitment":"annual_yearly"}]');
-- a renewal made for the term that renews on 26 Nov: the money buys 27 Nov 2026 .. 26 Nov 2027
insert into public.quotes (id, tenant_id, customer_name, billing_cycle, is_one_off, is_add_seats, is_renewal, is_extension, extension_months, renewal_term_date, line_items) values
  ('Q-R2624-RN2', 'd2624000-0000-0000-0000-0000000000a1', 'Cust W', 'yearly', false, false, true, false, 12, '2026-11-26',
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":1200,"commitment":"annual_yearly"}]');

insert into public.invoices (id, tenant_id, customer_name, amount, taxable_value, tax_amount, tax_rate, status, invoice_date, document_kind, quote_id, line_items) values
  ('R2624-Y1',  'd2624000-0000-0000-0000-0000000000a1', 'Cust Y', 14160, 12000, 2160, 18, 'paid',    '2026-10-01', 'tax_invoice', 'Q-R2624-Y1', '[]'),
  ('R2624-RND', 'd2624000-0000-0000-0000-0000000000a1', 'Cust D', 1180,  1000,  180,  18, 'pending', '2026-10-05', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":1000,"commitment":"annual_yearly"}]'),
  ('R2624-QTR', 'd2624000-0000-0000-0000-0000000000a1', 'Cust Q', 3540,  3000,  540,  18, 'paid',    '2026-10-10', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":3000,"commitment":"annual_yearly"}]'),
  ('R2624-PRO', 'd2624000-0000-0000-0000-0000000000a1', 'Cust P', 826,   700,   126,  18, 'paid',    '2026-09-25', 'tax_invoice', 'Q-R2624-PRO', '[]'),
  ('R2624-ONE', 'd2624000-0000-0000-0000-0000000000a1', 'Cust O', 590,   500,   90,   18, 'paid',    '2026-10-12', 'tax_invoice', 'Q-R2624-ONE', '[]'),
  ('R2624-MIX', 'd2624000-0000-0000-0000-0000000000a1', 'Cust M', 1770,  1500,  270,  18, 'overdue', '2026-10-15', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":1200,"commitment":"annual_yearly"},
     {"id":"l2","name":"Setup and migration","qty":1,"rate":300}]'),
  ('R2624-REN', 'd2624000-0000-0000-0000-0000000000a1', 'Cust R', 2832,  2400,  432,  18, 'paid',    '2026-10-20', 'tax_invoice', 'Q-R2624-REN', '[]'),
  ('R2624-LNG', 'd2624000-0000-0000-0000-0000000000a1', 'Cust L', 5664,  4800,  864,  18, 'paid',    '2026-10-21', 'tax_invoice', 'Q-R2624-LNG', '[]'),
  ('R2624-DRF', 'd2624000-0000-0000-0000-0000000000a1', 'Cust F', 1180,  1000,  180,  18, 'draft',   '2026-10-22', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":1000,"commitment":"annual_yearly"}]'),
  ('R2624-VOI', 'd2624000-0000-0000-0000-0000000000a1', 'Cust V', 1180,  1000,  180,  18, 'void',    '2026-10-23', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":1000,"commitment":"annual_yearly"}]'),
  ('R2624-B',   'd2624000-0000-0000-0000-0000000000b1', 'Cust B', 14160, 12000, 2160, 18, 'paid',    '2026-10-01', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","qty":1,"rate":12000,"commitment":"annual_yearly"}]'),
  -- review fixes (K): one-time line beside an annual line; a line start_date; a late pro-rata invoice
  -- whose window is BEFORE its date; ₹10 over 12 months (₹0 months are not rows)
  ('R2624-OT',  'd2624000-0000-0000-0000-0000000000a1', 'Cust T', 2124,  1800,  324,  18, 'paid',    '2026-11-12', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":1200,"commitment":"annual_yearly"},
     {"id":"l2","name":"Business Starter setup","item_id":"R2624-GW","qty":1,"rate":600,"commitment":"one_time"}]'),
  ('R2624-SD',  'd2624000-0000-0000-0000-0000000000a1', 'Cust S', 1416,  1200,  216,  18, 'paid',    '2026-11-14', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":1200,"commitment":"annual_yearly","start_date":"2027-01-01"}]'),
  ('R2624-LATE','d2624000-0000-0000-0000-0000000000a1', 'Cust E', 236,   200,   36,   18, 'paid',    '2026-11-05', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter · +1 seats (pro-rata from 2026-09-25 to 2026-10-31)","item_id":"R2624-GW","qty":1,"rate":200,"commitment":"annual_yearly"}]'),
  ('R2624-TEN', 'd2624000-0000-0000-0000-0000000000a1', 'Cust N', 12,    10,    2,    18, 'paid',    '2026-11-20', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":10,"commitment":"annual_yearly"}]'),
  ('R2624-RN2', 'd2624000-0000-0000-0000-0000000000a1', 'Cust W', 1416,  1200,  216,  18, 'paid',    '2026-11-10', 'tax_invoice', 'Q-R2624-RN2', '[]'),
  -- checker BLOCK (L): the FIRST billing part of a split-billed sale carries the quote's setup line
  -- tagged one_time_of (R-2095) — ₹3,000 annual (part Oct..Dec) + ₹1,000 setup (October only)
  ('R2624-PT1', 'd2624000-0000-0000-0000-0000000000a1', 'Cust K', 4720,  4000,  720,  18, 'paid',    '2026-10-03', 'tax_invoice', null,
   '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":3000,"commitment":"annual_yearly"},
     {"id":"l2","name":"Business Starter setup","item_id":"R2624-GW","qty":1,"rate":1000,"cost":0,"one_time_of":"Q-R2624-PT"}]'),
  -- re-check BLOCK (O): an invoice raised for a billing part with NO lines (like local SCN-ADS-INV3)
  ('R2624-NOL', 'd2624000-0000-0000-0000-0000000000a1', 'Cust J', 3540,  3000,  540,  18, 'paid',    '2026-06-01', 'tax_invoice', null, '[]');

-- the Zoho opening invoice (only the import may write one) — not revenue in either view
select set_config('app.opening_invoice_import', 'on', true);
insert into public.invoice_import_batches (id, tenant_id) values ('d2624000-0000-0000-0000-0000000000f1', 'd2624000-0000-0000-0000-0000000000a1');
insert into public.invoices (id, tenant_id, customer_name, amount, taxable_value, tax_amount, tax_rate, status, invoice_date, document_kind,
                             opening_balance, external_number, import_batch_id, line_items) values
  ('R2624-OPN', 'd2624000-0000-0000-0000-0000000000a1', 'Cust Z', 5000, 5000, 0, 0, 'pending', '2026-03-31', 'opening_invoice',
   5000, 'ZB-2624', 'd2624000-0000-0000-0000-0000000000f1', '[{"id":"l1","name":"Business Starter","item_id":"R2624-GW","qty":1,"rate":5000,"commitment":"annual_yearly"}]');
select set_config('app.opening_invoice_import', '', true);

insert into public.subscriptions (id, tenant_id, customer_name, plan, vendor, seats, mrr, start_date, renewal_date, billing_cycle, term_months) values
  ('d2624000-0000-0000-0000-0000000000e1', 'd2624000-0000-0000-0000-0000000000a1', 'Cust Q', 'Business Starter', 'google', 1, 1000, '2026-10-01', '2027-10-01', 'quarterly', 12);
insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, invoice_id) values
  ('d2624000-0000-0000-0000-0000000000a1', 'd2624000-0000-0000-0000-0000000000e1', '2026-10-01', 1, '2026-10-01', '2026-10-01', '2027-01-01', 3000, 'R2624-QTR'),
  ('d2624000-0000-0000-0000-0000000000a1', 'd2624000-0000-0000-0000-0000000000e1', '2027-10-01', 1, '2026-10-03', '2026-10-01', '2027-01-01', 3000, 'R2624-PT1'),
  ('d2624000-0000-0000-0000-0000000000a1', 'd2624000-0000-0000-0000-0000000000e1', '2025-06-01', 1, '2026-06-01', '2026-06-01', '2026-09-01', 3000, 'R2624-NOL');

insert into public.credit_notes (id, tenant_id, invoice_id, customer_name, reason_code, amount, taxable_value, tax_amount, tax_rate, credit_date) values
  ('CN-R2624-Y1', 'd2624000-0000-0000-0000-0000000000a1', 'R2624-Y1', 'Cust Y', 'other', 10620, 9000, 1620, 18, '2026-12-15');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'd2624000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);


-- ── A. October 2026 ────────────────────────────────────────────────────────────────────
do $$
declare v bigint; g bigint; per text;
begin
  select sum(l.amount) into v from public.report_pnl_revenue_matched_lines('2026-10-01', '2026-10-31') l where l.doc_id = 'R2624-Y1';
  if v is distinct from 1000 then raise exception 'FAIL A1: Y1 in Oct = % (want 1000 — 12,000 / 12)', v; end if;
  select l.service_from || '..' || l.service_to || ':' || l.basis || ':' || l.doc_amount into per
    from public.report_pnl_revenue_matched_lines('2026-10-01', '2026-10-31') l where l.doc_id = 'R2624-Y1';
  if per is distinct from '2026-10-01..2027-09-30:term:12000' then raise exception 'FAIL A2: Y1 period = %', per; end if;
  select r.inv_taxable into g from public.report_pnl('2026-10-01', '2026-10-31') r;
  if g < 12000 then raise exception 'FAIL A3: GST view (report_pnl) Oct invoiced % lost the whole Y1', g; end if;
  select r.inv_taxable into v from public.report_pnl_revenue_matched('2026-10-01', '2026-10-31') r;
  -- Oct: Y1 1000 + RND 83 + QTR 1000 + PRO 100 + ONE 500 + MIX (100 + 300) + REN 100 + LNG 4800
  --      + LATE 100 (dated 5 Nov, for Sep..Oct) + PT1 (1,000 part + 1,000 setup) = 10083
  if v is distinct from 10083 then raise exception 'FAIL A4: Oct Management invoiced = % (want 10083)', v; end if;
  select sum(l.amount) into v from public.report_pnl_revenue_matched_lines('2027-09-01', '2027-09-30') l where l.doc_id = 'R2624-Y1';
  if v is distinct from 1000 then raise exception 'FAIL A5: Y1 in Sep 2027 = %', v; end if;
  select count(*) into v from public.report_pnl_revenue_matched_lines('2027-10-01', '2027-10-31') l where l.doc_id = 'R2624-Y1';
  if v <> 0 then raise exception 'FAIL A6: Y1 still in Oct 2027'; end if;
end $$;

-- ── B. Rounding + a range cutting a month ──────────────────────────────────────────────
do $$
declare v bigint; tot bigint;
begin
  select sum(l.amount) into v from public.report_pnl_revenue_matched_lines('2026-11-01', '2026-11-30') l where l.doc_id = 'R2624-RND';
  if v is distinct from 83 then raise exception 'FAIL B1: RND Nov = % (want 83)', v; end if;
  select sum(l.amount) into v from public.report_pnl_revenue_matched_lines('2027-09-01', '2027-09-30') l where l.doc_id = 'R2624-RND';
  if v is distinct from 87 then raise exception 'FAIL B2: RND last month = % (want 87 = 1000 - 83 x 11)', v; end if;
  select sum(l.amount) into tot from public.report_pnl_revenue_matched_lines('2026-10-01', '2027-09-30') l where l.doc_id = 'R2624-RND';
  if tot is distinct from 1000 then raise exception 'FAIL B3: RND over its term = % (want 1000)', tot; end if;
  select sum(l.amount) into v from public.report_pnl_revenue_matched_lines('2026-10-01', '2026-10-15') l where l.doc_id = 'R2624-Y1';
  if v is distinct from 484 then raise exception 'FAIL B4: Y1 1-15 Oct = % (want 484 = 1000 x 15/31)', v; end if;
end $$;

-- ── C. Billing part (quarterly) ────────────────────────────────────────────────────────
do $$
declare v bigint; per text;
begin
  select string_agg(coalesce((select sum(l.amount) from public.report_pnl_revenue_matched_lines(m, (m + interval '1 month' - interval '1 day')::date) l where l.doc_id = 'R2624-QTR'), 0)::text, ',' order by m)
    into per from unnest(array['2026-10-01','2026-11-01','2026-12-01','2027-01-01']::date[]) m;
  if per is distinct from '1000,1000,1000,0' then raise exception 'FAIL C1: QTR Oct..Jan = % (want 1000,1000,1000,0)', per; end if;
  select l.basis into per from public.report_pnl_revenue_matched_lines('2026-10-01', '2026-10-31') l where l.doc_id = 'R2624-QTR';
  if per is distinct from 'billing_part' then raise exception 'FAIL C2: QTR basis = %', per; end if;
end $$;

-- ── D. Dated add-seats line ────────────────────────────────────────────────────────────
do $$
declare per text;
begin
  select string_agg(coalesce((select sum(l.amount) from public.report_pnl_revenue_matched_lines(m, (m + interval '1 month' - interval '1 day')::date) l where l.doc_id = 'R2624-PRO'), 0)::text, ',' order by m)
    into per from unnest(array['2026-09-01','2027-03-01','2027-04-01']::date[]) m;
  if per is distinct from '100,100,0' then raise exception 'FAIL D1: PRO Sep/Mar/Apr = % (want 100,100,0)', per; end if;
  if public.revenue_period_months('2026-10-15', '2027-10-14') <> 12
     or public.revenue_period_months('2026-10-01', '2027-09-30') <> 12
     or public.revenue_period_months('2026-09-25', '2027-03-31') <> 7
     or public.revenue_period_months('2026-10-01', '2026-12-31') <> 3
     or public.revenue_period_months('2026-10-29', '2027-01-28') <> 3   -- billing part 29 Oct..29 Jan (end - 1)
     or public.revenue_period_months('2026-10-01', '2026-12-30') <> 3   -- an inclusive 31 Dec end, minus 1
     or public.revenue_period_months('2026-10-10', '2026-10-01') is not null then
    raise exception 'FAIL D2: revenue_period_months rules';
  end if;
end $$;

-- ── E. Invoice month only: one-off quote, setup line, period over 36 months ────────────
do $$
declare v bigint;
begin
  select coalesce(sum(l.amount), 0) into v from public.report_pnl_revenue_matched_lines('2026-11-01', '2027-12-31') l
   where l.doc_id in ('R2624-ONE', 'R2624-LNG');
  if v <> 0 then raise exception 'FAIL E1: one-off / 48-month extension spread after Oct (%)', v; end if;
  select sum(l.amount) into v from public.report_pnl_revenue_matched_lines('2026-11-01', '2026-11-30') l where l.doc_id = 'R2624-MIX';
  if v is distinct from 100 then raise exception 'FAIL E2: MIX Nov = % (want 100: only the annual line spreads)', v; end if;
  select sum(l.amount) into v from public.report_pnl_revenue_matched_lines('2028-09-01', '2028-09-30') l where l.doc_id = 'R2624-REN';
  if v is distinct from 100 then raise exception 'FAIL E3: 24-month renewal in Sep 2028 = %', v; end if;
end $$;

-- ── F. Credit note follows its invoice from the note month ─────────────────────────────
do $$
declare per text;
begin
  select string_agg(coalesce((select sum(l.amount) from public.report_pnl_revenue_matched_lines(m, (m + interval '1 month' - interval '1 day')::date) l where l.invoice_id = 'R2624-Y1'), 0)::text, ',' order by m)
    into per from unnest(array['2026-11-01','2026-12-01','2027-09-01','2027-10-01']::date[]) m;
  if per is distinct from '1000,100,100,0' then raise exception 'FAIL F1: Y1 net Nov/Dec/Sep/Oct27 = % (want 1000,100,100,0)', per; end if;
end $$;

-- ── G. Draft / void never revenue ──────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from public.report_pnl_revenue_matched_lines('2026-01-01', '2030-12-31') l where l.doc_id in ('R2624-DRF', 'R2624-VOI')) then
    raise exception 'FAIL G: draft / void invoice counted';
  end if;
end $$;

-- ── G2. A Zoho opening invoice is never revenue (R-1739) ─────────────────────────────
do $$
begin
  if exists (select 1 from public.report_pnl_revenue_matched_lines('2026-01-01', '2030-12-31') l where l.invoice_id = 'R2624-OPN') then
    raise exception 'FAIL G2: opening invoice counted as revenue';
  end if;
end $$;

-- ── H. Totals over every service month = GST view; per family = R-2181 ─────────────────
do $$
declare m record; g record; diff text; lsum bigint;
begin
  select * into m from public.report_pnl_revenue_matched('2026-09-01', '2029-12-31');
  select * into g from public.report_pnl('2026-09-01', '2026-12-31');
  if m.inv_taxable - m.cn_taxable + m.dn_taxable is distinct from g.inv_taxable - g.cn_taxable + g.dn_taxable
     or m.inv_taxable is distinct from g.inv_taxable or m.cn_taxable is distinct from g.cn_taxable then
    raise exception 'FAIL H1: Management total % / % <> GST % / %', m.inv_taxable, m.cn_taxable, g.inv_taxable, g.cn_taxable;
  end if;
  select string_agg(coalesce(a.family, b.family), ',') into diff
    from (select x->>'family' as family, (x->>'invoiced')::bigint - (x->>'credit_notes')::bigint + (x->>'debit_notes')::bigint as net
            from jsonb_array_elements(m.by_product) x) a
    full join (select r.family, r.invoiced - r.credit_notes + r.debit_notes as net
                 from public.report_pnl_revenue_by_product('2026-09-01', '2026-12-31') r) b on a.family = b.family
   where a.net is distinct from b.net;
  if diff is not null then raise exception 'FAIL H2: families differ from report_pnl_revenue_by_product: %', diff; end if;
  select sum(l.amount) into lsum from public.report_pnl_revenue_matched_lines('2026-10-01', '2026-10-31') l;
  select * into m from public.report_pnl_revenue_matched('2026-10-01', '2026-10-31');
  if lsum is distinct from m.inv_taxable - m.cn_taxable + m.dn_taxable then
    raise exception 'FAIL H3: Oct lines % <> Oct total %', lsum, m.inv_taxable - m.cn_taxable + m.dn_taxable;
  end if;
end $$;

-- ── I. Line period rules ───────────────────────────────────────────────────────────────
do $$
declare r record;
begin
  select * into r from public.revenue_line_service_period('2026-10-07', '{"name":"X (pro-rata from 2026-13-01 to 2027-01-01)","commitment":"annual_yearly"}', false, false, false, false, 12, 'yearly', null);
  if r.basis <> 'invoice_month' or r.months <> 1 then raise exception 'FAIL I1: broken date range = %', r; end if;
  select * into r from public.revenue_line_service_period('2026-10-07', '{"name":"Plan","commitment":"monthly"}', false, false, false, false, 12, 'monthly', null);
  if r.months <> 1 or r.service_from <> '2026-10-01' then raise exception 'FAIL I2: flex monthly = %', r; end if;
  select * into r from public.revenue_line_service_period('2026-10-07', '{"name":"Plan","commitment":"annual_yearly"}', false, false, false, false, 12, 'half_yearly', null);
  if r.months <> 6 then raise exception 'FAIL I3: half-yearly cycle = %', r; end if;
  select * into r from public.revenue_line_service_period('2026-10-07', '{"name":"Plan","commitment":"annual_yearly"}', false, true, false, false, 12, 'yearly', null);
  if r.basis <> 'invoice_month' then raise exception 'FAIL I4: undated add-seats = %', r; end if;
  select * into r from public.revenue_line_service_period('2026-10-07', '{"name":"Setup","commitment":"annual_yearly","one_time":true}', false, false, false, false, 12, 'yearly', null);
  if r.basis <> 'invoice_month' then raise exception 'FAIL I5: one_time marker = %', r; end if;
  select * into r from public.revenue_line_service_period('2026-10-07', '{"name":"Plan","commitment":"annual_yearly","start_date":"2031-01-01"}', false, false, false, false, 12, 'yearly', null);
  if r.service_from <> '2026-10-01' then raise exception 'FAIL I6: start_date 4 years away must fall back to the invoice = %', r; end if;
  -- billing parts: end = next part's start, clamped on short months; or written inclusive
  if public.revenue_part_months('2027-01-31', '2027-02-28') <> 1
     or public.revenue_part_months('2027-01-31', '2027-04-30') <> 3
     or public.revenue_part_months('2026-10-29', '2027-01-29') <> 3
     or public.revenue_part_months('2026-10-01', '2026-12-31') <> 3
     or public.revenue_part_months('2026-09-19', '2027-03-19') <> 6
     or public.revenue_part_months('2026-10-15', '2027-01-14') <> 3
     or public.revenue_part_months('2026-10-10', '2026-10-01') is not null then
    raise exception 'FAIL I7: revenue_part_months rules';
  end if;
end $$;

-- ── K. Review fixes: one-time line, start_date, renewal term date, late invoice, ₹0 rows ──
do $$
declare per text; n int;
begin
  select string_agg(coalesce((select sum(l.amount) from public.report_pnl_revenue_matched_lines(m, (m + interval '1 month' - interval '1 day')::date) l where l.doc_id = 'R2624-OT'), 0)::text, ',' order by m)
    into per from unnest(array['2026-11-01','2026-12-01']::date[]) m;
  if per is distinct from '700,100' then raise exception 'FAIL K1: OT Nov/Dec = % (want 700,100: the one_time setup stays in Nov)', per; end if;
  select string_agg(coalesce((select sum(l.amount) from public.report_pnl_revenue_matched_lines(m, (m + interval '1 month' - interval '1 day')::date) l where l.doc_id = 'R2624-SD'), 0)::text, ',' order by m)
    into per from unnest(array['2026-11-01','2027-01-01','2027-12-01','2028-01-01']::date[]) m;
  if per is distinct from '0,100,100,0' then raise exception 'FAIL K2: SD Nov/Jan/Dec27/Jan28 = % (want 0,100,100,0: from the line start_date)', per; end if;
  select string_agg(coalesce((select sum(l.amount) from public.report_pnl_revenue_matched_lines(m, (m + interval '1 month' - interval '1 day')::date) l where l.doc_id = 'R2624-RN2'), 0)::text, ',' order by m)
    into per from unnest(array['2026-11-01','2027-10-01','2027-11-01']::date[]) m;
  if per is distinct from '100,100,0' then raise exception 'FAIL K3: RN2 Nov/Oct27/Nov27 = % (want 100,100,0: the term after 26 Nov)', per; end if;
  select string_agg(coalesce((select sum(l.amount) from public.report_pnl_revenue_matched_lines(m, (m + interval '1 month' - interval '1 day')::date) l where l.doc_id = 'R2624-LATE'), 0)::text, ',' order by m)
    into per from unnest(array['2026-09-01','2026-10-01','2026-11-01']::date[]) m;
  if per is distinct from '100,100,0' then raise exception 'FAIL K4: LATE Sep/Oct/Nov = % (want 100,100,0: dated 5 Nov, for Sep..Oct)', per; end if;
  select count(*) into n from public.report_pnl_revenue_matched_lines('2026-11-01', '2026-11-30') l where l.doc_id = 'R2624-TEN';
  if n <> 0 then raise exception 'FAIL K5: a ₹0 month is a drill row'; end if;
  select count(*) into n from public.report_pnl_revenue_matched_lines('2027-10-01', '2027-10-31') l where l.doc_id = 'R2624-TEN' and l.amount = 10;
  if n <> 1 then raise exception 'FAIL K6: TEN last month is not ₹10'; end if;
end $$;

-- ── L. Checker BLOCK: a one_time_of setup line on a first billing part stays in its month ──
do $$
declare per text;
begin
  select string_agg(coalesce((select sum(l.amount) from public.report_pnl_revenue_matched_lines(m, (m + interval '1 month' - interval '1 day')::date) l where l.doc_id = 'R2624-PT1'), 0)::text, ',' order by m)
    into per from unnest(array['2026-10-01','2026-11-01','2026-12-01','2027-01-01']::date[]) m;
  if per is distinct from '2000,1000,1000,0' then
    raise exception 'FAIL L1: PT1 Oct/Nov/Dec/Jan = % (want 2000,1000,1000,0: ₹1,000 setup in Oct, ₹3,000 part over Oct..Dec)', per;
  end if;
end $$;

-- ── M. The FY trend in one call = each month on its own ────────────────────────────────
do $$
declare diff text;
begin
  -- EVERY month of the year, both ways (a month missing on either side is a difference too)
  select string_agg(to_char(g.mon, 'YYYY-MM'), ',') into diff
    from generate_series(date '2026-04-01', date '2027-03-01', interval '1 month') g(mon)
    cross join lateral public.report_pnl_revenue_matched(g.mon::date, (g.mon + interval '1 month' - interval '1 day')::date) one
    left join public.report_pnl_revenue_matched_months('2026-04-01', '2027-03-31') m on m.month = g.mon::date
   where (coalesce(m.inv_taxable, 0), coalesce(m.cn_taxable, 0), coalesce(m.dn_taxable, 0), coalesce(m.revenue_count, 0))
         is distinct from (one.inv_taxable, one.cn_taxable, one.dn_taxable, one.revenue_count)
      or (m.month is not null and m.by_product is distinct from one.by_product);
  if diff is not null then raise exception 'FAIL M1: months call differs from the one-month call in %', diff; end if;
  -- a month with no revenue has no row (the app reads it as ₹0); Jun 2026..Mar 2027 all have some
  if (select count(*) from public.report_pnl_revenue_matched_months('2026-04-01', '2027-03-31')) <> 10 then
    raise exception 'FAIL M2: months call returned % months (want 10)', (select count(*) from public.report_pnl_revenue_matched_months('2026-04-01', '2027-03-31'));
  end if;
end $$;

-- ── O. Re-check BLOCK: a billing-part invoice with NO lines follows its part in every month ──
do $$
declare per text;
begin
  select string_agg(coalesce((select sum(l.amount) from public.report_pnl_revenue_matched_lines(m, (m + interval '1 month' - interval '1 day')::date) l where l.doc_id = 'R2624-NOL'), 0)::text, ',' order by m)
    into per from unnest(array['2026-06-01','2026-07-01','2026-08-01','2026-09-01']::date[]) m;
  if per is distinct from '1000,1000,1000,0' then
    raise exception 'FAIL O1: NOL Jun/Jul/Aug/Sep one-month calls = % (want 1000,1000,1000,0: the part 1 Jun..1 Sep)', per;
  end if;
end $$;

-- ── N. A custom range that cuts a month: a one-month sale counts whole on its own date ──
do $$
declare v bigint;
begin
  select coalesce(sum(l.amount), 0) into v from public.report_pnl_revenue_matched_lines('2026-10-01', '2026-10-10') l where l.doc_id = 'R2624-ONE';
  if v <> 0 then raise exception 'FAIL N1: ONE (dated 12 Oct) counted in 1-10 Oct (%)', v; end if;
  select coalesce(sum(l.amount), 0) into v from public.report_pnl_revenue_matched_lines('2026-10-11', '2026-10-20') l where l.doc_id = 'R2624-ONE';
  if v <> 500 then raise exception 'FAIL N2: ONE in 11-20 Oct = % (want the whole 500)', v; end if;
end $$;

-- ── J. Tenant isolation; no company refused ────────────────────────────────────────────
do $$
begin
  if exists (select 1 from public.report_pnl_revenue_matched_lines('2026-01-01', '2030-12-31') l where l.doc_id = 'R2624-B') then
    raise exception 'FAIL J1: tenant B invoice visible';
  end if;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', 'd2624000-0000-0000-0000-0000000000c2', 'role', 'authenticated')::text, true);
do $$
begin
  perform * from public.report_pnl_revenue_matched('2026-10-01', '2026-10-31');
  raise exception 'FAIL J2: no company was not refused';
exception when insufficient_privilege then null;
end $$;

rollback;
