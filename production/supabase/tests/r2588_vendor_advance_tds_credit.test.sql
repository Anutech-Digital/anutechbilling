-- R-2588 (8 Nov 2026, p0 — R-1916 slice 2): applying a vendor advance that carries TDS to the
-- bill credits the TDS already deducted — the bill is paid, no second TDS, nothing stuck in prepaid.
-- Migrations: 20261108034643_r1916_vendor_advance_tds + 20261108053501_r2588_vendor_advance_tds_credit.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Owner's path (card doneWhen): ₹90,000 bank line → advance with TDS ₹10,000 194J (advance
-- ₹1,00,000). The ₹1,00,000 bill comes, recorded on Expenses WITH TDS ₹10,000 → Apply advance:
--   A. bill Paid (payment_method advance), prepaid left ₹0, Balance Sheet TDS payable ₹10,000
--      (not ₹20,000), payables ₹0; the TDS rows for the vendor (26Q) = ONE (the advance's).
--   B. Undo the advance → bill back to TDS ₹10,000 and ₹90,000 due; advance ₹1,00,000 left again.
--   C. Part apply (₹50,000 of the advance) → TDS credit pro-rata ₹5,000: bill TDS ₹5,000,
--      still due ₹45,000 (= ₹1,00,000 − ₹5,000 TDS − ₹50,000); the rest applies and settles it.
--   D. A bill recorded WITHOUT TDS (the old safe path) still settles in full, no credit.
--   E. A plain advance (no TDS) on a bill with TDS works as before (₹90,000 settles it, ₹10,000 left).

begin;

create function pg_temp.r2588_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2588_supplier before insert on public.tenants for each row execute function pg_temp.r2588_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000258801','R2588 Co','r2588@example.in','07','R2588');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000258801','owner2588@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000258801','dddddddd-0000-0000-0000-000000258801','owner2588@example.in','Owner 2588','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000258801','dddddddd-0000-0000-0000-000000258801','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000258801','dddddddd-0000-0000-0000-000000258801','Sharma Design Studio','ABCPS2588K','Professional Fees'),
  ('eeeeeeee-0000-0000-0000-000000258802','dddddddd-0000-0000-0000-000000258801','Gupta Consultants','ABCPG2588K','Professional Fees'),
  ('eeeeeeee-0000-0000-0000-000000258803','dddddddd-0000-0000-0000-000000258801','Rana Architects','ABCPR2588K','Professional Fees');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000258801','dddddddd-0000-0000-0000-000000258801','bbbbbbbb-0000-0000-0000-000000258801','2026-10-05','NEFT SHARMA DESIGN ADV',90000,0,'S1','csv_upload'),
  ('11111111-0000-0000-0000-000000258802','dddddddd-0000-0000-0000-000000258801','bbbbbbbb-0000-0000-0000-000000258801','2026-10-05','NEFT GUPTA ADV',90000,0,'G1','csv_upload'),
  ('11111111-0000-0000-0000-000000258803','dddddddd-0000-0000-0000-000000258801','bbbbbbbb-0000-0000-0000-000000258801','2026-10-05','NEFT RANA ADV',90000,0,'R1','csv_upload');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000258801","role":"authenticated"}', true);

-- Sharma: ₹90,000 paid + ₹10,000 194J withheld = advance ₹1,00,000 (R-1916).
select public.reconcile_bank_debit_to_vendor(
  p_txn_id => '11111111-0000-0000-0000-000000258801', p_vendor_id => 'eeeeeeee-0000-0000-0000-000000258801',
  p_new_vendor => null, p_items => '[]'::jsonb, p_new_bill => null,
  p_advance => 90000, p_advance_category => null, p_bank_charge => 0, p_note => null,
  p_advance_tds => 10000, p_advance_tds_section => '194J', p_advance_tds_override_reason => null);
-- Sharma's ₹1,00,000 bill, recorded WITH TDS ₹10,000 (194J), unpaid.
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method, tds_amount, tds_section) values
  ('EXP-R2588-S1','dddddddd-0000-0000-0000-000000258801','Professional Fees','Sharma Design Studio','eeeeeeee-0000-0000-0000-000000258801','2026-10-20',100000,0,'none','SD-1',false,null,10000,'194J');

-- ── A. Apply advance → paid, prepaid 0, TDS payable ₹10,000 (not ₹20,000), one TDS row ──────
do $$
declare r jsonb; e public.expenses; v_tds bigint; v_pre bigint; v_pay bigint; v_left int; n int;
begin
  r := public.apply_vendor_advance('expense', 'EXP-R2588-S1', null, '2026-10-21');
  select * into e from public.expenses where id = 'EXP-R2588-S1';
  if not e.paid or e.payment_method is distinct from 'advance' or e.advance_applied <> 100000 or e.tds_amount <> 0 then
    raise exception 'A FAIL: bill paid=% method=% applied=% tds=% (want paid, advance, 100000, 0 — the TDS is on the advance) — result %',
      e.paid, e.payment_method, e.advance_applied, e.tds_amount, r;
  end if;
  if (r->>'applied')::int <> 100000 or (r->>'still_due')::int <> 0 or not (r->>'settled')::boolean or (r->>'tds_credit')::int <> 10000 then
    raise exception 'A FAIL: apply_vendor_advance returned %', r;
  end if;
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000258801';
  if v_left <> 0 then raise exception 'A FAIL: ₹% stuck in prepaid (want 0)', v_left; end if;
  select dues_vendor_tds, prepaid_advances, expenses_payable into v_tds, v_pre, v_pay from public.report_balance_sheet('2026-10-31');
  if v_tds <> 10000 or v_pre <> 0 or v_pay <> 0 then
    raise exception 'A FAIL: Balance Sheet TDS payable % prepaid % expenses payable % (want 10000 / 0 / 0)', v_tds, v_pre, v_pay;
  end if;
  select (select count(*) from public.expenses where vendor_id = 'eeeeeeee-0000-0000-0000-000000258801' and tds_amount > 0)
       + (select count(*) from public.bank_vendor_payment_lines l join public.prepaid_advances pa on pa.id = l.prepaid_advance_id
           where pa.vendor_id = 'eeeeeeee-0000-0000-0000-000000258801' and l.tds_amount > 0) into n;
  if n <> 1 then raise exception 'A FAIL: % TDS rows for Sharma (26Q) — want 1', n; end if;
  select tds_credit into n from public.vendor_advance_applications where expense_id = 'EXP-R2588-S1';
  if n <> 10000 then raise exception 'A FAIL: application row tds_credit % (want 10000)', n; end if;
  raise notice 'A ok: bill paid from the advance, TDS ₹10,000 once, prepaid ₹0';
end $$;

-- ── B. Undo → the bill gets its own TDS back ─
-- (open items amount_due is before TDS — "cash due = amount_due − tds_amount", R-1913)───────────────────────────────────────────────
do $$
declare r jsonb; e public.expenses; v_left int; v_due int; v_tds bigint;
begin
  r := public.undo_vendor_advance('EXP-R2588-S1');
  select * into e from public.expenses where id = 'EXP-R2588-S1';
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000258801';
  select amount_due into v_due from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000258801') where doc_id = 'EXP-R2588-S1';
  if e.paid or e.tds_amount <> 10000 or e.advance_applied <> 0 or v_left <> 100000 or v_due <> 100000 or (r->>'still_due')::int <> 90000 then
    raise exception 'B FAIL: paid % tds % applied % advance left % due % result %', e.paid, e.tds_amount, e.advance_applied, v_left, v_due, r;
  end if;
  select dues_vendor_tds into v_tds from public.report_balance_sheet('2026-10-31');
  if v_tds <> 20000 then raise exception 'B FAIL: after undo TDS payable % (want 20000 — bill TDS back + advance TDS)', v_tds; end if;
  raise notice 'B ok: undo puts the bill''s TDS ₹10,000 back, ₹90,000 due';
end $$;

-- ── C. Part apply → pro-rata credit; the rest settles it ────────────────────────────────────
do $$
declare r jsonb; e public.expenses; v_left int; msg text;
begin
  begin
    perform public.apply_vendor_advance('expense', 'EXP-R2588-S1', 100001, '2026-10-21');
    raise exception 'C FAIL: applying more than the advance was accepted';
  exception when others then msg := sqlerrm; end;
  if msg like 'C FAIL%' then raise exception '%', msg; end if;
  r := public.apply_vendor_advance('expense', 'EXP-R2588-S1', 50000, '2026-10-21');
  select * into e from public.expenses where id = 'EXP-R2588-S1';
  if e.paid or e.tds_amount <> 5000 or e.advance_applied <> 50000 or (r->>'still_due')::int <> 45000 or (r->>'tds_credit')::int <> 5000 then
    raise exception 'C FAIL: part apply paid % tds % applied % result %', e.paid, e.tds_amount, e.advance_applied, r;
  end if;
  r := public.apply_vendor_advance('expense', 'EXP-R2588-S1', null, '2026-10-22');
  select * into e from public.expenses where id = 'EXP-R2588-S1';
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000258801';
  if not e.paid or e.tds_amount <> 0 or e.advance_applied <> 100000 or v_left <> 0 then
    raise exception 'C FAIL: rest apply paid % tds % applied % left % result %', e.paid, e.tds_amount, e.advance_applied, v_left, r;
  end if;
  r := public.undo_vendor_advance('EXP-R2588-S1');
  select * into e from public.expenses where id = 'EXP-R2588-S1';
  if e.tds_amount <> 10000 or e.advance_applied <> 0 then raise exception 'C FAIL: undo of two parts tds % applied %', e.tds_amount, e.advance_applied; end if;
  raise notice 'C ok: ₹50,000 part credits ₹5,000 TDS; the rest settles; undo restores ₹10,000';
end $$;

-- ── D. Bill recorded WITHOUT TDS (old safe path) still settles in full ──────────────────────
select public.reconcile_bank_debit_to_vendor(
  p_txn_id => '11111111-0000-0000-0000-000000258802', p_vendor_id => 'eeeeeeee-0000-0000-0000-000000258802',
  p_new_vendor => null, p_items => '[]'::jsonb, p_new_bill => null,
  p_advance => 90000, p_advance_category => null, p_bank_charge => 0, p_note => null,
  p_advance_tds => 10000, p_advance_tds_section => '194J', p_advance_tds_override_reason => null);
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R2588-G1','dddddddd-0000-0000-0000-000000258801','Professional Fees','Gupta Consultants','eeeeeeee-0000-0000-0000-000000258802','2026-10-20',100000,0,'none','GC-1',false,null);
do $$
declare r jsonb; e public.expenses;
begin
  r := public.apply_vendor_advance('expense', 'EXP-R2588-G1', null, '2026-10-21');
  select * into e from public.expenses where id = 'EXP-R2588-G1';
  if not e.paid or e.tds_amount <> 0 or e.advance_applied <> 100000 or coalesce((r->>'tds_credit')::int, 0) <> 0 then
    raise exception 'D FAIL: paid % tds % applied % result %', e.paid, e.tds_amount, e.advance_applied, r;
  end if;
  raise notice 'D ok: bill without TDS settles from the ₹1,00,000 advance, no credit';
end $$;

-- ── E. Plain advance (no TDS) on a bill with TDS — unchanged ────────────────────────────────
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000258803','eeeeeeee-0000-0000-0000-000000258803', null, '[]'::jsonb, null, 90000, null);
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method, tds_amount, tds_section) values
  ('EXP-R2588-R1','dddddddd-0000-0000-0000-000000258801','Professional Fees','Rana Architects','eeeeeeee-0000-0000-0000-000000258803','2026-10-20',100000,0,'none','RA-1',false,null,10000,'194J');
do $$
declare r jsonb; e public.expenses; v_left int;
begin
  r := public.apply_vendor_advance('expense', 'EXP-R2588-R1', null, '2026-10-21');
  select * into e from public.expenses where id = 'EXP-R2588-R1';
  select sum(total_amount - consumed_amount) into v_left from public.prepaid_advances where vendor_id = 'eeeeeeee-0000-0000-0000-000000258803';
  if not e.paid or e.tds_amount <> 10000 or e.advance_applied <> 90000 or v_left <> 0 then
    raise exception 'E FAIL: paid % tds % applied % left % result %', e.paid, e.tds_amount, e.advance_applied, v_left, r;
  end if;
  raise notice 'E ok: plain ₹90,000 advance settles the bill net of its own TDS';
end $$;

-- ── F. A bill a bank part already paid (R-1915) — that part withheld the bill's TDS: no credit ─
select set_config('request.jwt.claims', '', true);
insert into public.vendors (id, tenant_id, name, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000258804','dddddddd-0000-0000-0000-000000258801','Kapoor Studio','ABCPK2588K','Professional Fees');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000258804','dddddddd-0000-0000-0000-000000258801','bbbbbbbb-0000-0000-0000-000000258801','2026-10-05','NEFT KAPOOR ADV',90000,0,'K1','csv_upload');
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method, tds_amount, tds_section, paid_amount) values
  ('EXP-R2588-K1','dddddddd-0000-0000-0000-000000258801','Professional Fees','Kapoor Studio','eeeeeeee-0000-0000-0000-000000258804','2026-10-20',100000,0,'none','KS-1',false,null,10000,'194J',20000);
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000258801","role":"authenticated"}', true);
select public.reconcile_bank_debit_to_vendor(
  p_txn_id => '11111111-0000-0000-0000-000000258804', p_vendor_id => 'eeeeeeee-0000-0000-0000-000000258804',
  p_new_vendor => null, p_items => '[]'::jsonb, p_new_bill => null,
  p_advance => 90000, p_advance_category => null, p_bank_charge => 0, p_note => null,
  p_advance_tds => 10000, p_advance_tds_section => '194J', p_advance_tds_override_reason => null);
do $$
declare r jsonb; e public.expenses;
begin
  r := public.apply_vendor_advance('expense', 'EXP-R2588-K1', null, '2026-10-21');
  select * into e from public.expenses where id = 'EXP-R2588-K1';
  if not e.paid or e.tds_amount <> 10000 or e.advance_applied <> 70000 or coalesce((r->>'tds_credit')::int, 0) <> 0 then
    raise exception 'F FAIL: paid % tds % applied % result %', e.paid, e.tds_amount, e.advance_applied, r;
  end if;
  raise notice 'F ok: after a bank part the bill keeps its TDS; ₹70,000 of the advance settles the rest';
end $$;

-- ── G. TDS month already deposited by challan (R-1920) ──────────────────────────────────────
--   G1: Sharma's bill credited (A's path again), then the October challan is paid → Undo refused
--       (it would put ₹10,000 back into a deposited month).
--   G2: a bill in a deposited month gets no credit (as before R-2588) — its TDS stays.
do $$
declare r jsonb; e public.expenses; msg text;
begin
  r := public.apply_vendor_advance('expense', 'EXP-R2588-S1', null, '2026-10-23');
  if (r->>'tds_credit')::int <> 10000 then raise exception 'G1 FAIL: credit before the challan %', r; end if;
  insert into public.statutory_dues_payments (tenant_id, kind, period, amount, paid_on, challan_no)
  values ('dddddddd-0000-0000-0000-000000258801', 'tds', '2026-10', 10000, '2026-11-07', 'CH2588');
  begin
    perform public.undo_vendor_advance('EXP-R2588-S1');
    raise exception 'G1 FAIL: undo accepted after the month was deposited';
  exception when others then msg := sqlerrm; end;
  if msg not like '%back into that deposited month%' then raise exception 'G1 FAIL: wrong refusal: %', msg; end if;
  raise notice 'G1 ok: undo refused — %', msg;
end $$;
select set_config('request.jwt.claims', '', true);
insert into public.vendors (id, tenant_id, name, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000258805','dddddddd-0000-0000-0000-000000258801','Mehra Studio','ABCPM2588K','Professional Fees');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000258805','dddddddd-0000-0000-0000-000000258801','bbbbbbbb-0000-0000-0000-000000258801','2026-10-05','NEFT MEHRA ADV',90000,0,'M1','csv_upload');
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method, tds_amount, tds_section) values
  ('EXP-R2588-M1','dddddddd-0000-0000-0000-000000258801','Professional Fees','Mehra Studio','eeeeeeee-0000-0000-0000-000000258805','2026-10-20',100000,0,'none','MS-1',false,null,10000,'194J');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000258801","role":"authenticated"}', true);
select public.reconcile_bank_debit_to_vendor(
  p_txn_id => '11111111-0000-0000-0000-000000258805', p_vendor_id => 'eeeeeeee-0000-0000-0000-000000258805',
  p_new_vendor => null, p_items => '[]'::jsonb, p_new_bill => null,
  p_advance => 90000, p_advance_category => null, p_bank_charge => 0, p_note => null,
  p_advance_tds => 10000, p_advance_tds_section => '194J', p_advance_tds_override_reason => null);
do $$
declare r jsonb; e public.expenses;
begin
  r := public.apply_vendor_advance('expense', 'EXP-R2588-M1', null, '2026-11-08');
  select * into e from public.expenses where id = 'EXP-R2588-M1';
  if not e.paid or e.tds_amount <> 10000 or e.advance_applied <> 90000 or coalesce((r->>'tds_credit')::int, 0) <> 0 then
    raise exception 'G2 FAIL: paid % tds % applied % result %', e.paid, e.tds_amount, e.advance_applied, r;
  end if;
  raise notice 'G2 ok: deposited month — no credit, the bill keeps its TDS';
end $$;

rollback;
