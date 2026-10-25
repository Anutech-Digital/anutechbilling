-- R-1915 (25 Oct 2026, from the R-1906 audit B5): part payment of an expense (services) bill
-- from a bank line — rent / CA / contractor paid in parts.
-- Migration: 20261025*_r1915_expense_part_payment.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves (owner's path: Sharma Associates, ₹59,000 bill PS-1, ₹25,000 bank line):
--   A. B5 — the ₹25,000 line pays PART of the ₹59,000 bill: accepted, bill "partial" with
--      ₹25,000 paid, ₹34,000 due in open items (can_part) and the Balance Sheet expenses payable.
--   B. A second ₹34,000 line pays the rest → bill paid, linked to that line; nothing open.
--   C. Undo: the first part cannot be un-reconciled while the later one is on the bill; the later
--      one first → ₹34,000 due again; then the first → ₹59,000 due, paid_amount 0.
--   D. TDS is taken on the FIRST part (whole bill, liability arises at credit): ₹20,000 cash +
--      ₹5,000 TDS (194J) settles ₹25,000 → ₹34,000 due, no TDS left to take (tds_base 0); TDS on
--      the second part refused; TDS payable counts ₹5,000.
--   E. More than due refused; cutting the bill below what was paid refused.
--   F. With an applied advance: ₹50,000 bill, ₹30,000 advance applied, ₹5,000 part → ₹15,000 due;
--      the advance cannot be undone while a bank part is on the bill.
--   G. Mark paid after a part: the recorded payment waiting for its bank line is the REST
--      (₹34,000), not the whole bill; BS "paid, not banked" ₹34,000; un-reconciling the part
--      while the bill is marked paid is refused.

begin;

create function pg_temp.r1915_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1915_supplier before insert on public.tenants for each row execute function pg_temp.r1915_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000191501','R1915 Co','r1915@example.in','07','R1915');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000191501','owner1915@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000191501','dddddddd-0000-0000-0000-000000191501','owner1915@example.in','Owner 1915','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000191501','dddddddd-0000-0000-0000-000000191501','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000191501','dddddddd-0000-0000-0000-000000191501','Sharma Associates','07AAKFS1915A1Z5','AAKFS1915A','Professional Services'),
  ('eeeeeeee-0000-0000-0000-000000191502','dddddddd-0000-0000-0000-000000191501','Verma Contractors','07AAKFV1915A1Z5','AAKFV1915A','Repairs & Maintenance'),
  ('eeeeeeee-0000-0000-0000-000000191503','dddddddd-0000-0000-0000-000000191501','Kapoor CA','07AAKFK1915A1Z5','AAKFK1915A','Professional Services');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191501','dddddddd-0000-0000-0000-000000191501','bbbbbbbb-0000-0000-0000-000000191501','2026-10-05','UPI SHARMA ASSOCIATES PART',25000,0,'U1','csv_upload'),
  ('11111111-0000-0000-0000-000000191502','dddddddd-0000-0000-0000-000000191501','bbbbbbbb-0000-0000-0000-000000191501','2026-10-12','UPI SHARMA ASSOCIATES REST',34000,0,'U2','csv_upload'),
  ('11111111-0000-0000-0000-000000191503','dddddddd-0000-0000-0000-000000191501','bbbbbbbb-0000-0000-0000-000000191501','2026-10-06','NEFT KAPOOR CA PART',20000,0,'N1','csv_upload'),
  ('11111111-0000-0000-0000-000000191504','dddddddd-0000-0000-0000-000000191501','bbbbbbbb-0000-0000-0000-000000191501','2026-10-13','NEFT KAPOOR CA REST',34000,0,'N2','csv_upload'),
  ('11111111-0000-0000-0000-000000191505','dddddddd-0000-0000-0000-000000191501','bbbbbbbb-0000-0000-0000-000000191501','2026-10-01','IMPS VERMA ADV',30000,0,'I1','csv_upload'),
  ('11111111-0000-0000-0000-000000191506','dddddddd-0000-0000-0000-000000191501','bbbbbbbb-0000-0000-0000-000000191501','2026-10-07','IMPS VERMA PART',5000,0,'I2','csv_upload'),
  ('11111111-0000-0000-0000-000000191507','dddddddd-0000-0000-0000-000000191501','bbbbbbbb-0000-0000-0000-000000191501','2026-10-14','IMPS SHARMA PS-3 PART',25000,0,'I3','csv_upload');

insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R1915-PS1','dddddddd-0000-0000-0000-000000191501','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000191501','2026-09-01',59000,9000,'gst','PS-1',false,null);

-- Owner 1915 signs in.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191501","role":"authenticated"}', true);

-- ── A. B5: ₹25,000 of the ₹59,000 bill ───────────────────────────────────────────────────────
do $$
declare r jsonb; msg text; e public.expenses; o record; v_pay bigint;
begin
  begin
    r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191501','eeeeeeee-0000-0000-0000-000000191501', null,
      '[{"source":"expense","doc_id":"EXP-R1915-PS1","amount":25000,"tds_amount":0}]'::jsonb);
  exception when others then
    raise exception 'A FAIL (B5): ₹25,000 part payment of the ₹59,000 bill refused: %', sqlerrm;
  end;
  if r->'paid'->0->>'status' <> 'partial' or (r->'paid'->0->>'still_due')::int <> 34000 then
    raise exception 'A FAIL: result %', r;
  end if;
  select * into e from public.expenses where id = 'EXP-R1915-PS1';
  if e.paid or e.paid_amount <> 25000 or e.reconciled_txn_id is not null then
    raise exception 'A FAIL: bill paid=% paid_amount=% reconciled=%', e.paid, e.paid_amount, e.reconciled_txn_id;
  end if;
  select * into o from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191501') where doc_id = 'EXP-R1915-PS1';
  if o.amount_due is distinct from 34000 or not o.can_part or o.source <> 'expense' then
    raise exception 'A FAIL: open item due % can_part % source %', o.amount_due, o.can_part, o.source;
  end if;
  select expenses_payable into v_pay from public.report_balance_sheet();
  if v_pay <> 34000 then raise exception 'A FAIL: Balance Sheet expenses payable % (want 34000)', v_pay; end if;
  raise notice 'A ok: ₹25,000 of the ₹59,000 bill paid — partial, ₹34,000 due (open items, BS payable)';
end $$;

-- ── B. The second line pays the rest ─────────────────────────────────────────────────────────
do $$
declare r jsonb; e public.expenses; n int; v_pay bigint;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191502','eeeeeeee-0000-0000-0000-000000191501', null,
    '[{"source":"expense","doc_id":"EXP-R1915-PS1","amount":34000,"tds_amount":0}]'::jsonb);
  if r->'paid'->0->>'status' <> 'paid' or (r->'paid'->0->>'still_due')::int <> 0 then raise exception 'B FAIL: result %', r; end if;
  select * into e from public.expenses where id = 'EXP-R1915-PS1';
  if not e.paid or e.paid_amount <> 59000 or e.reconciled_txn_id <> '11111111-0000-0000-0000-000000191502' or e.payment_method <> 'bank' then
    raise exception 'B FAIL: bill paid=% paid_amount=% reconciled=% method=%', e.paid, e.paid_amount, e.reconciled_txn_id, e.payment_method;
  end if;
  select count(*) into n from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191501') where doc_id = 'EXP-R1915-PS1';
  select expenses_payable into v_pay from public.report_balance_sheet();
  if n <> 0 or v_pay <> 0 then raise exception 'B FAIL: open % payable %', n, v_pay; end if;
  raise notice 'B ok: ₹34,000 line pays the rest — bill paid, nothing open';
end $$;

-- ── C. Undo, latest part first ───────────────────────────────────────────────────────────────
do $$
declare msg text; e public.expenses; v_due int;
begin
  begin
    update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191501';
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%un-reconcile that one first%' then raise exception 'C FAIL: first part undone under a later one: %', msg; end if;
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191502';
  select * into e from public.expenses where id = 'EXP-R1915-PS1';
  select amount_due into v_due from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191501') where doc_id = 'EXP-R1915-PS1';
  if e.paid or e.paid_amount <> 25000 or e.reconciled_txn_id is not null or v_due <> 34000 then
    raise exception 'C FAIL after undoing the rest: paid=% paid_amount=% due=%', e.paid, e.paid_amount, v_due;
  end if;
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191501';
  select * into e from public.expenses where id = 'EXP-R1915-PS1';
  select amount_due into v_due from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191501') where doc_id = 'EXP-R1915-PS1';
  if e.paid or e.paid_amount <> 0 or v_due <> 59000 then
    raise exception 'C FAIL after undoing both: paid=% paid_amount=% due=%', e.paid, e.paid_amount, v_due;
  end if;
  raise notice 'C ok: undo latest part first — ₹34,000 due, then ₹59,000';
end $$;

-- ── D. TDS on the first part ─────────────────────────────────────────────────────────────────
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R1915-KC1','dddddddd-0000-0000-0000-000000191501','Professional Services','Kapoor CA','eeeeeeee-0000-0000-0000-000000191503','2026-09-02',59000,9000,'gst','KC-1',false,null);
do $$
declare r jsonb; e public.expenses; o record; msg text; v_tds_dues bigint;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191503','eeeeeeee-0000-0000-0000-000000191503', null,
    '[{"source":"expense","doc_id":"EXP-R1915-KC1","amount":25000,"tds_amount":5000,"tds_section":"194J"}]'::jsonb);
  select * into e from public.expenses where id = 'EXP-R1915-KC1';
  if e.paid or e.paid_amount <> 20000 or e.tds_amount <> 5000 or e.tds_section <> '194J' then
    raise exception 'D FAIL: paid=% paid_amount=% tds=% %', e.paid, e.paid_amount, e.tds_amount, e.tds_section;
  end if;
  select * into o from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191503') where doc_id = 'EXP-R1915-KC1';
  if o.amount_due <> 34000 or o.tds_amount <> 0 or o.tds_base <> 0 then
    raise exception 'D FAIL: open item due % tds % base %', o.amount_due, o.tds_amount, o.tds_base;
  end if;
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191504','eeeeeeee-0000-0000-0000-000000191503', null,
      '[{"source":"expense","doc_id":"EXP-R1915-KC1","amount":35000,"tds_amount":1000,"tds_section":"194J"}]'::jsonb);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%TDS on bill KC-1 was taken with its first payment%' then raise exception 'D FAIL: TDS on the second part: %', msg; end if;
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191504','eeeeeeee-0000-0000-0000-000000191503', null,
    '[{"source":"expense","doc_id":"EXP-R1915-KC1","amount":34000,"tds_amount":0}]'::jsonb);
  select * into e from public.expenses where id = 'EXP-R1915-KC1';
  if not e.paid or e.tds_amount <> 5000 or e.paid_amount <> 54000 then
    raise exception 'D FAIL: after the rest paid=% tds=% paid_amount=%', e.paid, e.tds_amount, e.paid_amount;
  end if;
  select dues_vendor_tds into v_tds_dues from public.report_balance_sheet();
  if v_tds_dues <> 5000 then raise exception 'D FAIL: TDS payable % (want 5000)', v_tds_dues; end if;
  raise notice 'D ok: TDS ₹5,000 taken on the first part, ₹34,000 due after it, no TDS on the second part';
end $$;

-- ── E. Guards ────────────────────────────────────────────────────────────────────────────────
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R1915-PS3','dddddddd-0000-0000-0000-000000191501','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000191501','2026-09-20',20000,0,'none','PS-3',false,null);
do $$
declare msg text;
begin
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191507','eeeeeeee-0000-0000-0000-000000191501', null,
      '[{"source":"expense","doc_id":"EXP-R1915-PS3","amount":25000,"tds_amount":0}]'::jsonb);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%more than the ₹20000 still to pay%' then raise exception 'E FAIL: over-payment: %', msg; end if;
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191507','eeeeeeee-0000-0000-0000-000000191501', null,
      '[{"source":"expense","doc_id":"EXP-R1915-PS1","amount":25000,"tds_amount":0}]'::jsonb);
  begin
    update public.expenses set amount = 20000 where id = 'EXP-R1915-PS1';
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%paid from the bank%' then raise exception 'E FAIL: bill cut below what was paid: %', msg; end if;
  raise notice 'E ok: more than due refused; amount below the paid part refused';
end $$;

-- ── F. With the vendor's advance applied ─────────────────────────────────────────────────────
select public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191505','eeeeeeee-0000-0000-0000-000000191502', null, '[]'::jsonb, null, 30000, 'Repairs & Maintenance');
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R1915-VC1','dddddddd-0000-0000-0000-000000191501','Repairs & Maintenance','Verma Contractors','eeeeeeee-0000-0000-0000-000000191502','2026-10-02',50000,0,'none','VC-1',false,null);
do $$
declare e public.expenses; v_due int; msg text; r jsonb;
begin
  perform public.apply_vendor_advance('expense', 'EXP-R1915-VC1');
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191506','eeeeeeee-0000-0000-0000-000000191502', null,
    '[{"source":"expense","doc_id":"EXP-R1915-VC1","amount":5000,"tds_amount":0}]'::jsonb);
  select * into e from public.expenses where id = 'EXP-R1915-VC1';
  select amount_due into v_due from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191502') where doc_id = 'EXP-R1915-VC1';
  if e.paid or e.paid_amount <> 5000 or e.advance_applied <> 30000 or v_due <> 15000 then
    raise exception 'F FAIL: paid=% paid_amount=% applied=% due=%', e.paid, e.paid_amount, e.advance_applied, v_due;
  end if;
  begin perform public.undo_vendor_advance('EXP-R1915-VC1'); msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%un-reconcile that line first%' then raise exception 'F FAIL: advance undone under a bank part: %', msg; end if;
  raise notice 'F ok: ₹30,000 advance + ₹5,000 part → ₹15,000 due';
end $$;

-- ── G. Mark paid after a part (Expenses → Mark paid, UPI) ────────────────────────────────────
do $$
declare o record; v_unbanked bigint; msg text;
begin
  -- PS-1 has ₹25,000 paid (line 7, E); the rest is marked paid by UPI outside the bank feed.
  update public.expenses set paid = true, paid_date = '2026-10-15', payment_method = 'upi' where id = 'EXP-R1915-PS1';
  select * into o from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191501')
   where source = 'recorded_payment' and doc_id = 'EXP-R1915-PS1';
  if o.amount_due is distinct from 34000 then raise exception 'G FAIL: recorded payment waiting for its line % (want 34000)', o.amount_due; end if;
  select expenses_paid_unbanked into v_unbanked from public.report_balance_sheet();
  if v_unbanked <> 34000 then raise exception 'G FAIL: paid, not banked % (want 34000)', v_unbanked; end if;
  begin
    update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191507';
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%mark it unpaid first%' then raise exception 'G FAIL: part undone under Mark paid: %', msg; end if;
  raise notice 'G ok: Mark paid after a part records the ₹34,000 rest, not ₹59,000';
end $$;

rollback;
