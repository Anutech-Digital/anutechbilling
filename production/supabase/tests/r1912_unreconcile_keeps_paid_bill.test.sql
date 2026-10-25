-- R-1912 (25 Oct 2026, p0 — R-1906 audit B7): un-reconciling a bank line that created a NEW bill
-- must never delete a bill that still has other payments on it.
-- Migration: 20261025151118_r1912_unreconcile_keeps_paid_bill.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves (the app's real path: Banking → Undo = unreconcile_bank_receipt):
--   A. B7: bank line L1 ₹5,000 records a NEW COGS bill ₹11,800 (pays ₹5,000); Bills page pays the
--      other ₹6,800. Undo L1 → the bill STAYS, paid ₹6,800 (partial), ₹5,000 due; L1's own payment
--      row is gone; no bank line points at a missing bill (deferred guards fired); books agree:
--      paid_amount = money matched to it, payables = total − paid.
--   B. R-1911 match + undo: real line L2 ₹6,800 MATCHES the Bills-page payment (manual line replaced),
--      bill unchanged. Undo L2 → the Bills-page manual line comes back exactly; bill still ₹6,800.
--   C. Same as A, but the other ₹6,800 sits on a MATCHED real line (R-1911) — undo of the creating
--      line keeps the bill (before: FK error / deleted bill).
--   D. Unchanged: a new bill with no other payment is still deleted on undo (nothing left behind).
--   E. A new bill held in an open payment run stays (unpaid) on undo.

begin;

create function pg_temp.r1912_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1912_supplier before insert on public.tenants for each row execute function pg_temp.r1912_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000191201','R1912 Co','r1912@example.in','07','R1912');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000191201','owner1912@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000191201','dddddddd-0000-0000-0000-000000191201','owner1912@example.in','Owner 1912','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000191201','dddddddd-0000-0000-0000-000000191201','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000191201','dddddddd-0000-0000-0000-000000191201','Google Cloud India','29AACCG1912B1Z9','AACCG1912B','COGS-Workspace');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000191201","role":"authenticated"}', true);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000191201','dddddddd-0000-0000-0000-000000191201','bbbbbbbb-0000-0000-0000-000000191201','2026-10-06','NEFT GOOGLE NEW BILL PART',5000,0,'N1','csv_upload'),
  ('11111111-0000-0000-0000-000000191202','dddddddd-0000-0000-0000-000000191201','bbbbbbbb-0000-0000-0000-000000191201','2026-10-07','NEFT DR-HDFC0001-GOOGLE CLOUD INDIA-N2',6800,0,'N2','csv_upload'),
  ('11111111-0000-0000-0000-000000191203','dddddddd-0000-0000-0000-000000191201','bbbbbbbb-0000-0000-0000-000000191201','2026-10-08','NEFT GOOGLE NEW BILL C',5000,0,'N3','csv_upload'),
  ('11111111-0000-0000-0000-000000191204','dddddddd-0000-0000-0000-000000191201','bbbbbbbb-0000-0000-0000-000000191201','2026-10-09','NEFT DR-HDFC0001-GOOGLE CLOUD INDIA-N4',6800,0,'N4','csv_upload'),
  ('11111111-0000-0000-0000-000000191205','dddddddd-0000-0000-0000-000000191201','bbbbbbbb-0000-0000-0000-000000191201','2026-10-10','NEFT GOOGLE NEW BILL D',5000,0,'N5','csv_upload'),
  ('11111111-0000-0000-0000-000000191206','dddddddd-0000-0000-0000-000000191201','bbbbbbbb-0000-0000-0000-000000191201','2026-10-11','NEFT GOOGLE NEW BILL E',5000,0,'N6','csv_upload');

create temp table r1912_ids (k text primary key, v text) on commit drop;

-- Books agree for one bill: paid_amount = cash matched to it (direct lines + vendor-payment rows),
-- status follows paid_amount, and no bank line of the tenant points at a missing bill / expense.
create function pg_temp.r1912_books_ok(p_bill text, p_label text) returns void language plpgsql as $f$
declare b public.vendor_bills; v_cash bigint; n_orphan int;
begin
  select * into b from public.vendor_bills where id = p_bill;
  select coalesce((select sum(debit) from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = p_bill), 0)
       + coalesce((select sum(cash + tds_amount) from public.bank_vendor_payment_lines where vendor_bill_id = p_bill), 0)
    into v_cash;
  if v_cash is distinct from coalesce(b.paid_amount, 0)::bigint then
    raise exception '% FAIL: bill % paid_amount % but the money matched to it is % — books and bank disagree', p_label, p_bill, b.paid_amount, v_cash;
  end if;
  if b.status is distinct from (case when b.paid_amount <= 0 then 'unpaid' when b.paid_amount < b.total then 'partial' else 'paid' end) then
    raise exception '% FAIL: bill % status % with paid % of %', p_label, p_bill, b.status, b.paid_amount, b.total;
  end if;
  select count(*) into n_orphan from public.bank_transactions t
   where t.tenant_id = 'dddddddd-0000-0000-0000-000000191201'
     and ((t.matched_to_type = 'vendor_bill' and not exists (select 1 from public.vendor_bills x where x.id = t.matched_to_id))
       or (t.matched_to_type = 'expense' and not exists (select 1 from public.expenses x where x.id = t.matched_to_id))
       or (t.matched_to_type = 'vendor_payment' and not exists (select 1 from public.bank_vendor_payment_lines l where l.bank_txn_id = t.id)));
  if n_orphan > 0 then raise exception '% FAIL: % bank line(s) point at a missing bill / expense / payment', p_label, n_orphan; end if;
  -- every reconciled vendor-payment line's parts add up to its debit (nothing half-reversed)
  if exists (select 1 from public.bank_transactions t
              where t.tenant_id = 'dddddddd-0000-0000-0000-000000191201' and t.matched_to_type = 'vendor_payment'
                and t.debit <> (select coalesce(sum(cash), 0) from public.bank_vendor_payment_lines l where l.bank_txn_id = t.id)) then
    raise exception '% FAIL: a vendor-payment line''s parts do not add up to its debit', p_label;
  end if;
end $f$;

-- ── A. B7: new bill from L1 + Bills-page ₹6,800, then Undo L1 ─────────────────
do $$
declare r jsonb; v_bill text; b public.vendor_bills; v_manual uuid; bs record; t public.bank_transactions;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191201','eeeeeeee-0000-0000-0000-000000191201', null, '[]'::jsonb,
        '{"kind":"cogs","bill_no":"G-NEW-A","bill_date":"2026-10-06","category":"COGS-Workspace","taxable":10000,"gst":1800,"itc":true,"pay":5000}'::jsonb);
  v_bill := r->'new_bill'->>'doc_id';
  insert into r1912_ids values ('A', v_bill);
  perform public.pay_vendor_bill(v_bill, 6800, '2026-10-07', 'bbbbbbbb-0000-0000-0000-000000191201', 'NEFT');
  select id into v_manual from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = v_bill and source = 'manual';
  if v_manual is null then raise exception 'A SETUP: Bills-page payment wrote no manual bank line'; end if;
  insert into r1912_ids values ('A-manual', v_manual::text);
  if (select paid_amount from public.vendor_bills where id = v_bill) <> 11800 then raise exception 'A SETUP: bill not paid in full'; end if;

  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000191201', false);
  set constraints all immediate;   -- the R-1577 "no orphan bank match" guards fire now, as at commit
  set constraints all deferred;

  select * into b from public.vendor_bills where id = v_bill;
  if not found then
    raise exception 'A FAIL (B7): Undo deleted bill % although ₹6,800 was paid on it from the Bills page — that bank line now points at a deleted bill', v_bill;
  end if;
  if b.paid_amount <> 6800 or b.status <> 'partial' then
    raise exception 'A FAIL: bill kept but paid % (%) — want 6800 partial (only the ₹5,000 of the undone line comes off)', b.paid_amount, b.status;
  end if;
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000191201';
  if t.matched_to_type is not null or exists (select 1 from public.bank_vendor_payment_lines where bank_txn_id = t.id) then
    raise exception 'A FAIL: undone line still matched (% / % rows)', t.matched_to_type, (select count(*) from public.bank_vendor_payment_lines where bank_txn_id = t.id);
  end if;
  if not exists (select 1 from public.bank_transactions where id = v_manual and matched_to_id = v_bill and debit = 6800) then
    raise exception 'A FAIL: the Bills-page ₹6,800 bank line changed';
  end if;
  perform pg_temp.r1912_books_ok(v_bill, 'A');
  select * into bs from public.report_balance_sheet('2026-10-31');
  if bs.payables is distinct from 5000 then raise exception 'A FAIL: payables % (want 5000 = 11,800 − 6,800)', bs.payables; end if;
  raise notice 'A PASS (B7): Undo kept bill % — paid ₹6,800 partial, ₹5,000 payable, no orphan bank line', v_bill;
end $$;

-- ── B. R-1911: real L2 ₹6,800 matches the Bills-page payment; Undo L2 puts it back ──
do $$
declare v_bill text := (select v from r1912_ids where k = 'A'); v_manual uuid := (select v::uuid from r1912_ids where k = 'A-manual');
        r jsonb; b public.vendor_bills; m public.bank_transactions;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191202','eeeeeeee-0000-0000-0000-000000191201', null,
        jsonb_build_array(jsonb_build_object('source','recorded_payment','doc_id',v_manual::text,'amount',6800)));
  if exists (select 1 from public.bank_transactions where id = v_manual) then raise exception 'B SETUP: manual line not replaced by the real line'; end if;
  if (select paid_amount from public.vendor_bills where id = v_bill) <> 6800 then raise exception 'B SETUP: match moved paid_amount'; end if;
  perform pg_temp.r1912_books_ok(v_bill, 'B-matched');

  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000191202', false);
  set constraints all immediate; set constraints all deferred;
  select * into m from public.bank_transactions where id = v_manual;
  if not found or m.matched_to_type is distinct from 'vendor_bill' or m.matched_to_id is distinct from v_bill or m.debit <> 6800 or m.source <> 'manual' then
    raise exception 'B FAIL: Undo of the match did not bring the Bills-page line back (found %, % %, ₹%)', found, m.matched_to_type, m.matched_to_id, m.debit;
  end if;
  select * into b from public.vendor_bills where id = v_bill;
  if b.paid_amount <> 6800 or b.status <> 'partial' then raise exception 'B FAIL: bill after undo % %', b.paid_amount, b.status; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000191202') is not null then
    raise exception 'B FAIL: L2 still matched'; end if;
  perform pg_temp.r1912_books_ok(v_bill, 'B');
  raise notice 'B PASS (R-1911 undo): Bills-page ₹6,800 line is back, bill still ₹6,800 paid';
end $$;

-- ── C. Other payment sits on a MATCHED real line; Undo the creating line keeps the bill ──
do $$
declare r jsonb; v_bill text; v_manual uuid; b public.vendor_bills;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191203','eeeeeeee-0000-0000-0000-000000191201', null, '[]'::jsonb,
        '{"kind":"cogs","bill_no":"G-NEW-C","bill_date":"2026-10-08","category":"COGS-Workspace","taxable":10000,"gst":1800,"itc":true,"pay":5000}'::jsonb);
  v_bill := r->'new_bill'->>'doc_id';
  perform public.pay_vendor_bill(v_bill, 6800, '2026-10-09', 'bbbbbbbb-0000-0000-0000-000000191201', 'NEFT');
  select id into v_manual from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = v_bill and source = 'manual';
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191204','eeeeeeee-0000-0000-0000-000000191201', null,
        jsonb_build_array(jsonb_build_object('source','recorded_payment','doc_id',v_manual::text,'amount',6800)));
  begin
    perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000191203', false);
    set constraints all immediate; set constraints all deferred;
  exception when others then
    raise exception 'C FAIL: Undo of the creating line failed: % (the bill has a ₹6,800 matched payment — it should stay, not block)', sqlerrm;
  end;
  select * into b from public.vendor_bills where id = v_bill;
  if not found then raise exception 'C FAIL: bill % deleted under a matched ₹6,800 bank payment', v_bill; end if;
  if b.paid_amount <> 6800 or b.status <> 'partial' then raise exception 'C FAIL: bill % %', b.paid_amount, b.status; end if;
  perform pg_temp.r1912_books_ok(v_bill, 'C');
  raise notice 'C PASS: matched ₹6,800 payment keeps the bill on Undo of the creating line';
end $$;

-- ── D. No other payment → the new bill still goes (unchanged) ────────────────
do $$
declare r jsonb; v_bill text;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191205','eeeeeeee-0000-0000-0000-000000191201', null, '[]'::jsonb,
        '{"kind":"cogs","bill_no":"G-NEW-D","bill_date":"2026-10-10","category":"COGS-Workspace","taxable":10000,"gst":1800,"itc":true,"pay":5000}'::jsonb);
  v_bill := r->'new_bill'->>'doc_id';
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000191205', false);
  set constraints all immediate; set constraints all deferred;
  if exists (select 1 from public.vendor_bills where id = v_bill) then
    raise exception 'D FAIL: bill % made by the undone line (no other payment) was left behind', v_bill;
  end if;
  raise notice 'D PASS: a new bill with no other payment is removed with its line';
end $$;

-- ── E. New bill put in an open payment run → stays on Undo (unpaid) ───────────
do $$
declare r jsonb; v_bill text; v_run uuid := gen_random_uuid(); b public.vendor_bills;
begin
  r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000191206','eeeeeeee-0000-0000-0000-000000191201', null, '[]'::jsonb,
        '{"kind":"cogs","bill_no":"G-NEW-E","bill_date":"2026-10-11","category":"COGS-Workspace","taxable":10000,"gst":1800,"itc":true,"pay":5000}'::jsonb);
  v_bill := r->'new_bill'->>'doc_id';
  insert into public.payment_runs (id, tenant_id, run_no, status, bank_account_id, created_by) values (v_run, 'dddddddd-0000-0000-0000-000000191201', 'PR-R1912', 'draft', 'bbbbbbbb-0000-0000-0000-000000191201', 'aaaaaaaa-0000-0000-0000-000000191201');
  insert into public.payment_run_items (tenant_id, run_id, source, doc_id, vendor_name, amount)
  values ('dddddddd-0000-0000-0000-000000191201', v_run, 'vendor_bill', v_bill, 'Google Cloud India', 6800);
  begin
    perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000191206', false);
  exception when others then
    raise exception 'E FAIL: Undo failed: % (the bill is in an open payment run — it should stay, unpaid)', sqlerrm;
  end;
  select * into b from public.vendor_bills where id = v_bill;
  if not found or b.paid_amount <> 0 or b.status <> 'unpaid' then
    raise exception 'E FAIL: bill in payment run after undo: found %, paid %, %', found, b.paid_amount, b.status;
  end if;
  perform pg_temp.r1912_books_ok(v_bill, 'E');
  raise notice 'E PASS: bill held in an open payment run stays, unpaid';
end $$;

rollback;
