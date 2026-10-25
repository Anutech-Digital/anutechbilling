-- R-1911 (25 Oct 2026, from the R-1906 audit B1): a vendor payment recorded OUTSIDE the bank
-- (Bills page → Pay = pay_vendor_bill's manual bank line; Expenses → Mark paid) plus the REAL
-- statement line for the same money must count ONCE — the bank line is MATCHED to the recorded
-- payment (QuickBooks "find match"), never paid again.
-- Migration: 20261025*_r1911_match_recorded_vendor_payment.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. B1 via R-1867 auto-reconcile (no click): bill ₹10,000, Bills page pays ₹5,000, the real
--      ₹5,000 line arrives → auto-match offers the RECORDED PAYMENT (not the bill); auto-reconcile
--      replaces the manual line: bill paid ₹5,000 once, bank shows ₹5,000 out, manual line gone.
--   B. Manual path (the reconcile sheet's RPC): paying the bill again is refused; matching the
--      recorded payment works; a second real ₹5,000 line then pays the rest (bill = total, never more).
--   C. Expenses → Mark paid + the real line: listed as a recorded payment; booking the whole line as
--      an advance is refused; matching it banks the expense (no advance, no second expense).
--   D. Undo: un-reconciling a matched line puts the Bills-page payment / Mark-paid back as it was.
--   E. Limits: wrong amount refused; another vendor's payment refused; paid_amount never above
--      total; every reconciled vendor line's parts = its debit; the account's money out = the
--      payments, counted once.

begin;

create function pg_temp.r1911_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1911_supplier before insert on public.tenants for each row execute function pg_temp.r1911_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000191101','R1911 Co','r1911@example.in','07','R1911');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000191101','owner1911@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000191101','dddddddd-0000-0000-0000-000000191101','owner1911@example.in','Owner 1911','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000191101','dddddddd-0000-0000-0000-000000191101','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000191102','dddddddd-0000-0000-0000-000000191101','ICICI Current','ICICI'),
  ('bbbbbbbb-0000-0000-0000-000000191103','dddddddd-0000-0000-0000-000000191101','SBI Current','SBI');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000191101','dddddddd-0000-0000-0000-000000191101','Google Cloud India','29AACCG1911B1Z9','AACCG1911B','COGS-Workspace'),
  ('eeeeeeee-0000-0000-0000-000000191102','dddddddd-0000-0000-0000-000000191101','Mehta Traders','07AAKFM1911A1Z5','AAKFM1911A','COGS-Hardware'),
  ('eeeeeeee-0000-0000-0000-000000191103','dddddddd-0000-0000-0000-000000191101','Sharma Associates','07AAKFS1911A1Z5','AAKFS1911A','Professional Services');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191101","role":"authenticated"}', true);

-- ── A. B1 through R-1867 auto-reconcile (HDFC account only) ──────────────────
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category, subtotal, igst, total, status, paid_amount) values
  ('BILL-R1911-A','dddddddd-0000-0000-0000-000000191101','eeeeeeee-0000-0000-0000-000000191101','Google Cloud India','29AACCG1911B1Z9','G-10','2026-09-05','2026-10-05','COGS-Workspace',8475,1525,10000,'unpaid',0);
select public.pay_vendor_bill('BILL-R1911-A', 5000, '2026-10-10', 'bbbbbbbb-0000-0000-0000-000000191101', 'NEFT');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191101','dddddddd-0000-0000-0000-000000191101','bbbbbbbb-0000-0000-0000-000000191101','2026-10-10','NEFT DR-HDFC0001-GOOGLE CLOUD INDIA-N283',5000,0,'N283','csv_upload');
do $$
declare n int; v_src text; r jsonb; v_paid int; v_status text; v_out bigint; v_synth int; v_type text; v_lines int;
begin
  select count(*), min(source) into n, v_src from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000191101');
  if n <> 1 or v_src <> 'recorded_payment' then
    raise exception 'A FAIL: auto-match must offer only the Bills-page payment to match (got % rows, source %) — offering the bill pays it twice', n, v_src;
  end if;
  r := public.auto_reconcile_bank_account('bbbbbbbb-0000-0000-0000-000000191101');
  select paid_amount, status into v_paid, v_status from public.vendor_bills where id = 'BILL-R1911-A';
  select sum(debit) into v_out from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000191101';
  select count(*) into v_synth from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000191101' and source = 'manual';
  select matched_to_type into v_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000191101';
  select count(*) into v_lines from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000191101' and kind = 'recorded_payment' and vendor_bill_id = 'BILL-R1911-A' and cash = 5000;
  if v_paid <> 5000 or v_status <> 'partial' or v_out <> 5000 or v_synth <> 0 or v_type is distinct from 'vendor_payment' or v_lines <> 1 then
    raise exception 'A FAIL (B1): bill paid=% (%), bank out=%, manual lines left=%, line=%, match rows=% — expected 5000 partial, 5000, 0, vendor_payment, 1 (auto=%)',
      v_paid, v_status, v_out, v_synth, v_type, v_lines, r;
  end if;
  raise notice 'A PASS: auto-reconcile matched the Bills-page payment — bill paid Rs % once, bank out Rs %, manual line replaced', v_paid, v_out;
end $$;

-- ── B. Manual path (ICICI): pay-again refused, match works, 2nd real line pays the rest ──
insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category, subtotal, cgst, sgst, total, status, paid_amount) values
  ('BILL-R1911-B','dddddddd-0000-0000-0000-000000191101','eeeeeeee-0000-0000-0000-000000191102','Mehta Traders','07AAKFM1911A1Z5','M-7','2026-09-06','2026-10-06','COGS-Hardware',8475,762,763,10000,'unpaid',0);
select public.pay_vendor_bill('BILL-R1911-B', 5000, '2026-10-11', 'bbbbbbbb-0000-0000-0000-000000191102', 'NEFT');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191102','dddddddd-0000-0000-0000-000000191101','bbbbbbbb-0000-0000-0000-000000191102','2026-10-12','IMPS MEHTA TRADERS M7',5000,0,'I7','csv_upload'),
  ('11111111-0000-0000-0000-000000191103','dddddddd-0000-0000-0000-000000191101','bbbbbbbb-0000-0000-0000-000000191102','2026-10-20','IMPS MEHTA TRADERS M7 BAL',5000,0,'I8','csv_upload'),
  ('11111111-0000-0000-0000-000000191104','dddddddd-0000-0000-0000-000000191101','bbbbbbbb-0000-0000-0000-000000191102','2026-10-21','IMPS MEHTA TRADERS EXTRA',5000,0,'I9','csv_upload');
do $$
declare msg text; v_rec text; r jsonb; v_paid int; v_status text; v_out bigint; n int;
begin
  -- The recorded payment is an open item of the vendor, listed FIRST.
  select doc_id into v_rec from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191102') limit 1;
  if not exists (select 1 from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191102') o
                  where o.source = 'recorded_payment' and o.pays_doc_id = 'BILL-R1911-B' and o.amount_due = 5000 and o.paid_on = '2026-10-11') then
    raise exception 'B FAIL: the Bills-page payment is not listed as an open item to match';
  end if;
  if (select source from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191102') limit 1) <> 'recorded_payment' then
    raise exception 'B FAIL: the recorded payment must be listed first';
  end if;
  select doc_id into v_rec from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191102') where source = 'recorded_payment';

  -- Paying the bill again from this line is refused (it would pay the vendor twice).
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191102','eeeeeeee-0000-0000-0000-000000191102', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R1911-B","amount":5000,"tds_amount":0}]'::jsonb);
  exception when others then msg := sqlerrm; end;
  if msg is null or msg not ilike '%already%Bills page%' then
    raise exception 'B FAIL: paying a bill that has an unmatched Bills-page payment of this amount must be refused (got: %)', coalesce(msg, 'accepted');
  end if;
  -- A wrong amount for the recorded payment is refused.
  msg := null;
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191102','eeeeeeee-0000-0000-0000-000000191102', null,
      jsonb_build_array(jsonb_build_object('source','recorded_payment','doc_id',v_rec,'amount',4000)), null, 1000, 'Other');
  exception when others then msg := sqlerrm; end;
  if msg is null then raise exception 'B FAIL: matching ₹4,000 to a ₹5,000 recorded payment was accepted'; end if;

  -- Match → replaces the manual line.
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191102','eeeeeeee-0000-0000-0000-000000191102', null,
      jsonb_build_array(jsonb_build_object('source','recorded_payment','doc_id',v_rec,'amount',5000)));
  select paid_amount, status into v_paid, v_status from public.vendor_bills where id = 'BILL-R1911-B';
  if v_paid <> 5000 or exists (select 1 from public.bank_transactions where id::text = v_rec) then
    raise exception 'B FAIL: after the match bill paid=% (want 5000) / manual line still there=%', v_paid, exists (select 1 from public.bank_transactions where id::text = v_rec);
  end if;
  if (r->'paid'->0->>'source') <> 'recorded_payment' or (r->'paid'->0->>'doc_id') <> 'BILL-R1911-B' then
    raise exception 'B FAIL: result does not say the recorded payment was matched: %', r;
  end if;

  -- The second real ₹5,000 line now pays the rest of the bill (no longer blocked).
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191103','eeeeeeee-0000-0000-0000-000000191102', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R1911-B","amount":5000,"tds_amount":0}]'::jsonb);
  select paid_amount, status into v_paid, v_status from public.vendor_bills where id = 'BILL-R1911-B';
  if v_paid <> 10000 or v_status <> 'paid' then raise exception 'B FAIL: second line should pay the bill to 10000/paid, got %/%', v_paid, v_status; end if;

  -- A third ₹5,000 line cannot push it above the total.
  msg := null;
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191104','eeeeeeee-0000-0000-0000-000000191102', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R1911-B","amount":5000,"tds_amount":0}]'::jsonb);
  exception when others then msg := sqlerrm; end;
  if msg is null then raise exception 'B FAIL: a paid bill accepted another ₹5,000'; end if;
  select count(*) into n from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000191104');
  if n <> 0 then raise exception 'B FAIL: auto-match offers % item(s) for a fully paid bill', n; end if;

  select sum(debit) into v_out from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000191102' and matched_to_type is not null;
  if v_out <> 10000 then raise exception 'B FAIL: ICICI shows Rs % out for a Rs 10,000 bill', v_out; end if;
  raise notice 'B PASS: pay-again refused, recorded payment matched, 2nd line paid the rest — bill Rs %, bank out Rs %', v_paid, v_out;
end $$;

-- ── C. Expenses → Mark paid, then the real line (SBI) ───────────────────────
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, paid_date, payment_method, bank_account_id, tds_amount, tds_section) values
  ('EXP-R1911-C','dddddddd-0000-0000-0000-000000191101','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000191103','2026-09-01',11800,1800,'gst','PS-9',true,'2026-10-14','bank','bbbbbbbb-0000-0000-0000-000000191103',1000,'194J');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191105','dddddddd-0000-0000-0000-000000191101','bbbbbbbb-0000-0000-0000-000000191103','2026-10-15','UPI SHARMA ASSOCIATES PS9',10800,0,'U9','csv_upload');
do $$
declare msg text; r jsonb; v_adv int; v_exp int; v_rec text; n int; v_src text;
begin
  select doc_id into v_rec from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191103')
   where source = 'recorded_payment' and pays_source = 'expense' and pays_doc_id = 'EXP-R1911-C' and amount_due = 10800;
  if v_rec is null then raise exception 'C FAIL: the Mark-paid expense (cash ₹10,800 after TDS) is not listed as a recorded payment'; end if;
  select count(*), min(source) into n, v_src from public.bank_debit_vendor_auto_match('11111111-0000-0000-0000-000000191105');
  if n <> 1 or v_src <> 'recorded_payment' then raise exception 'C FAIL: auto-match should offer the Mark-paid expense (got % / %)', n, v_src; end if;
  -- The whole line as an advance would put the cash out twice: refused.
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191105','eeeeeeee-0000-0000-0000-000000191103', null, '[]'::jsonb, null, 10800, 'Professional Services');
  exception when others then msg := sqlerrm; end;
  if msg is null or msg not ilike '%already%' then raise exception 'C FAIL: whole-line advance over a Mark-paid expense must be refused (got %)', coalesce(msg, 'accepted'); end if;

  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191105','eeeeeeee-0000-0000-0000-000000191103', null,
      jsonb_build_array(jsonb_build_object('source','recorded_payment','doc_id',v_rec,'amount',10800)));
  select count(*) into v_adv from public.prepaid_advances where tenant_id = 'dddddddd-0000-0000-0000-000000191101';
  select count(*) into v_exp from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000191101' and vendor_id = 'eeeeeeee-0000-0000-0000-000000191103';
  if v_adv <> 0 or v_exp <> 1
     or (select reconciled_txn_id from public.expenses where id = 'EXP-R1911-C') is distinct from '11111111-0000-0000-0000-000000191105'::uuid
     or (select tds_amount from public.expenses where id = 'EXP-R1911-C') <> 1000 then
    raise exception 'C FAIL: advances=%, expenses=%, expense row=%', v_adv, v_exp, (select to_jsonb(e) from public.expenses e where id = 'EXP-R1911-C');
  end if;
  if exists (select 1 from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000191103') where source = 'recorded_payment') then
    raise exception 'C FAIL: the matched expense is still offered as a recorded payment';
  end if;
  raise notice 'C PASS: Mark-paid expense matched to the real line — 1 expense, 0 advances, TDS kept';
end $$;

-- ── D. Undo puts the outside payments back as they were ──────────────────────
do $$
declare v_paid int; v_synth int; v_out bigint; e public.expenses;
begin
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191102';
  select paid_amount into v_paid from public.vendor_bills where id = 'BILL-R1911-B';
  select count(*) into v_synth from public.bank_transactions
   where source = 'manual' and matched_to_type = 'vendor_bill' and matched_to_id = 'BILL-R1911-B' and debit = 5000 and txn_date = '2026-10-11';
  if v_paid <> 10000 or v_synth <> 1 then
    raise exception 'D FAIL: undo of the match should restore the Bills-page line (got %) and keep the bill paid 10000 (got %)', v_synth, v_paid;
  end if;
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000191105';
  select * into e from public.expenses where id = 'EXP-R1911-C';
  if not e.paid or e.reconciled_txn_id is not null or e.paid_date <> '2026-10-14' or e.payment_method <> 'bank' then
    raise exception 'D FAIL: undo should leave the expense Mark-paid as before, got %', to_jsonb(e);
  end if;
  raise notice 'D PASS: undo restored the Bills-page line and the Mark-paid expense';
end $$;

-- ── E. Limits across the company ─────────────────────────────────────────────
do $$
declare n int; msg text;
begin
  -- Another vendor's recorded payment cannot be matched.
  insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
    ('11111111-0000-0000-0000-000000191106','dddddddd-0000-0000-0000-000000191101','bbbbbbbb-0000-0000-0000-000000191102','2026-10-22','IMPS SOMEONE',5000,0,'X1','csv_upload');
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191106','eeeeeeee-0000-0000-0000-000000191101', null,
      jsonb_build_array(jsonb_build_object('source','recorded_payment','doc_id',
        (select id::text from public.bank_transactions where source = 'manual' and matched_to_id = 'BILL-R1911-B'),'amount',5000)));
  exception when others then msg := sqlerrm; end;
  if msg is null then raise exception 'E FAIL: Google''s line matched Mehta''s Bills-page payment'; end if;

  select count(*) into n from public.vendor_bills where tenant_id = 'dddddddd-0000-0000-0000-000000191101' and paid_amount > total;
  if n <> 0 then raise exception 'E FAIL: % bill(s) paid above their total', n; end if;
  select count(*) into n from public.bank_transactions t
   where t.tenant_id = 'dddddddd-0000-0000-0000-000000191101' and t.matched_to_type = 'vendor_payment'
     and t.debit <> (select coalesce(sum(l.cash), 0) from public.bank_vendor_payment_lines l where l.bank_txn_id = t.id);
  if n <> 0 then raise exception 'E FAIL: % vendor line(s) whose parts do not add up to the debit', n; end if;
  -- Money out = what the bills record as paid (plus the Mark-paid expense's cash), counted once:
  -- HDFC 5,000 (bill A) + ICICI 5,000 manual restored + 5,000 real (bill B 10,000) + SBI 10,800 (expense, now unbanked again → its own real line unmatched).
  select count(*) into n from public.vendor_bills b
   where b.tenant_id = 'dddddddd-0000-0000-0000-000000191101'
     and b.paid_amount <> (select coalesce(sum(t.debit), 0) from public.bank_transactions t where t.matched_to_type = 'vendor_bill' and t.matched_to_id = b.id)
                        + (select coalesce(sum(l.cash + l.tds_amount), 0) from public.bank_vendor_payment_lines l where l.vendor_bill_id = b.id);
  if n <> 0 then raise exception 'E FAIL: % bill(s) whose paid amount differs from the bank money behind it (double or missing)', n; end if;
  raise notice 'E PASS: limits hold — no bill above total, every vendor line balanced, each bill paid by its bank money once';
end $$;

rollback;
