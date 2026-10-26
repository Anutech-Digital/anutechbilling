-- R-1921 (26 Oct 2026, goal G-RECON — R-1906 audit F4): the vendor statement and the payables
-- ageing agree with the bills' / expenses' "still due" (R-1952), the vendor popup's net and the
-- Balance Sheet, for the R-1906 audit's six cases — built with the real money RPCs.
-- Migration: 2026102*_r1921_vendor_statement_payables_ageing.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
--   1 one bill in full        Google Cloud: ₹11,800 COGS bill paid on the Bills page, the real HDFC
--                             line then MATCHED to that payment (R-1911)            → closing 0
--   2 two bills, one transfer Gupta Printers: ₹5,000 + ₹7,000 by one ₹12,000 line; a ₹2,000 bill
--                             marked paid in cash                                   → closing 0
--   3 part payment            Sharma: ₹59,000 bill, ₹25,000 part from the bank (R-1915) → 34,000
--   4 net of TDS              Kapoor CA: ₹10,000 bill paid ₹9,000 + ₹1,000 TDS 194J → 0; a second
--                             ₹20,000 bill with ₹2,000 TDS on it, not yet due      → 18,000
--   5 advance, bill later     Verma: ₹30,000 advance, ₹50,000 bill later, advance set off (R-1913)
--                             + a fresh ₹4,000 advance                              → 20,000 − 4,000
--                             AWS (COGS): ₹10,000 advance set off on an ₹11,800 COGS bill (R-1914) → 1,800
--   6 vendor not created      Bansal Print: new vendor + bill typed on the bank line, paid → 0
-- Checks: each statement's rows add to the expected closing with NO 'adjustment' row (every rupee
-- explained); closing = the popup's net (bills due − advance left); Σ closings = Balance Sheet
-- payables + expenses payable − prepaid advances; the ageing buckets add to each vendor's total,
-- the totals to the Balance Sheet payables, net = the statement closing.

begin;

create function pg_temp.r1921_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1921_supplier before insert on public.tenants for each row execute function pg_temp.r1921_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000192101','R1921 Co','r1921@example.in','07','R1921');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000192101','owner1921@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000192101','dddddddd-0000-0000-0000-000000192101','owner1921@example.in','Owner 1921','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000192101','dddddddd-0000-0000-0000-000000192101','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000192101','dddddddd-0000-0000-0000-000000192101','Google Cloud India','29AACCG1921B1Z9','AACCG1921B','COGS-Workspace'),
  ('eeeeeeee-0000-0000-0000-000000192102','dddddddd-0000-0000-0000-000000192101','Gupta Printers','07AAKFG1921A1Z5','AAKFG1921A','Printing & Stationery'),
  ('eeeeeeee-0000-0000-0000-000000192103','dddddddd-0000-0000-0000-000000192101','Sharma Associates','07AAKFS1921A1Z5','AAKFS1921A','Professional Services'),
  ('eeeeeeee-0000-0000-0000-000000192104','dddddddd-0000-0000-0000-000000192101','Kapoor CA','07AAKFK1921A1Z5','AAKFK1921A','Professional Services'),
  ('eeeeeeee-0000-0000-0000-000000192105','dddddddd-0000-0000-0000-000000192101','Verma Contractors','07AAKFV1921A1Z5','AAKFV1921A','Repairs & Maintenance'),
  ('eeeeeeee-0000-0000-0000-000000192106','dddddddd-0000-0000-0000-000000192101','Amazon Web Services India','29AACCA1921B1Z9','AACCA1921B','COGS-Other');

-- Dates follow today, so the ageing buckets are fixed whatever day the test runs.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000192101','dddddddd-0000-0000-0000-000000192101','bbbbbbbb-0000-0000-0000-000000192101',public.ist_today() - 19,'NEFT GOOGLE CLOUD INDIA G-1',11800,0,'R1','csv_upload'),
  ('11111111-0000-0000-0000-000000192102','dddddddd-0000-0000-0000-000000192101','bbbbbbbb-0000-0000-0000-000000192101',public.ist_today() - 10,'IMPS GUPTA PRINTERS GP1 GP2',12000,0,'R2','csv_upload'),
  ('11111111-0000-0000-0000-000000192103','dddddddd-0000-0000-0000-000000192101','bbbbbbbb-0000-0000-0000-000000192101',public.ist_today() - 30,'NEFT SHARMA ASSOCIATES PART',25000,0,'R3','csv_upload'),
  ('11111111-0000-0000-0000-000000192104','dddddddd-0000-0000-0000-000000192101','bbbbbbbb-0000-0000-0000-000000192101',public.ist_today() - 8,'IMPS KAPOOR CA KC1 NET TDS',9000,0,'R4','csv_upload'),
  ('11111111-0000-0000-0000-000000192105','dddddddd-0000-0000-0000-000000192101','bbbbbbbb-0000-0000-0000-000000192101',public.ist_today() - 60,'NEFT VERMA CONTRACTORS ADV',30000,0,'R5','csv_upload'),
  ('11111111-0000-0000-0000-000000192106','dddddddd-0000-0000-0000-000000192101','bbbbbbbb-0000-0000-0000-000000192101',public.ist_today() - 3,'NEFT VERMA CONTRACTORS ADV 2',4000,0,'R6','csv_upload'),
  ('11111111-0000-0000-0000-000000192107','dddddddd-0000-0000-0000-000000192101','bbbbbbbb-0000-0000-0000-000000192101',public.ist_today() - 100,'NEFT AMAZON WEB SERVICES ADV',10000,0,'R7','csv_upload'),
  ('11111111-0000-0000-0000-000000192108','dddddddd-0000-0000-0000-000000192101','bbbbbbbb-0000-0000-0000-000000192101',public.ist_today() - 2,'UPI-BANSAL PRINT HOUSE-bansal@okicici',7080,0,'R8','csv_upload');

insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category,
                                 subtotal, igst, total, status, paid_amount) values
  ('BILL-R1921-G1','dddddddd-0000-0000-0000-000000192101','eeeeeeee-0000-0000-0000-000000192101','Google Cloud India','29AACCG1921B1Z9',
   'G-1', public.ist_today() - 50, public.ist_today() - 35, 'COGS-Workspace', 10000, 1800, 11800, 'unpaid', 0),
  ('BILL-R1921-A1','dddddddd-0000-0000-0000-000000192101','eeeeeeee-0000-0000-0000-000000192106','Amazon Web Services India','29AACCA1921B1Z9',
   'A-1', public.ist_today() - 95, public.ist_today() - 95, 'COGS-Other', 10000, 1800, 11800, 'unpaid', 0);

insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, due_date, amount, gst_paid, bill_type, bill_no,
                             paid, paid_date, payment_method, tds_section, tds_amount) values
  ('EXP-R1921-GP1','dddddddd-0000-0000-0000-000000192101','Printing & Stationery','Gupta Printers','eeeeeeee-0000-0000-0000-000000192102',
   public.ist_today() - 40, null, 5000, 0, 'none', 'GP-1', false, null, null, null, 0),
  ('EXP-R1921-GP2','dddddddd-0000-0000-0000-000000192101','Printing & Stationery','Gupta Printers','eeeeeeee-0000-0000-0000-000000192102',
   public.ist_today() - 40, null, 7000, 0, 'none', 'GP-2', false, null, null, null, 0),
  ('EXP-R1921-GP3','dddddddd-0000-0000-0000-000000192101','Printing & Stationery','Gupta Printers','eeeeeeee-0000-0000-0000-000000192102',
   public.ist_today() - 6, null, 2000, 0, 'none', 'GP-3', true, public.ist_today() - 5, 'cash', null, 0),
  ('EXP-R1921-PS1','dddddddd-0000-0000-0000-000000192101','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000192103',
   public.ist_today() - 70, public.ist_today() - 45, 59000, 9000, 'gst', 'PS-1', false, null, null, null, 0),
  ('EXP-R1921-KC1','dddddddd-0000-0000-0000-000000192101','Professional Services','Kapoor CA','eeeeeeee-0000-0000-0000-000000192104',
   public.ist_today() - 20, null, 10000, 0, 'none', 'KC-1', false, null, null, null, 0),
  ('EXP-R1921-KC2','dddddddd-0000-0000-0000-000000192101','Professional Services','Kapoor CA','eeeeeeee-0000-0000-0000-000000192104',
   public.ist_today() - 5, public.ist_today() + 10, 20000, 0, 'none', 'KC-2', false, null, null, '194J', 2000),
  ('EXP-R1921-VC1','dddddddd-0000-0000-0000-000000192101','Repairs & Maintenance','Verma Contractors','eeeeeeee-0000-0000-0000-000000192105',
   public.ist_today() - 20, public.ist_today() - 5, 50000, 0, 'none', 'VC-1', false, null, null, null, 0);

-- Owner 1921 signs in.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000192101","role":"authenticated"}', true);

-- Case 1: Bills page → Pay ₹11,800 (manual line), then the real line is matched to it.
select public.pay_vendor_bill('BILL-R1921-G1', 11800, public.ist_today() - 20, 'bbbbbbbb-0000-0000-0000-000000192101', 'NEFT');
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192101','eeeeeeee-0000-0000-0000-000000192101', null,
  jsonb_build_array(jsonb_build_object('source','recorded_payment','amount',11800,'doc_id',
    (select t.id::text from public.bank_transactions t where t.matched_to_type = 'vendor_bill' and t.matched_to_id = 'BILL-R1921-G1' and t.source = 'manual'))));
-- Case 2: one line pays two bills.
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192102','eeeeeeee-0000-0000-0000-000000192102', null,
  '[{"source":"expense","doc_id":"EXP-R1921-GP1","amount":5000,"tds_amount":0},{"source":"expense","doc_id":"EXP-R1921-GP2","amount":7000,"tds_amount":0}]'::jsonb);
-- Case 3: a ₹25,000 part of the ₹59,000 bill.
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192103','eeeeeeee-0000-0000-0000-000000192103', null,
  '[{"source":"expense","doc_id":"EXP-R1921-PS1","amount":25000,"tds_amount":0}]'::jsonb);
-- Case 4: ₹9,000 cash + ₹1,000 TDS 194J settles the ₹10,000 bill.
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192104','eeeeeeee-0000-0000-0000-000000192104', null,
  '[{"source":"expense","doc_id":"EXP-R1921-KC1","amount":10000,"tds_amount":1000,"tds_section":"194J"}]'::jsonb);
-- Case 5: ₹30,000 advance; the ₹50,000 bill takes it; a fresh ₹4,000 advance. AWS: COGS advance on a COGS bill.
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192105','eeeeeeee-0000-0000-0000-000000192105', null, '[]'::jsonb, null, 30000, 'Repairs & Maintenance');
select public.apply_vendor_advance('expense', 'EXP-R1921-VC1', null, public.ist_today() - 15);
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192106','eeeeeeee-0000-0000-0000-000000192105', null, '[]'::jsonb, null, 4000, 'Repairs & Maintenance');
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192107','eeeeeeee-0000-0000-0000-000000192106', null, '[]'::jsonb, null, 10000, null);
select public.apply_vendor_advance('vendor_bill', 'BILL-R1921-A1', null, public.ist_today() - 90);
-- Case 6: a new vendor and its bill typed on the bank line, paid in full.
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192108', null,
  '{"name":"Bansal Print House","upi_id":"bansal@okicici"}'::jsonb, '[]'::jsonb,
  '{"kind":"expense","bill_no":"BP-1","bill_date":"2026-10-20","category":"Printing & Stationery","taxable":6000,"gst":1080,"itc":true}'::jsonb);

-- Setup sanity: the RPCs did what the cases say.
do $$
declare b public.vendor_bills; e public.expenses;
begin
  select * into b from public.vendor_bills where id = 'BILL-R1921-G1';
  if b.paid_amount <> 11800 or b.status <> 'paid' then raise exception 'setup FAIL G-1: paid % status %', b.paid_amount, b.status; end if;
  if exists (select 1 from public.bank_transactions where matched_to_id = 'BILL-R1921-G1' and source = 'manual') then
    raise exception 'setup FAIL G-1: the Bills-page line was not replaced by the real line'; end if;
  select * into e from public.expenses where id = 'EXP-R1921-PS1';
  if e.paid or e.paid_amount <> 25000 then raise exception 'setup FAIL PS-1: paid % paid_amount %', e.paid, e.paid_amount; end if;
  select * into e from public.expenses where id = 'EXP-R1921-KC1';
  if not e.paid or e.tds_amount <> 1000 then raise exception 'setup FAIL KC-1: paid % tds %', e.paid, e.tds_amount; end if;
  select * into e from public.expenses where id = 'EXP-R1921-VC1';
  if e.paid or e.advance_applied <> 30000 then raise exception 'setup FAIL VC-1: paid % advance %', e.paid, e.advance_applied; end if;
  select * into b from public.vendor_bills where id = 'BILL-R1921-A1';
  if b.paid_amount <> 10000 or b.advance_applied <> 10000 then raise exception 'setup FAIL A-1: paid % advance %', b.paid_amount, b.advance_applied; end if;
  if not exists (select 1 from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000192101' and name = 'Bansal Print House') then
    raise exception 'setup FAIL case 6: Bansal Print House not created'; end if;
end $$;

-- ── S. Each statement: rows add to the expected closing, every rupee explained ────────────────
create temp table r1921_expect (vendor text, closing bigint) on commit drop;
insert into r1921_expect values
  ('Google Cloud India', 0), ('Gupta Printers', 0), ('Sharma Associates', 34000), ('Kapoor CA', 18000),
  ('Verma Contractors', 16000), ('Amazon Web Services India', 1800), ('Bansal Print House', 0);

do $$
declare x record; v_id uuid; v_sum bigint; v_adj int;
begin
  for x in select * from r1921_expect loop
    select id into v_id from public.vendors where tenant_id = 'dddddddd-0000-0000-0000-000000192101' and name = x.vendor;
    select coalesce(sum(s.amount), 0), count(*) filter (where s.kind = 'adjustment')
      into v_sum, v_adj from public.vendor_statement(v_id) s;
    if v_sum <> x.closing then raise exception 'S FAIL %: statement closes at % (want %)', x.vendor, v_sum, x.closing; end if;
    if v_adj <> 0 then raise exception 'S FAIL %: % adjustment row(s) — an entry is missing from the statement', x.vendor, v_adj; end if;
  end loop;
  raise notice 'S ok: 7 vendor statements close at 0 / 0 / 34,000 / 18,000 / 16,000 / 1,800 / 0, no adjustment rows';
end $$;

-- ── R. The rows the owner reads (bill, payment, TDS, advance on separate lines) ──────────────
do $$
declare n int;
begin
  -- Google: the bill, then ONE ₹11,800 payment (the matched line), not two.
  select count(*) into n from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192101') s where s.kind = 'payment';
  if n <> 1 then raise exception 'R FAIL Google: % payment rows (want 1 — the Bills-page pay and the real line are one payment)', n; end if;
  if not exists (select 1 from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192101') s
                  where s.kind = 'payment' and s.amount = -11800 and s.bank_txn_id = '11111111-0000-0000-0000-000000192101') then
    raise exception 'R FAIL Google: the payment row is not the real bank line'; end if;
  -- Gupta: one bank row for both bills + the cash Mark-paid bill.
  if not exists (select 1 from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192102') s
                  where s.kind = 'payment' and s.amount = -12000 and s.doc_ref = 'GP-1, GP-2') then
    raise exception 'R FAIL Gupta: no ₹12,000 bank row naming GP-1, GP-2'; end if;
  if not exists (select 1 from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192102') s
                  where s.kind = 'payment' and s.amount = -2000 and s.particulars like 'Paid (cash)%') then
    raise exception 'R FAIL Gupta: the cash-paid GP-3 is not on the statement'; end if;
  -- Kapoor: TDS ₹1,000 and cash ₹9,000 on separate lines; KC-2's TDS ₹2,000 on its bill date.
  if not exists (select 1 from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192104') s where s.kind = 'tds' and s.amount = -1000 and s.particulars like 'TDS 194J%')
     or not exists (select 1 from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192104') s where s.kind = 'payment' and s.amount = -9000)
     or not exists (select 1 from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192104') s where s.kind = 'tds' and s.amount = -2000 and s.entry_date = public.ist_today() - 5) then
    raise exception 'R FAIL Kapoor: TDS / payment rows missing'; end if;
  -- Verma: both advances out, the ₹30,000 set-off shown with no effect on the balance.
  select count(*) into n from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192105') s
   where (s.kind = 'advance' and s.amount in (-30000, -4000)) or (s.kind = 'set_off' and s.amount = 0 and s.set_off = 30000 and s.doc_ref = 'VC-1');
  if n <> 3 then raise exception 'R FAIL Verma: % of the 3 advance / set-off rows', n; end if;
  -- AWS: the COGS set-off (R-1914) is a set-off, not a payment.
  if exists (select 1 from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192106') s where s.kind = 'payment')
     or not exists (select 1 from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192106') s where s.kind = 'set_off' and s.set_off = 10000) then
    raise exception 'R FAIL AWS: the advance set-off shows as a payment / is missing'; end if;
  -- Dated, oldest first.
  if exists (select 1 from (select s.entry_date, lag(s.entry_date) over () as prev
                              from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192105') s) z where z.entry_date < z.prev) then
    raise exception 'R FAIL: statement rows are not oldest first'; end if;
  raise notice 'R ok: one payment per real bank line, TDS / advance / set-off on their own lines, oldest first';
end $$;

-- ── P. Statement closing = the vendor popup's net (open bills − advance left) ─────────────────
do $$
declare x record; v_popup bigint; v_stmt bigint;
begin
  for x in select v.id, v.name from public.vendors v where v.tenant_id = 'dddddddd-0000-0000-0000-000000192101' loop
    -- The popup's rule (lib/queries/vendors.ts rollupVendors + lib/accounting/vendor-account.ts).
    select coalesce((select sum(greatest(0, b.total - b.paid_amount)) from public.vendor_bills b where b.vendor_id = x.id), 0)
         + coalesce((select sum(e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0))
                       from public.expenses e
                      where e.vendor_id = x.id and e.paid = false and e.reconciled_txn_id is null and e.prepaid_advance_id is null
                        and e.category <> 'Salaries'
                        and coalesce(e.payment_method, '') not in ('payroll','statutory','reimbursement','emi','advance','employee_advance')
                        and e.amount - coalesce(e.tds_amount, 0) - coalesce(e.advance_applied, 0) - coalesce(e.paid_amount, 0) > 0), 0)
         - coalesce((select sum(greatest(0, a.total_amount - a.consumed_amount)) from public.prepaid_advances a
                      where a.closed_at is null and (a.vendor_id = x.id or (a.vendor_id is null and lower(trim(a.vendor_name)) = lower(trim(x.name))))), 0)
      into v_popup;
    select coalesce(sum(s.amount), 0) into v_stmt from public.vendor_statement(x.id) s;
    if v_stmt <> v_popup then raise exception 'P FAIL %: statement % but the popup says %', x.name, v_stmt, v_popup; end if;
  end loop;
  raise notice 'P ok: every statement closing = the popup''s net';
end $$;

-- ── G. Balance Sheet and ageing agree ─────────────────────────────────────────────────────────
do $$
declare v_pay bigint; v_exp bigint; v_pre bigint; v_stmt bigint := 0; x record; a record;
        v_tot bigint; v_adv bigint; v_net bigint;
begin
  select payables, expenses_payable, prepaid_advances into v_pay, v_exp, v_pre from public.report_balance_sheet();
  for x in select v.id from public.vendors v where v.tenant_id = 'dddddddd-0000-0000-0000-000000192101' loop
    v_stmt := v_stmt + (select coalesce(sum(s.amount), 0) from public.vendor_statement(x.id) s);
  end loop;
  if v_stmt <> v_pay + v_exp - v_pre then
    raise exception 'G FAIL: Σ statements % <> Balance Sheet payables % + expenses payable % − prepaid %', v_stmt, v_pay, v_exp, v_pre; end if;

  select sum(g.total), sum(g.advance), sum(g.net) into v_tot, v_adv, v_net from public.payables_ageing() g;
  if v_tot <> v_pay + v_exp or v_adv <> v_pre or v_net <> v_stmt then
    raise exception 'G FAIL: ageing total % (BS %), advance % (BS %), net % (statements %)', v_tot, v_pay + v_exp, v_adv, v_pre, v_net, v_stmt; end if;
  for a in select * from public.payables_ageing() loop
    if a.not_due + a.d1_30 + a.d31_60 + a.d61_90 + a.d90_plus <> a.total or a.total - a.advance <> a.net then
      raise exception 'G FAIL %: buckets % + % + % + % + % <> total %', a.vendor_name, a.not_due, a.d1_30, a.d31_60, a.d61_90, a.d90_plus, a.total; end if;
    if a.net <> (select coalesce(sum(s.amount), 0) from public.vendor_statement(a.vendor_id) s) then
      raise exception 'G FAIL %: ageing net % <> statement closing', a.vendor_name, a.net; end if;
  end loop;
  -- The right bucket: Sharma 45 days past due, Kapoor not due, Verma 5 days, AWS 95 days.
  if not exists (select 1 from public.payables_ageing() g where g.vendor_name = 'Sharma Associates' and g.d31_60 = 34000 and g.total = 34000)
     or not exists (select 1 from public.payables_ageing() g where g.vendor_name = 'Kapoor CA' and g.not_due = 18000 and g.total = 18000)
     or not exists (select 1 from public.payables_ageing() g where g.vendor_name = 'Verma Contractors' and g.d1_30 = 20000 and g.advance = 4000 and g.net = 16000)
     or not exists (select 1 from public.payables_ageing() g where g.vendor_name = 'Amazon Web Services India' and g.d90_plus = 1800 and g.oldest_days = 95) then
    raise exception 'G FAIL: a vendor is in the wrong bucket: %', (select jsonb_agg(to_jsonb(g)) from public.payables_ageing() g);
  end if;
  if exists (select 1 from public.payables_ageing() g where g.vendor_name in ('Google Cloud India', 'Gupta Printers', 'Bansal Print House')) then
    raise exception 'G FAIL: a settled vendor is on the ageing'; end if;
  raise notice 'G ok: Σ statements ₹% = BS payables ₹% + expenses payable ₹% − prepaid ₹%; ageing total ₹% in the right buckets', v_stmt, v_pay, v_exp, v_pre, v_tot;
end $$;

-- ── X. A payment the entries cannot explain (an old row changed by hand) → ONE adjustment row,
--       and the closing still equals the popup / Balance Sheet (never a second opinion).
update public.vendor_bills set paid_amount = paid_amount + 500 where id = 'BILL-R1921-A1';
do $$
declare v_sum bigint; v_adj bigint; n int;
begin
  select coalesce(sum(s.amount), 0), coalesce(sum(s.amount) filter (where s.kind = 'adjustment'), 0), count(*) filter (where s.kind = 'adjustment')
    into v_sum, v_adj, n from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192106') s;
  if v_sum <> 1300 or v_adj <> -500 or n <> 1 then
    raise exception 'X FAIL: AWS closes at % with % adjustment row(s) of % (want 1300, 1 row of -500)', v_sum, n, v_adj; end if;
  raise notice 'X ok: an unexplained ₹500 shows as one adjustment row; closing ₹1,300 = popup';
end $$;

-- ── A. As a signed-in app user (grants + row security), and with no company ───────────────────
set local role authenticated;
do $$
declare n int; msg text;
begin
  select count(*) into n from public.vendor_statement('eeeeeeee-0000-0000-0000-000000192103');
  if n <> 2 then raise exception 'A FAIL: the app user sees % statement rows for Sharma (want the bill + the part)', n; end if;
  select count(*) into n from public.payables_ageing();
  if n <> 4 then raise exception 'A FAIL: the app user sees % ageing rows (want 4)', n; end if;
  begin
    perform public.vendor_statement('eeeeeeee-0000-0000-0000-0000000000ff');
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') <> 'Vendor not found' then raise exception 'A FAIL: an unknown vendor said %', coalesce(msg, 'nothing'); end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
do $$
declare msg text;
begin
  begin
    perform public.payables_ageing();
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like 'No company context%' then raise exception 'A FAIL: no tenant said %', coalesce(msg, 'nothing'); end if;
  raise notice 'A ok: app user reads its own statement / ageing; no company → refused';
end $$;

rollback;
