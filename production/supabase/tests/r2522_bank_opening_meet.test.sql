-- R-2522 (6 Nov 2026, p1 paisa, G-RECON): moving a bank account's opening EARLIER from a
-- statement is compared where the statement MEETS the existing data; an accepted difference needs
-- the owner's reason.
-- Migration 20261106084500_r2522_bank_opening_meet.
-- Self-asserting, ONE transaction, rolled back. Run on a LOCAL DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- The real case (staging HDFC 4523, FY 25-26 statement): its last line SUBHVISION NEFT ₹37,170
-- is dated 01/04/26 with value date 31/03/26; HDFC counts it in the 31 Mar 2026 closing
-- ₹9,03,551.93 = the account's 1 Apr 2026 opening ₹9,03,552. The fixture keeps that shape: a
-- 20,20,918.96 start, paise amounts (rounded to rupees they sum ₹2 short of the bank's balance),
-- the 31 Mar lines and SUBHVISION last. R-2497 said −₹37,172 and refused.
--
-- Proves:
--   A. SUBHVISION shape: imported with the opening, no refusal, difference 0, balance on the old
--      date = the bank's 9,03,552; SUBHVISION's value date stored.
--   B. Same statement with a line missing (an AI read that dropped it): refused.
--   C. Value date: a new line dated the day AFTER the old opening whose value date is before it
--      counts; the same line without a value date does not (refused).
--   D. A line the app already has on the old opening date is existing data — not counted.
--   E. A manual line already in the app between the new and old dates is counted (real case:
--      "EMI 1 Thar Roxx" ₹27,764 on 3 Mar 2026 next to the bank's EMI ₹30,183 on 5 Mar) — refused
--      with the difference −27,764.
--   F. Accepting a difference: no reason → refused (hint r2522_reason_needed), also through the
--      old 5-argument call; with a reason → history keeps it.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000252201','R2522 Co','r2522@example.in','07','R2522');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000252201','owner2522@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000252201','dddddddd-0000-0000-0000-000000252201','owner2522@example.in','Owner 2522','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000252201','dddddddd-0000-0000-0000-000000252201','HDFC 4523','HDFC','current', 903552, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252202','dddddddd-0000-0000-0000-000000252201','HDFC copy','HDFC','current', 903552, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252203','dddddddd-0000-0000-0000-000000252201','Value date','ICICI','current', 1000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252204','dddddddd-0000-0000-0000-000000252201','No value date','ICICI','current', 1000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252205','dddddddd-0000-0000-0000-000000252201','Dup on old date','SBI','current', 1000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252206','dddddddd-0000-0000-0000-000000252201','Thar EMI','Axis','current', 10000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252207','dddddddd-0000-0000-0000-000000252201','Reason','Kotak','current', 1000, '2026-04-01');
insert into public.bank_import_batches (id, tenant_id, bank_account_id, file_name, source) values
  ('cccccccc-0000-0000-0000-000000252201','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252201','apr-oct.xls','xlsx'),
  ('cccccccc-0000-0000-0000-000000252205','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252205','apr.csv','csv');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, balance_after, reference, source, import_batch_id) values
  -- already in the app: the Apr–Oct statement's first line (starts from 9,03,551.93)
  ('22222222-0000-0000-0000-000000252201','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252201','2026-04-01','UPI OUT',5000,0,898552,'A1','csv_upload','cccccccc-0000-0000-0000-000000252201'),
  ('22222222-0000-0000-0000-000000252202','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252202','2026-04-01','UPI OUT',5000,0,898552,'A1','csv_upload',null),
  ('22222222-0000-0000-0000-000000252203','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252203','2026-04-05','NEFT IN',0,100,1100,'V1','csv_upload',null),
  ('22222222-0000-0000-0000-000000252204','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252204','2026-04-05','NEFT IN',0,100,1100,'V1','csv_upload',null),
  -- D: the app already has a line ON the old opening date (from the April statement)
  ('22222222-0000-0000-0000-000000252205','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252205','2026-04-01','NEFT IN',0,50,1050,'D1','csv_upload','cccccccc-0000-0000-0000-000000252205'),
  -- E: a hand-entered EMI inside the old opening's period
  ('22222222-0000-0000-0000-000000252206','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252206','2026-03-03','EMI 1 Thar Roxx',27764,0,null,null,'manual',null),
  ('22222222-0000-0000-0000-000000252207','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252206','2026-04-10','NEFT IN',0,100,null,'E0','csv_upload',null),
  ('22222222-0000-0000-0000-000000252208','dddddddd-0000-0000-0000-000000252201','bbbbbbbb-0000-0000-0000-000000252207','2026-04-10','NEFT IN',0,100,null,'R0','csv_upload',null);

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252201","role":"authenticated"}', true);

-- ── A. The SUBHVISION shape is accepted without an override ───────────────────────────────
do $$
declare j jsonb; v bigint; vd date;
begin
  j := public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252201',
    '[{"txn_date":"2025-04-10","description":"RTGS OUT","debit":500001,"credit":0,"balance_after":1520918,"reference":"F1"},
      {"txn_date":"2025-11-21","description":"FD BOOKED","debit":655237,"credit":0,"balance_after":865682,"reference":"F2"},
      {"txn_date":"2026-03-31","description":"NEFT IN","debit":0,"credit":1000,"balance_after":866682,"reference":"F3"},
      {"txn_date":"2026-03-31","description":"BANK CHARGES","debit":301,"credit":0,"balance_after":866382,"reference":"F4"},
      {"txn_date":"2026-04-01","value_date":"2026-03-31","description":"NEFT CR-SUBHVISION","debit":0,"credit":37170,"balance_after":903552,"reference":"IN42609055612841"}]'::jsonb,
    'fy2526.xls', 'xlsx', 2020919, '2025-04-01', false, null);
  if (j -> 'opening' ->> 'difference')::bigint <> 0 or (j -> 'opening' ->> 'balance_on_old_date')::bigint <> 903552 then
    raise exception 'FAIL A1: opening result % (expected balance_on_old_date 903552, difference 0 — SUBHVISION is in the 31 Mar closing)', j -> 'opening';
  end if;
  select value_date into vd from public.bank_transactions where reference = 'IN42609055612841';
  if vd is distinct from '2026-03-31'::date then raise exception 'FAIL A2: value date % not stored', vd; end if;
  v := public.bank_account_current_balance('bbbbbbbb-0000-0000-0000-000000252201');
  -- 20,20,919 + Σ rounded FY amounts (−11,17,369) − 5,000: ₹2 below 8,98,552 = paise rounding of the amounts
  if v <> 898550 then raise exception 'FAIL A3: balance % (expected 898550)', v; end if;
end $$;

-- ── B. A line missing from the statement is still refused ─────────────────────────────────
do $$
declare ok boolean := false; msg text;
begin
  begin
    perform public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252202',
      '[{"txn_date":"2025-04-10","description":"RTGS OUT","debit":500001,"credit":0,"balance_after":1520918,"reference":"F1"},
        {"txn_date":"2026-03-31","description":"NEFT IN","debit":0,"credit":1000,"balance_after":866682,"reference":"F3"},
        {"txn_date":"2026-03-31","description":"BANK CHARGES","debit":301,"credit":0,"balance_after":866382,"reference":"F4"},
        {"txn_date":"2026-04-01","value_date":"2026-03-31","description":"NEFT CR-SUBHVISION","debit":0,"credit":37170,"balance_after":903552,"reference":"S2"}]'::jsonb,
      'fy2526.xls', 'xlsx', 2020919, '2025-04-01', false, null);
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    ok := msg like '%difference ₹+6,55,235%';
  end;
  if not ok then raise exception 'FAIL B: a statement missing a ₹6,55,237 line (₹6,55,235 after rounding) was not refused with that difference (got %)', msg; end if;
end $$;

-- ── C. Value date ─────────────────────────────────────────────────────────────────────────
do $$
declare j jsonb; ok boolean := false;
begin
  j := public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252203',
    '[{"txn_date":"2026-03-10","description":"IN","debit":0,"credit":300,"balance_after":800,"reference":"V2"},
      {"txn_date":"2026-04-02","value_date":"2026-03-31","description":"LATE POSTED","debit":0,"credit":200,"balance_after":1000,"reference":"V3"}]'::jsonb,
    'mar.csv', 'csv', 500, '2026-03-01', false, null);
  if (j -> 'opening' ->> 'difference')::bigint <> 0 then
    raise exception 'FAIL C1: with value date 31 Mar the 2 Apr line meets the 1 Apr opening (%)', j -> 'opening';
  end if;
  begin
    perform public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252204',
      '[{"txn_date":"2026-03-10","description":"IN","debit":0,"credit":300,"balance_after":800,"reference":"V2"},
        {"txn_date":"2026-04-02","description":"LATE POSTED","debit":0,"credit":200,"balance_after":1000,"reference":"V3"}]'::jsonb,
      'mar.csv', 'csv', 500, '2026-03-01', false, null);
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL C2: without a value date a line after the old opening date was counted'; end if;
end $$;

-- ── D. A line the app already has on the old date is existing data ─────────────────────────
do $$
declare j jsonb;
begin
  j := public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252205',
    '[{"txn_date":"2026-03-15","description":"IN","debit":0,"credit":200,"balance_after":1000,"reference":"D2"}]'::jsonb,
    'mar.csv', 'csv', 800, '2026-03-01', false, null);
  if (j -> 'opening' ->> 'difference')::bigint <> 0 or (j -> 'opening' ->> 'balance_on_old_date')::bigint <> 1000 then
    raise exception 'FAIL D: the 1 Apr line already in the app was counted before the opening (%)', j -> 'opening';
  end if;
end $$;

-- ── E. A manual line between the dates is counted (the server and the preview agree) ───────
do $$
declare ok boolean := false; msg text;
begin
  begin
    perform public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252206',
      '[{"txn_date":"2026-03-05","description":"EMI THAR","debit":30183,"credit":0,"balance_after":10000,"reference":"E1"}]'::jsonb,
      'mar.csv', 'csv', 40183, '2026-03-01', false, null);
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    ok := msg like '%difference ₹-27,764%';
  end;
  if not ok then raise exception 'FAIL E: the manual EMI line was not counted (got %)', msg; end if;
end $$;

-- ── F. Accepting a difference needs a reason ──────────────────────────────────────────────
do $$
declare ok boolean := false; hint text; h record;
begin
  begin
    perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000252207', 500, '2026-03-01', null, true, '  ');
  exception when invalid_parameter_value then
    get stacked diagnostics hint = pg_exception_hint;
    ok := hint = 'r2522_reason_needed';
  end;
  if not ok then raise exception 'FAIL F1: a blank reason was accepted'; end if;
  ok := false;
  begin
    perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000252207', 500, '2026-03-01', null, true);
  exception when invalid_parameter_value then ok := true;
  end;
  if not ok then raise exception 'FAIL F2: the old 5-argument call accepted a difference without a reason'; end if;
  perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000252207', 500, '2026-03-01', null, true,
                                                'Bank charges reversed later — passbook checked');
  select * into h from public.bank_opening_history where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252207';
  if not h.accepted_difference or h.difference <> -500 or h.accepted_reason <> 'Bank charges reversed later — passbook checked' then
    raise exception 'FAIL F3: history row % (expected the reason kept)', row_to_json(h);
  end if;
end $$;

select 'R-2522 bank opening meeting point: all checks passed' as result;

rollback;
