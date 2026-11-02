-- R-2321 (1 Nov 2026, p1, G-RECON): part-pay a NEW expense bill from Reconcile.
-- Banking → a money-out line → Vendor → "The bill is not in the books yet — record it now" →
-- Expense bill had no "Paying now": the RPC refused any new expense bill not paid in full, so
-- Shri Balaji's ₹67,500 line against a ₹71,500 bill (staging, 31 Oct) could not be booked.
-- Migration: 20261031234709_r2321_new_expense_part_pay.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Owner's path: ₹71,500 bill, ₹67,500 paid now from the ₹67,500 line → the bill is saved with
--      its FULL ₹71,500, partial, ₹4,000 due (open items can_part, Balance Sheet payable); the bank
--      line has ONE vendor-payment leg of ₹67,500 and is matched once.
--   B. The rest (₹4,000) by a second line through the R-1915 path → bill paid, linked to that line.
--   C. Undo: the first line (which created the bill) is REFUSED while the later line is on the bill
--      (also in the Undo preview); later line first → ₹4,000 due again; then the first → bill gone.
--   D. Guards: paying now more than the bill, ₹0, or not more than the TDS → refused; more than the
--      ₹4,000 still due on a later line → refused.
--   E. TDS (R-1915 rule): the bill's whole TDS goes with this first part — ₹59,000 bill, TDS ₹5,000
--      (194J), paying now ₹30,000 = ₹25,000 cash + ₹5,000 TDS → ₹29,000 due, no TDS left to take.
--   F. Mark paid after the part → undoing the first line is REFUSED (it would delete a paid bill).
--   G. Paying now = the bill total still works as before (paid, linked to the line).

begin;

create function pg_temp.r2321_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2321_supplier before insert on public.tenants for each row execute function pg_temp.r2321_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000232101','R2321 Co','r2321@example.in','07','R2321');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000232101','owner2321@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000232101','dddddddd-0000-0000-0000-000000232101','owner2321@example.in','Owner 2321','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000232101','dddddddd-0000-0000-0000-000000232101','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000232101','dddddddd-0000-0000-0000-000000232101','Shri Balaji Traders','07AAKFB2321A1Z5','AAKFB2321A','Repairs & Maintenance'),
  ('eeeeeeee-0000-0000-0000-000000232102','dddddddd-0000-0000-0000-000000232101','Kapoor CA','07AAKFK2321A1Z5','AAKFK2321A','Professional Services'),
  ('eeeeeeee-0000-0000-0000-000000232103','dddddddd-0000-0000-0000-000000232101','Verma Electricals','07AAKFV2321A1Z5','AAKFV2321A','Repairs & Maintenance');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000232101','dddddddd-0000-0000-0000-000000232101','bbbbbbbb-0000-0000-0000-000000232101','2026-10-05','NEFT SHRI BALAJI TRADERS',67500,0,'N1','csv_upload'),
  ('11111111-0000-0000-0000-000000232102','dddddddd-0000-0000-0000-000000232101','bbbbbbbb-0000-0000-0000-000000232101','2026-10-20','NEFT SHRI BALAJI REST',4000,0,'N2','csv_upload'),
  ('11111111-0000-0000-0000-000000232103','dddddddd-0000-0000-0000-000000232101','bbbbbbbb-0000-0000-0000-000000232101','2026-10-21','NEFT SHRI BALAJI MORE',5000,0,'N3','csv_upload'),
  ('11111111-0000-0000-0000-000000232104','dddddddd-0000-0000-0000-000000232101','bbbbbbbb-0000-0000-0000-000000232101','2026-10-06','NEFT KAPOOR CA PART',25000,0,'N4','csv_upload'),
  ('11111111-0000-0000-0000-000000232105','dddddddd-0000-0000-0000-000000232101','bbbbbbbb-0000-0000-0000-000000232101','2026-10-07','IMPS VERMA PART',10000,0,'I1','csv_upload'),
  ('11111111-0000-0000-0000-000000232106','dddddddd-0000-0000-0000-000000232101','bbbbbbbb-0000-0000-0000-000000232101','2026-10-08','IMPS VERMA FULL',11800,0,'I2','csv_upload');

-- Owner 2321 signs in.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000232101","role":"authenticated"}', true);

-- ── A. Owner's path: ₹67,500 now on a ₹71,500 bill ───────────────────────────────────────────
do $$
declare r jsonb; e public.expenses; o record; n int; c bigint; v_pay bigint; t public.bank_transactions;
begin
  begin
    r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232101','eeeeeeee-0000-0000-0000-000000232101', null, '[]'::jsonb,
      '{"kind":"expense","bill_no":"SB-71","bill_date":"2026-10-01","category":"Repairs & Maintenance","taxable":60594,"gst":10906,"itc":true,"tds_amount":0,"pay":67500}'::jsonb);
  exception when others then
    raise exception 'A FAIL (owner path): ₹67,500 now on a new ₹71,500 expense bill refused: %', sqlerrm;
  end;
  if r->'new_bill'->>'status' <> 'partial' or (r->'new_bill'->>'still_due')::int <> 4000 or (r->'new_bill'->>'cash')::int <> 67500 then
    raise exception 'A FAIL: result new_bill %', r->'new_bill';
  end if;
  select * into e from public.expenses where id = r->'new_bill'->>'doc_id';
  if e.amount <> 71500 or e.paid or e.paid_amount <> 67500 or e.reconciled_txn_id is not null or e.vendor_id <> 'eeeeeeee-0000-0000-0000-000000232101' then
    raise exception 'A FAIL: bill amount=% paid=% paid_amount=% reconciled=%', e.amount, e.paid, e.paid_amount, e.reconciled_txn_id;
  end if;
  select * into o from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000232101') where doc_id = e.id;
  if o.amount_due is distinct from 4000 or not o.can_part or o.source <> 'expense' then
    raise exception 'A FAIL: open item due % can_part % source %', o.amount_due, o.can_part, o.source;
  end if;
  select count(*), sum(cash) into n, c from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000232101';
  if n <> 1 or c <> 67500 then raise exception 'A FAIL: line legs % cash % (want 1 leg, ₹67,500)', n, c; end if;
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000232101';
  if t.matched_to_type is distinct from 'vendor_payment' then raise exception 'A FAIL: bank line matched_to_type %', t.matched_to_type; end if;
  select expenses_payable into v_pay from public.report_balance_sheet();
  if v_pay <> 4000 then raise exception 'A FAIL: Balance Sheet expenses payable % (want 4000)', v_pay; end if;
  -- the same line cannot be booked twice
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232101','eeeeeeee-0000-0000-0000-000000232101', null,
      ('[{"source":"expense","doc_id":"' || e.id || '","amount":4000,"tds_amount":0}]')::jsonb, null, 63500);
    raise exception 'A FAIL: the same bank line was reconciled a second time';
  exception when others then
    if sqlerrm like 'A FAIL%' then raise; end if;
  end;
  raise notice 'A ok: ₹71,500 bill saved in full, ₹67,500 linked to the line, ₹4,000 due';
end $$;

-- ── B + C + D(later line). The rest by a second line; undo order ─────────────────────────────
do $$
declare v_id text; r jsonb; e public.expenses; msg text; v_due int; p jsonb; n int;
begin
  select expense_id into v_id from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000232101';
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232103','eeeeeeee-0000-0000-0000-000000232101', null,
      ('[{"source":"expense","doc_id":"' || v_id || '","amount":5000,"tds_amount":0}]')::jsonb);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%more than the ₹4000 still to pay%' then raise exception 'D FAIL: ₹5,000 on ₹4,000 due: %', msg; end if;

  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232102','eeeeeeee-0000-0000-0000-000000232101', null,
    ('[{"source":"expense","doc_id":"' || v_id || '","amount":4000,"tds_amount":0}]')::jsonb);
  select * into e from public.expenses where id = v_id;
  if not e.paid or e.paid_amount <> 71500 or e.reconciled_txn_id <> '11111111-0000-0000-0000-000000232102' then
    raise exception 'B FAIL: paid=% paid_amount=% reconciled=%', e.paid, e.paid_amount, e.reconciled_txn_id;
  end if;
  raise notice 'B ok: ₹4,000 line pays the rest — bill paid';

  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000232101');
  if not coalesce((p->>'blocked')::boolean, false) then raise exception 'C FAIL: undo preview of the first line not blocked: %', p; end if;
  begin
    update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000232101';
    msg := null;
  exception when others then msg := sqlerrm; end;
  if msg is null then raise exception 'C FAIL: the line that created the bill was undone while a later line is on it'; end if;
  select count(*) into n from public.expenses where id = v_id;
  if n <> 1 then raise exception 'C FAIL: bill gone after a refused undo'; end if;

  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000232102';
  select * into e from public.expenses where id = v_id;
  select amount_due into v_due from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000232101') where doc_id = v_id;
  if e.paid or e.paid_amount <> 67500 or v_due <> 4000 then raise exception 'C FAIL after undoing the rest: paid=% paid_amount=% due=%', e.paid, e.paid_amount, v_due; end if;
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000232101';
  select count(*) into n from public.expenses where id = v_id;
  if n <> 0 then raise exception 'C FAIL: the bill the first line created is still there after undoing it'; end if;
  select count(*) into n from public.bank_vendor_payment_lines where bank_txn_id in ('11111111-0000-0000-0000-000000232101','11111111-0000-0000-0000-000000232102');
  if n <> 0 then raise exception 'C FAIL: % legs left', n; end if;
  raise notice 'C ok: first line refused while the later one is on the bill; later first, then the first';
end $$;

-- ── D. Guards on the new bill ────────────────────────────────────────────────────────────────
do $$
declare msg text;
begin
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232101','eeeeeeee-0000-0000-0000-000000232101', null, '[]'::jsonb,
      '{"kind":"expense","category":"Repairs & Maintenance","taxable":60000,"gst":0,"tds_amount":0,"pay":67500}'::jsonb);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%between ₹1 and the bill total ₹60000%' then raise exception 'D FAIL: paying now above the bill: %', msg; end if;
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232101','eeeeeeee-0000-0000-0000-000000232101', null, '[]'::jsonb,
      '{"kind":"expense","category":"Repairs & Maintenance","taxable":71500,"gst":0,"tds_amount":0,"pay":0}'::jsonb, 67500);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%between ₹1 and the bill total%' then raise exception 'D FAIL: paying ₹0: %', msg; end if;
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232101','eeeeeeee-0000-0000-0000-000000232101', null, '[]'::jsonb,
      '{"kind":"expense","category":"Professional Services","taxable":71500,"gst":0,"tds_amount":7150,"tds_section":"194J","pay":7000}'::jsonb, 67500);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%more than the TDS%' then raise exception 'D FAIL: paying now not above the TDS: %', msg; end if;
  raise notice 'D ok: above the bill, ₹0 and not above the TDS refused';
end $$;

-- ── E. TDS goes with the first part (R-1915 rule) ────────────────────────────────────────────
do $$
declare r jsonb; e public.expenses; o record; msg text;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232104','eeeeeeee-0000-0000-0000-000000232102', null, '[]'::jsonb,
    '{"kind":"expense","bill_no":"KC-9","bill_date":"2026-10-02","category":"Professional Services","taxable":50000,"gst":9000,"itc":true,"tds_amount":5000,"tds_section":"194J","pay":30000}'::jsonb);
  select * into e from public.expenses where id = r->'new_bill'->>'doc_id';
  if e.amount <> 59000 or e.paid or e.paid_amount <> 25000 or e.tds_amount <> 5000 or e.tds_section <> '194J' then
    raise exception 'E FAIL: amount=% paid=% paid_amount=% tds=% %', e.amount, e.paid, e.paid_amount, e.tds_amount, e.tds_section;
  end if;
  if (r->'new_bill'->>'still_due')::int <> 29000 or (r->'new_bill'->>'tds')::int <> 5000 then raise exception 'E FAIL: result %', r->'new_bill'; end if;
  select * into o from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000232102') where doc_id = e.id;
  if o.amount_due <> 29000 or o.tds_amount <> 0 or o.tds_base <> 0 then
    raise exception 'E FAIL: open item due % tds % base %', o.amount_due, o.tds_amount, o.tds_base;
  end if;
  raise notice 'E ok: TDS ₹5,000 with the first part, ₹29,000 due';
end $$;

-- ── F. Mark paid after the part → undo of the creating line refused ──────────────────────────
do $$
declare r jsonb; msg text; n int;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232105','eeeeeeee-0000-0000-0000-000000232103', null, '[]'::jsonb,
    '{"kind":"expense","bill_no":"VE-1","bill_date":"2026-10-03","category":"Repairs & Maintenance","taxable":20000,"gst":0,"tds_amount":0,"pay":10000}'::jsonb);
  update public.expenses set paid = true, paid_date = '2026-10-15', payment_method = 'upi' where id = r->'new_bill'->>'doc_id';
  begin
    update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000232105';
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%mark it unpaid first%' then raise exception 'F FAIL: part undone under Mark paid: %', msg; end if;
  select count(*) into n from public.expenses where id = r->'new_bill'->>'doc_id';
  if n <> 1 then raise exception 'F FAIL: bill gone'; end if;
  raise notice 'F ok: Mark paid after the part blocks undoing the line that created the bill';
end $$;

-- ── G. Paying the whole bill still works as before ───────────────────────────────────────────
do $$
declare r jsonb; e public.expenses;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232106','eeeeeeee-0000-0000-0000-000000232103', null, '[]'::jsonb,
    '{"kind":"expense","bill_no":"VE-2","bill_date":"2026-10-04","category":"Repairs & Maintenance","taxable":10000,"gst":1800,"tds_amount":0,"pay":11800}'::jsonb);
  select * into e from public.expenses where id = r->'new_bill'->>'doc_id';
  if not e.paid or e.reconciled_txn_id <> '11111111-0000-0000-0000-000000232106' or e.payment_method <> 'bank' or r->'new_bill'->>'status' <> 'paid' then
    raise exception 'G FAIL: paid=% reconciled=% method=% result %', e.paid, e.reconciled_txn_id, e.payment_method, r->'new_bill';
  end if;
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000232106';
  if exists (select 1 from public.expenses where id = e.id) then raise exception 'G FAIL: undo kept the full-paid new bill'; end if;
  raise notice 'G ok: a full new expense bill is paid + linked as before; undo removes it';
end $$;

rollback;
