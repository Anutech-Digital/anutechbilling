-- R-2335 (1 Nov 2026, p2, G-RECON): Bills page → Pay takes the vendor's TDS too.
-- Owner's path: a COGS bill (₹10,000 + GST = ₹11,800) is paid from the Bills page with Zoho's
-- 2% 194C — ₹11,600 leaves the bank, ₹200 TDS is withheld; before R-2335 the Pay button had no
-- TDS, so ₹200 stayed due on the bill and TDS payable never showed it.
-- Migration: 20261101071500_r2335_pay_vendor_bill_tds.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Pay ₹11,600 + 194C TDS ₹200 → bill paid, due 0; the manual bank line is ₹11,600; ONE TDS
--      row (cash 0, ₹200, 194C, base ₹10,000, tds_on = paid date); Balance Sheet: bank −11,600,
--      payables −11,800, TDS payable +200 — balanced; vendor statement nets to 0 with no ₹0 row.
--   B. Guards (R-2320's rules): no section, TDS above the value before GST, cash + TDS above what
--      is owed — refused; TDS goes with the FIRST part only; the rest without TDS settles it.
--   C. 194Q stays R-1891's: refused while the company has not said it is above ₹10 crore.
--   D. Owner override below the threshold: an accountant / a short reason refused; the owner's
--      reason is kept on the row and in the activity log.
--   E. Reconcile (R-1911): a real bank line matched to the Bills-page payment carries its TDS
--      along (TDS payable unchanged); un-reconciling puts the manual line AND its TDS back.
--   F. The 5-argument call (no TDS) still works.

begin;

create function pg_temp.r2335_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2335_supplier before insert on public.tenants for each row execute function pg_temp.r2335_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000233501','R2335 Co','r2335@example.in','07','R2335');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000233501','owner2335@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000233502','acct2335@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000233501','dddddddd-0000-0000-0000-000000233501','owner2335@example.in','Owner 2335','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000233502','dddddddd-0000-0000-0000-000000233501','acct2335@example.in','Accountant 2335','accountant', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000233501','dddddddd-0000-0000-0000-000000233501','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category, default_tds_section) values
  ('eeeeeeee-0000-0000-0000-000000233501','dddddddd-0000-0000-0000-000000233501','Google India Test','07AACCG2335A1Z5','AACCG2335A','COGS-Workspace','194C'),
  ('eeeeeeee-0000-0000-0000-000000233502','dddddddd-0000-0000-0000-000000233501','Mehta Cloud Test','07AAKFM2335A1Z5','AAKFM2335A','COGS-Other','194C');

insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category, subtotal, cgst, sgst, igst, total, status, paid_amount) values
  ('BILL-R2335-G1','dddddddd-0000-0000-0000-000000233501','eeeeeeee-0000-0000-0000-000000233501','Google India Test','07AACCG2335A1Z5','G-2335-1','2026-10-01','2026-10-15','COGS-Workspace',10000,900,900,0,11800,'unpaid',0),
  ('BILL-R2335-M1','dddddddd-0000-0000-0000-000000233501','eeeeeeee-0000-0000-0000-000000233502','Mehta Cloud Test','07AAKFM2335A1Z5','M-2335-1','2026-10-02','2026-10-16','COGS-Other',20000,1800,1800,0,23600,'unpaid',0),
  ('BILL-R2335-M2','dddddddd-0000-0000-0000-000000233501','eeeeeeee-0000-0000-0000-000000233502','Mehta Cloud Test','07AAKFM2335A1Z5','M-2335-2','2026-10-03','2026-10-17','COGS-Other',5000,450,450,0,5900,'unpaid',0),
  ('BILL-R2335-M3','dddddddd-0000-0000-0000-000000233501','eeeeeeee-0000-0000-0000-000000233502','Mehta Cloud Test','07AAKFM2335A1Z5','M-2335-3','2026-10-04','2026-10-18','COGS-Other',1000,90,90,0,1180,'unpaid',0);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000233501','dddddddd-0000-0000-0000-000000233501','bbbbbbbb-0000-0000-0000-000000233501','2026-10-12','NEFT GOOGLE INDIA',11600,0,'G1','csv_upload');

-- Owner 2335 signs in.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000233501","role":"authenticated"}', true);

create temp table r2335_bs as
  select cash_and_bank, payables, dues_vendor_tds from public.report_balance_sheet('2026-10-31');

-- ── A. The owner's path: Bills → Pay with 194C TDS ───────────────────────────────────────────
do $$
declare b public.vendor_bills; l public.bank_vendor_payment_lines; t public.bank_transactions; n int;
        s0 record; s1 record; v_net bigint; v_zero int;
begin
  select * into s0 from r2335_bs;
  begin
    perform public.pay_vendor_bill('BILL-R2335-G1', 11600, '2026-10-10', 'bbbbbbbb-0000-0000-0000-000000233501', 'bank transfer', 200, '194C', null);
  exception when others then
    raise exception 'A FAIL (owner path): Bills → Pay ₹11,600 + 194C TDS ₹200 refused: %', sqlerrm;
  end;
  select * into b from public.vendor_bills where id = 'BILL-R2335-G1';
  if b.status <> 'paid' or b.paid_amount <> 11800 then raise exception 'A FAIL: bill status % paid % (want paid 11,800 — due 0)', b.status, b.paid_amount; end if;
  select count(*) into n from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = 'BILL-R2335-G1';
  select * into t from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = 'BILL-R2335-G1';
  if n <> 1 or t.debit <> 11600 or t.source <> 'manual' or t.txn_date <> '2026-10-10' then
    raise exception 'A FAIL: manual line count % debit % source % date %', n, t.debit, t.source, t.txn_date; end if;
  select count(*) into n from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R2335-G1';
  select * into l from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R2335-G1';
  if n <> 1 or l.bank_txn_id <> t.id or l.kind <> 'bill' or l.cash <> 0 or l.tds_amount <> 200 or l.tds_section is distinct from '194C'
     or l.tds_base <> 10000 or l.tds_on is distinct from '2026-10-10'::date or l.vendor_id is distinct from 'eeeeeeee-0000-0000-0000-000000233501'::uuid then
    raise exception 'A FAIL: TDS rows % txn % kind % cash % tds % sec % base % on % vendor %', n, l.bank_txn_id = t.id, l.kind, l.cash, l.tds_amount, l.tds_section, l.tds_base, l.tds_on, l.vendor_id;
  end if;
  -- the manual line's "Bill payment: …" text is not learned as the vendor's bank narration (R-1919)
  if exists (select 1 from public.vendor_narration_aliases a where a.tenant_id = 'dddddddd-0000-0000-0000-000000233501' and a.last_txn_id = t.id) then
    raise exception 'A FAIL: the Bills-page line taught a narration alias'; end if;
  select cash_and_bank, payables, dues_vendor_tds into s1 from public.report_balance_sheet('2026-10-31');
  if s1.dues_vendor_tds - s0.dues_vendor_tds <> 200 then raise exception 'A FAIL: TDS payable % → % (want +200)', s0.dues_vendor_tds, s1.dues_vendor_tds; end if;
  if s1.payables - s0.payables <> -11800 then raise exception 'A FAIL: payables % → % (want −11,800)', s0.payables, s1.payables; end if;
  if s1.cash_and_bank - s0.cash_and_bank <> -11600 then raise exception 'A FAIL: bank % → % (want −11,600)', s0.cash_and_bank, s1.cash_and_bank; end if;
  if (s1.cash_and_bank - s0.cash_and_bank) <> (s1.payables - s0.payables) + (s1.dues_vendor_tds - s0.dues_vendor_tds) then
    raise exception 'A FAIL: not balanced — assets moved %, liabilities %', s1.cash_and_bank - s0.cash_and_bank, (s1.payables - s0.payables) + (s1.dues_vendor_tds - s0.dues_vendor_tds);
  end if;
  select coalesce(sum(amount), 0), count(*) filter (where kind = 'payment' and amount = 0) into v_net, v_zero
    from public.vendor_statement('eeeeeeee-0000-0000-0000-000000233501');
  if v_net <> 0 or v_zero <> 0 then raise exception 'A FAIL: vendor statement nets % (want 0), ₹0 payment rows %', v_net, v_zero; end if;
  raise notice 'A ok: Bills → Pay ₹11,600 + TDS ₹200 (194C) — due 0, TDS payable +200, balanced, statement nets 0';
end $$;

-- ── B. Guards — R-2320's rules ────────────────────────────────────────────────────────────────
do $$
declare msg text; b public.vendor_bills;
begin
  begin
    perform public.pay_vendor_bill('BILL-R2335-M1', 10000, '2026-10-11', 'bbbbbbbb-0000-0000-0000-000000233501', null, 400, null, null);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%Pick the TDS section%' then raise exception 'B FAIL: TDS with no section: %', msg; end if;
  begin
    perform public.pay_vendor_bill('BILL-R2335-M1', 3000, '2026-10-11', 'bbbbbbbb-0000-0000-0000-000000233501', null, 20001, '194C', null);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%value before GST%' then raise exception 'B FAIL: TDS above the value before GST: %', msg; end if;
  begin
    perform public.pay_vendor_bill('BILL-R2335-M1', 23600, '2026-10-11', 'bbbbbbbb-0000-0000-0000-000000233501', null, 400, '194C', null);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%more than the ₹23600 still owed%' then raise exception 'B FAIL: cash + TDS above what is owed: %', msg; end if;
  -- first part: ₹10,000 cash + the bill's whole TDS ₹400
  perform public.pay_vendor_bill('BILL-R2335-M1', 10000, '2026-10-11', 'bbbbbbbb-0000-0000-0000-000000233501', null, 400, '194c', null);
  select * into b from public.vendor_bills where id = 'BILL-R2335-M1';
  if b.status <> 'partial' or b.paid_amount <> 10400 then raise exception 'B FAIL: after first part % %', b.status, b.paid_amount; end if;
  if (select tds_section from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R2335-M1') <> '194C' then
    raise exception 'B FAIL: section not upper-cased'; end if;
  begin
    perform public.pay_vendor_bill('BILL-R2335-M1', 12936, '2026-10-12', 'bbbbbbbb-0000-0000-0000-000000233501', null, 264, '194C', null);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%first payment%' then raise exception 'B FAIL: TDS on a later part: %', msg; end if;
  perform public.pay_vendor_bill('BILL-R2335-M1', 13200, '2026-10-12', 'bbbbbbbb-0000-0000-0000-000000233501', null, 0, null, null);
  select * into b from public.vendor_bills where id = 'BILL-R2335-M1';
  if b.status <> 'paid' or b.paid_amount <> 23600 then raise exception 'B FAIL: after the rest % %', b.status, b.paid_amount; end if;
  if (select sum(tds_amount) from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R2335-M1') <> 400 then
    raise exception 'B FAIL: TDS on the bill is not ₹400 once'; end if;
  raise notice 'B ok: no section / above value before GST / above what is owed refused; TDS with the first part only';
end $$;

-- ── C. 194Q stays R-1891's ────────────────────────────────────────────────────────────────────
do $$
declare msg text;
begin
  begin
    perform public.pay_vendor_bill('BILL-R2335-M2', 5000, '2026-10-13', 'bbbbbbbb-0000-0000-0000-000000233501', null, 5, '194Q', null);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%above ₹10 crore%' then raise exception 'C FAIL: 194Q without the ₹10 crore answer: %', msg; end if;
  raise notice 'C ok: 194Q refused while the company is not a 194Q buyer';
end $$;

-- ── D. Owner override below the threshold ─────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000233502","role":"authenticated"}', true);
do $$
declare msg text;
begin
  begin
    perform public.pay_vendor_bill('BILL-R2335-M2', 5800, '2026-10-13', 'bbbbbbbb-0000-0000-0000-000000233501', null, 100, '194C', 'Deducted in Zoho');
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%Only the owner%' then raise exception 'D FAIL: accountant override: %', msg; end if;
  raise notice 'D ok (1/2): an accountant cannot take TDS below the threshold';
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000233501","role":"authenticated"}', true);
do $$
declare msg text; l public.bank_vendor_payment_lines; a public.activity_log; b public.vendor_bills;
begin
  begin
    perform public.pay_vendor_bill('BILL-R2335-M2', 5800, '2026-10-13', 'bbbbbbbb-0000-0000-0000-000000233501', null, 100, '194C', 'ok');
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%at least 5 letters%' then raise exception 'D FAIL: short reason: %', msg; end if;
  perform public.pay_vendor_bill('BILL-R2335-M2', 5800, '2026-10-13', 'bbbbbbbb-0000-0000-0000-000000233501', null, 100, '194C', 'Deducted in Zoho, CA said so');
  select * into b from public.vendor_bills where id = 'BILL-R2335-M2';
  if b.status <> 'paid' or b.paid_amount <> 5900 then raise exception 'D FAIL: bill % %', b.status, b.paid_amount; end if;
  select * into l from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R2335-M2';
  if l.tds_amount <> 100 or l.tds_override_reason is distinct from 'Deducted in Zoho, CA said so' then
    raise exception 'D FAIL: TDS row % reason %', l.tds_amount, l.tds_override_reason; end if;
  select * into a from public.activity_log where tenant_id = 'dddddddd-0000-0000-0000-000000233501' and action = 'tds_override' order by created_at desc limit 1;
  if a is null or a.user_id <> 'aaaaaaaa-0000-0000-0000-000000233501' or a.entity_id <> 'BILL-R2335-M2'
     or a.changes->>'reason' <> 'Deducted in Zoho, CA said so' or (a.changes->>'tds_amount')::int <> 100 then
    raise exception 'D FAIL: activity log %', to_jsonb(a); end if;
  raise notice 'D ok (2/2): owner override with a reason — TDS ₹100 taken, reason on the row and in the activity log';
end $$;

-- ── E. Reconcile the Bills-page payment (R-1911), then un-reconcile ───────────────────────────
do $$
declare v_syn uuid; r jsonb; l public.bank_vendor_payment_lines; b public.vendor_bills; t public.bank_transactions; s0 bigint; s1 bigint; n int;
begin
  select id into v_syn from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = 'BILL-R2335-G1';
  select dues_vendor_tds into s0 from public.report_balance_sheet('2026-10-31');
  begin
    r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000233501','eeeeeeee-0000-0000-0000-000000233501', null,
      jsonb_build_array(jsonb_build_object('source', 'recorded_payment', 'doc_id', v_syn::text, 'amount', 11600)));
  exception when others then
    raise exception 'E FAIL: matching the bank line to the Bills-page payment with TDS refused: %', sqlerrm;
  end;
  if exists (select 1 from public.bank_transactions where id = v_syn) then raise exception 'E FAIL: manual line still there'; end if;
  select * into l from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R2335-G1' and kind = 'bill';
  if l.bank_txn_id <> '11111111-0000-0000-0000-000000233501' or l.tds_amount <> 200 or l.prev->>'tds_from_txn' <> v_syn::text then
    raise exception 'E FAIL: TDS row txn % tds % prev %', l.bank_txn_id, l.tds_amount, l.prev; end if;
  select * into b from public.vendor_bills where id = 'BILL-R2335-G1';
  if b.status <> 'paid' or b.paid_amount <> 11800 then raise exception 'E FAIL: bill after match % %', b.status, b.paid_amount; end if;
  select dues_vendor_tds into s1 from public.report_balance_sheet('2026-10-31');
  if s1 <> s0 then raise exception 'E FAIL: TDS payable moved on match % → %', s0, s1; end if;
  select count(*) into n from public.vendor_statement('eeeeeeee-0000-0000-0000-000000233501') where kind = 'tds';
  if n <> 1 then raise exception 'E FAIL: vendor statement TDS rows % (want 1)', n; end if;

  -- un-reconcile: the manual line and its TDS row come back; the bill stays paid
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000233501';
  select * into t from public.bank_transactions where id = v_syn;
  if t.id is null or t.matched_to_type <> 'vendor_bill' or t.debit <> 11600 then raise exception 'E FAIL: manual line not restored'; end if;
  select * into l from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R2335-G1' and kind = 'bill';
  if l.bank_txn_id <> v_syn or l.prev is not null or l.tds_amount <> 200 then
    raise exception 'E FAIL: TDS row after undo txn % prev %', l.bank_txn_id, l.prev; end if;
  select * into b from public.vendor_bills where id = 'BILL-R2335-G1';
  if b.status <> 'paid' or b.paid_amount <> 11800 then raise exception 'E FAIL: bill after undo % %', b.status, b.paid_amount; end if;
  select dues_vendor_tds into s1 from public.report_balance_sheet('2026-10-31');
  if s1 <> s0 then raise exception 'E FAIL: TDS payable after undo % → %', s0, s1; end if;
  raise notice 'E ok: matched in Reconcile, TDS moves with it; un-reconcile restores the manual line and its TDS';
end $$;

-- ── F. The 5-argument call still pays without TDS ─────────────────────────────────────────────
do $$
declare b public.vendor_bills;
begin
  perform public.pay_vendor_bill('BILL-R2335-M3', 1180, '2026-10-14', 'bbbbbbbb-0000-0000-0000-000000233501', 'upi');
  select * into b from public.vendor_bills where id = 'BILL-R2335-M3';
  if b.status <> 'paid' or b.paid_amount <> 1180 then raise exception 'F FAIL: % %', b.status, b.paid_amount; end if;
  if exists (select 1 from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R2335-M3') then raise exception 'F FAIL: a TDS row with no TDS'; end if;
  raise notice 'F ok: 5-argument pay_vendor_bill unchanged';
end $$;

rollback;
