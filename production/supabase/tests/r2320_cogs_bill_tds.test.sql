-- R-2320 (1 Nov 2026, p1, G-RECON): vendor TDS on COGS bill payments, and an owner override
-- below the threshold.
-- Staging money-out reconcile (31 Oct): Reconcile → Vendor → pay a COGS bill had no TDS
-- (194C/194J were refused on a goods bill — "194Q only"), so Zoho's 2% TDS (Google, Sidhshree)
-- stayed as amount due on the bill; and TDS the app thinks is below the threshold (Pankaj CA
-- ₹14,580, 194J) could not be taken though Zoho deducted it.
-- Migration: 20261101003429_r2320_cogs_bill_tds.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Existing COGS bill ₹11,800 (₹10,000 + GST), 194C 2% = ₹200, bank ₹11,600 → bill paid,
--      due 0; the line is matched ONCE (one leg: cash ₹11,600, TDS ₹200 194C, base ₹10,000,
--      tds_on = bank date); Balance Sheet: payables −11,800, TDS payable +200 — liabilities move
--      by exactly the ₹11,600 bank debit (balanced; the bank balance itself does not move). The same line cannot be booked twice.
--   B. New COGS bill recorded from Reconcile with 194C TDS → paid at cash + TDS, TDS payable up;
--      undo deletes the bill and takes the TDS back off.
--   C. Part payment: the bill's whole TDS goes with its FIRST part; a later part with TDS is
--      refused; TDS ≥ the amount settled / above the value before GST refused; 194Q on a
--      new COGS bill still refused.
--   D. Owner override: TDS with a typed reason — a non-owner is refused; a short reason is
--      refused; the owner's is accepted, the reason is on the TDS row and in the activity log.
--   E. Un-reconcile of A → bill unpaid again, TDS payable back to where it was.

begin;

create function pg_temp.r2320_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2320_supplier before insert on public.tenants for each row execute function pg_temp.r2320_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000232001','R2320 Co','r2320@example.in','07','R2320');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000232001','owner2320@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000232002','acct2320@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000232001','dddddddd-0000-0000-0000-000000232001','owner2320@example.in','Owner 2320','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000232002','dddddddd-0000-0000-0000-000000232001','acct2320@example.in','Accountant 2320','accountant', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000232001','dddddddd-0000-0000-0000-000000232001','HDFC Current','HDFC');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000232001','dddddddd-0000-0000-0000-000000232001','Google India Test','07AACCG2320A1Z5','AACCG2320A','COGS-Workspace'),
  ('eeeeeeee-0000-0000-0000-000000232002','dddddddd-0000-0000-0000-000000232001','Sidhshree Test','07AAKFS2320A1Z5','AAKFS2320A','COGS-Other'),
  ('eeeeeeee-0000-0000-0000-000000232003','dddddddd-0000-0000-0000-000000232001','Pankaj CA Test',null,'ABCPK2320A','Professional Services');

insert into public.vendor_bills (id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date, category, subtotal, cgst, sgst, igst, total, status, paid_amount) values
  ('BILL-R2320-G1','dddddddd-0000-0000-0000-000000232001','eeeeeeee-0000-0000-0000-000000232001','Google India Test','07AACCG2320A1Z5','G-2320-1','2026-10-01','2026-10-15','COGS-Workspace',10000,900,900,0,11800,'unpaid',0),
  ('BILL-R2320-S1','dddddddd-0000-0000-0000-000000232001','eeeeeeee-0000-0000-0000-000000232002','Sidhshree Test','07AAKFS2320A1Z5','S-2320-1','2026-10-02','2026-10-16','COGS-Other',20000,1800,1800,0,23600,'unpaid',0);
insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid) values
  ('EXP-R2320-P1','dddddddd-0000-0000-0000-000000232001','Professional Services','Pankaj CA Test','eeeeeeee-0000-0000-0000-000000232003','2026-10-03',16200,0,'none','PK-2320',false);

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000232001','dddddddd-0000-0000-0000-000000232001','bbbbbbbb-0000-0000-0000-000000232001','2026-10-10','NEFT GOOGLE INDIA',11600,0,'G1','csv_upload'),
  ('11111111-0000-0000-0000-000000232002','dddddddd-0000-0000-0000-000000232001','bbbbbbbb-0000-0000-0000-000000232001','2026-10-11','NEFT GOOGLE NEW BILL',58000,0,'G2','csv_upload'),
  ('11111111-0000-0000-0000-000000232003','dddddddd-0000-0000-0000-000000232001','bbbbbbbb-0000-0000-0000-000000232001','2026-10-12','NEFT SIDHSHREE PART',10000,0,'S1','csv_upload'),
  ('11111111-0000-0000-0000-000000232004','dddddddd-0000-0000-0000-000000232001','bbbbbbbb-0000-0000-0000-000000232001','2026-10-13','NEFT SIDHSHREE REST',13200,0,'S2','csv_upload'),
  ('11111111-0000-0000-0000-000000232005','dddddddd-0000-0000-0000-000000232001','bbbbbbbb-0000-0000-0000-000000232001','2026-10-14','NEFT PANKAJ CA',14580,0,'P1','csv_upload');

-- Owner 2320 signs in.
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000232001","role":"authenticated"}', true);

-- ── A. Existing COGS bill paid net of 194C ────────────────────────────────────────────────────
create temp table r2320_bs as
  select cash_and_bank, payables, dues_vendor_tds from public.report_balance_sheet('2026-10-31');

do $$
declare r jsonb; b public.vendor_bills; l public.bank_vendor_payment_lines; n int; t public.bank_transactions;
        s0 record; s1 record; o record; msg text;
begin
  select * into s0 from r2320_bs;
  begin
    r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232001','eeeeeeee-0000-0000-0000-000000232001', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R2320-G1","amount":11800,"tds_amount":200,"tds_section":"194C"}]'::jsonb);
  exception when others then
    raise exception 'A FAIL (owner path): COGS bill ₹11,800 paid ₹11,600 + 194C TDS ₹200 refused: %', sqlerrm;
  end;
  select * into b from public.vendor_bills where id = 'BILL-R2320-G1';
  if b.status <> 'paid' or b.paid_amount <> 11800 then raise exception 'A FAIL: bill status % paid_amount %', b.status, b.paid_amount; end if;
  select * into o from public.bank_debit_vendor_open_items('eeeeeeee-0000-0000-0000-000000232001') x where x.doc_id = 'BILL-R2320-G1';
  if found and o.amount_due <> 0 then raise exception 'A FAIL: bill still shows ₹% due', o.amount_due; end if;
  select count(*) into n from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000232001';
  select * into l from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000232001';
  if n <> 1 or l.kind <> 'bill' or l.cash <> 11600 or l.tds_amount <> 200 or l.tds_section is distinct from '194C'
     or l.tds_base is distinct from 10000 or l.tds_on is distinct from '2026-10-10'::date then
    raise exception 'A FAIL: legs % kind % cash % tds % sec % base % on %', n, l.kind, l.cash, l.tds_amount, l.tds_section, l.tds_base, l.tds_on;
  end if;
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000232001';
  if t.matched_to_type is distinct from 'vendor_payment' then raise exception 'A FAIL: line matched_to_type %', t.matched_to_type; end if;
  if (r->>'tds_total')::int <> 200 or r->>'tds_section' <> '194C' or (r->'paid'->0->>'still_due')::int <> 0 then
    raise exception 'A FAIL: result %', r;
  end if;
  select cash_and_bank, payables, dues_vendor_tds into s1 from public.report_balance_sheet('2026-10-31');
  if s1.dues_vendor_tds - s0.dues_vendor_tds <> 200 then raise exception 'A FAIL: TDS payable % → % (want +200)', s0.dues_vendor_tds, s1.dues_vendor_tds; end if;
  if s1.payables - s0.payables <> -11800 then raise exception 'A FAIL: payables % → % (want −11,800)', s0.payables, s1.payables; end if;
  -- The bank balance already holds the ₹11,600 debit (the line is in the feed before it is
  -- reconciled), so reconciling must move liabilities by exactly that money: payables −11,800,
  -- TDS payable +200 → −11,600 = the bank debit (balanced: debit side = credit side).
  if s1.cash_and_bank <> s0.cash_and_bank then raise exception 'A FAIL: reconciling moved the bank balance % → %', s0.cash_and_bank, s1.cash_and_bank; end if;
  if (s1.payables - s0.payables) + (s1.dues_vendor_tds - s0.dues_vendor_tds) <> -11600 then
    raise exception 'A FAIL: not balanced — liabilities moved % for a ₹11,600 bank debit', (s1.payables - s0.payables) + (s1.dues_vendor_tds - s0.dues_vendor_tds);
  end if;
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232001','eeeeeeee-0000-0000-0000-000000232001', null, '[]'::jsonb, null, 11600);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%already reconciled%' then raise exception 'A FAIL: same line booked twice (%)', msg; end if;
  raise notice 'A ok: COGS bill paid ₹11,600 + TDS ₹200 (194C) — due 0, matched once, TDS payable +200, balanced';
end $$;

-- ── B. New COGS bill from Reconcile with 194C TDS; undo ───────────────────────────────────────
do $$
declare r jsonb; b public.vendor_bills; l public.bank_vendor_payment_lines; v_id text; s0 bigint; s1 bigint; n int;
begin
  select dues_vendor_tds into s0 from public.report_balance_sheet('2026-10-31');
  begin
    r := public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232002','eeeeeeee-0000-0000-0000-000000232001', null, '[]'::jsonb,
      '{"kind":"cogs","bill_no":"G-2320-2","bill_date":"2026-10-09","category":"COGS-Workspace","taxable":50000,"gst":9000,"itc":true,"tds_amount":1000,"tds_section":"194C","pay":59000}'::jsonb);
  exception when others then
    raise exception 'B FAIL: new COGS bill ₹59,000 with 194C TDS ₹1,000 refused: %', sqlerrm;
  end;
  v_id := r->'new_bill'->>'doc_id';
  select * into b from public.vendor_bills where id = v_id;
  if b.status <> 'paid' or b.paid_amount <> 59000 or b.total <> 59000 then raise exception 'B FAIL: bill % % %', b.status, b.paid_amount, b.total; end if;
  select * into l from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000232002';
  if l.kind <> 'new_bill' or l.cash <> 58000 or l.tds_amount <> 1000 or l.tds_section is distinct from '194C' or l.tds_base is distinct from 50000
     or l.tds_on is distinct from '2026-10-11'::date then
    raise exception 'B FAIL: leg % cash % tds % sec % base % on %', l.kind, l.cash, l.tds_amount, l.tds_section, l.tds_base, l.tds_on;
  end if;
  if (r->'new_bill'->>'tds')::int <> 1000 or (r->'new_bill'->>'cash')::int <> 58000 or (r->'new_bill'->>'still_due')::int <> 0 then
    raise exception 'B FAIL: result %', r->'new_bill';
  end if;
  select dues_vendor_tds into s1 from public.report_balance_sheet('2026-10-31');
  if s1 - s0 <> 1000 then raise exception 'B FAIL: TDS payable % → % (want +1,000)', s0, s1; end if;
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000232002';
  select count(*) into n from public.vendor_bills where id = v_id;
  if n <> 0 then raise exception 'B FAIL: undo left the new bill behind'; end if;
  select dues_vendor_tds into s1 from public.report_balance_sheet('2026-10-31');
  if s1 <> s0 then raise exception 'B FAIL: TDS payable after undo % (want %)', s1, s0; end if;
  raise notice 'B ok: new COGS bill paid ₹58,000 + TDS ₹1,000 (194C); undo removes bill and TDS';
end $$;

-- ── C. Part payment and guards ────────────────────────────────────────────────────────────────
do $$
declare msg text; b public.vendor_bills; l public.bank_vendor_payment_lines;
begin
  -- TDS must be less than the amount settled
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232003','eeeeeeee-0000-0000-0000-000000232002', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R2320-S1","amount":10000,"tds_amount":10000,"tds_section":"194C"}]'::jsonb);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%must be less than%' then raise exception 'C FAIL: TDS = settled accepted (%)', msg; end if;
  -- TDS above the value before GST
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232003','eeeeeeee-0000-0000-0000-000000232002', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R2320-S1","amount":23600,"tds_amount":20001,"tds_section":"194C"}]'::jsonb, null, 0, null, 0);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if msg is null then raise exception 'C FAIL: TDS above the value before GST accepted'; end if;
  -- 194Q on a new COGS bill typed here: still refused (worked out on a saved bill)
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232003','eeeeeeee-0000-0000-0000-000000232002', null, '[]'::jsonb,
      '{"kind":"cogs","category":"COGS-Other","taxable":10010,"gst":0,"tds_amount":10,"tds_section":"194Q","pay":10010}'::jsonb);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%TDS on a COGS bill typed here%' then raise exception 'C FAIL: 194Q on a new COGS bill: %', msg; end if;

  -- first part: ₹10,000 cash + the bill's whole TDS ₹400 (2% of ₹20,000)
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232003','eeeeeeee-0000-0000-0000-000000232002', null,
    '[{"source":"vendor_bill","doc_id":"BILL-R2320-S1","amount":10400,"tds_amount":400,"tds_section":"194C"}]'::jsonb);
  select * into b from public.vendor_bills where id = 'BILL-R2320-S1';
  if b.status <> 'partial' or b.paid_amount <> 10400 then raise exception 'C FAIL: after first part % %', b.status, b.paid_amount; end if;
  -- a later part with TDS: refused
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232004','eeeeeeee-0000-0000-0000-000000232002', null,
      '[{"source":"vendor_bill","doc_id":"BILL-R2320-S1","amount":13200,"tds_amount":264,"tds_section":"194C"}]'::jsonb, null, 264);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%first payment%' then raise exception 'C FAIL: TDS on a later part: %', msg; end if;
  -- the rest without TDS
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232004','eeeeeeee-0000-0000-0000-000000232002', null,
    '[{"source":"vendor_bill","doc_id":"BILL-R2320-S1","amount":13200}]'::jsonb);
  select * into b from public.vendor_bills where id = 'BILL-R2320-S1';
  if b.status <> 'paid' or b.paid_amount <> 23600 then raise exception 'C FAIL: after the rest % %', b.status, b.paid_amount; end if;
  if (select sum(tds_amount) from public.bank_vendor_payment_lines where vendor_bill_id = 'BILL-R2320-S1') <> 400 then
    raise exception 'C FAIL: TDS on the bill is not ₹400 once'; end if;
  raise notice 'C ok: TDS with the first part only; bad TDS refused; 194Q on a new COGS bill still refused';
end $$;

-- ── D. Owner override below the threshold ─────────────────────────────────────────────────────
-- an accountant: refused
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000232002","role":"authenticated"}', true);
do $$
declare msg text;
begin
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232005','eeeeeeee-0000-0000-0000-000000232003', null,
      '[{"source":"expense","doc_id":"EXP-R2320-P1","amount":16200,"tds_amount":1620,"tds_section":"194J","tds_override_reason":"Deducted in Zoho, CA said so"}]'::jsonb);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%Only the owner%' then raise exception 'D FAIL: accountant override: %', msg; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000232005') is not null then
    raise exception 'D FAIL: refused override left the line reconciled'; end if;
  raise notice 'D1 ok: accountant cannot override the threshold';
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000232001","role":"authenticated"}', true);
do $$
declare msg text; l public.bank_vendor_payment_lines; e public.expenses; a record;
begin
  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232005','eeeeeeee-0000-0000-0000-000000232003', null,
      '[{"source":"expense","doc_id":"EXP-R2320-P1","amount":16200,"tds_amount":1620,"tds_section":"194J","tds_override_reason":"ok"}]'::jsonb);
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%reason%' then raise exception 'D FAIL: two-letter reason accepted (%)', msg; end if;

  begin
    perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000232005','eeeeeeee-0000-0000-0000-000000232003', null,
      '[{"source":"expense","doc_id":"EXP-R2320-P1","amount":16200,"tds_amount":1620,"tds_section":"194J","tds_override_reason":"Deducted in Zoho, CA said so"}]'::jsonb);
  exception when others then
    raise exception 'D FAIL: owner override refused: %', sqlerrm;
  end;
  select * into l from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000232005';
  if l.tds_amount <> 1620 or l.tds_override_reason is distinct from 'Deducted in Zoho, CA said so' then
    raise exception 'D FAIL: TDS row % reason %', l.tds_amount, l.tds_override_reason; end if;
  select * into e from public.expenses where id = 'EXP-R2320-P1';
  if not e.paid or e.tds_amount <> 1620 or e.tds_section <> '194J' then raise exception 'D FAIL: expense paid % tds % %', e.paid, e.tds_amount, e.tds_section; end if;
  select * into a from public.activity_log where tenant_id = 'dddddddd-0000-0000-0000-000000232001' and action = 'tds_override' order by created_at desc limit 1;
  if a is null or a.user_id <> 'aaaaaaaa-0000-0000-0000-000000232001' or a.changes->>'reason' <> 'Deducted in Zoho, CA said so'
     or (a.changes->>'tds_amount')::int <> 1620 or a.changes->>'tds_section' <> '194J' then
    raise exception 'D FAIL: activity log %', to_jsonb(a); end if;
  raise notice 'D ok: owner override with a reason — TDS ₹1,620 (194J) taken, reason on the row and in the activity log';
end $$;

-- ── E. Un-reconcile A ─────────────────────────────────────────────────────────────────────────
do $$
declare s0 bigint; s1 bigint; b public.vendor_bills;
begin
  select dues_vendor_tds into s0 from public.report_balance_sheet('2026-10-31');
  update public.bank_transactions set matched_to_type = null, matched_to_id = null where id = '11111111-0000-0000-0000-000000232001';
  select * into b from public.vendor_bills where id = 'BILL-R2320-G1';
  if b.status <> 'unpaid' or b.paid_amount <> 0 then raise exception 'E FAIL: bill % %', b.status, b.paid_amount; end if;
  select dues_vendor_tds into s1 from public.report_balance_sheet('2026-10-31');
  if s0 - s1 <> 200 then raise exception 'E FAIL: TDS payable % → % (want −200)', s0, s1; end if;
  raise notice 'E ok: un-reconcile → bill unpaid again, TDS payable −200';
end $$;

rollback;
