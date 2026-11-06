-- R-2528 (6 Nov 2026, p1 paisa, G-RECON; review follow-ups of R-2522 by rv-r2522): moving a bank
-- account's opening EARLIER from a statement — only real paise rounding is taken as rounding, the
-- preview's rule and this one agree, and the import batch must be this account's.
-- Migration 20261106*_r2528_bank_opening_rounding.
-- Self-asserting, ONE transaction, rolled back. Run on a LOCAL DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. SUBHVISION (staging HDFC 4523, FY 25-26) sent as the app sends it — whole rupees plus each
--      line's paise (amount_paise / balance_paise): matches without an override; the paise are
--      stored; today's balance moves −₹2 (rounding_drift −2) — the three .50 amounts rounded up
--      and 1,000.47 down, in whole rupees.
--   B. 51 lines (48+) with a ₹17.70 SMS-charge line LEFT OUT (its balances include it): refused
--      without the override (+₹18) — R-2522 took it as rounding (within least(26, 25)).
--   C. The owner can still accept it with a reason; an accountant cannot (42501), even with one.
--   D. A line dated AFTER the old date whose value date EQUALS the old date is a line of that
--      day: not counted (refused −₹200) — the preview now says the same (opening-move.ts).
--   E. A batch id that is not this account's: another account of the same company, another
--      company's — refused (hint r2528_batch_not_this_account); an unknown id too.
--   F. A line sent without paise is whole rupees: the same statement sent in rupees only is ₹2
--      off the bank's balance — refused (lines already in the app, whose paise are not known,
--      allow ₹1 at most: opening-move-r2528.test.ts).
--   G. Paise that do not round to the line's rupees are not trusted (stored as rupees × 100).

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
  ('dddddddd-0000-0000-0000-000000252801','R2528 Co','r2528@example.in','07','R2528'),
  ('dddddddd-0000-0000-0000-000000252802','R2528 Other','r2528b@example.in','07','R2528B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000252801','owner2528@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000252802','acct2528@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000252803','other2528@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000252801','dddddddd-0000-0000-0000-000000252801','owner2528@example.in','Owner 2528','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000252802','dddddddd-0000-0000-0000-000000252801','acct2528@example.in','Accountant 2528','accountant', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000252803','dddddddd-0000-0000-0000-000000252802','other2528@example.in','Other 2528','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000252801','dddddddd-0000-0000-0000-000000252801','HDFC 4523','HDFC','current', 903552, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252802','dddddddd-0000-0000-0000-000000252801','SMS missing','ICICI','current', 9472, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252803','dddddddd-0000-0000-0000-000000252801','SMS accept','ICICI','current', 9472, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252804','dddddddd-0000-0000-0000-000000252801','Value = old','SBI','current', 1000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252805','dddddddd-0000-0000-0000-000000252801','Batch target','Axis','current', 1000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252806','dddddddd-0000-0000-0000-000000252801','Batch owner','Axis','current', 0, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252807','dddddddd-0000-0000-0000-000000252801','No paise','Kotak','current', 903552, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252808','dddddddd-0000-0000-0000-000000252801','Bad paise','Yes','current', 1000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000252809','dddddddd-0000-0000-0000-000000252802','Other co','HDFC','current', 0, '2026-04-01');
insert into public.bank_import_batches (id, tenant_id, bank_account_id, file_name, source) values
  ('cccccccc-0000-0000-0000-000000252806','dddddddd-0000-0000-0000-000000252801','bbbbbbbb-0000-0000-0000-000000252806','mar.csv','csv'),
  ('cccccccc-0000-0000-0000-000000252809','dddddddd-0000-0000-0000-000000252802','bbbbbbbb-0000-0000-0000-000000252809','mar.csv','csv');
-- every account already has money after its opening date (a line in April)
insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, balance_after, reference, source)
select 'dddddddd-0000-0000-0000-000000252801', a.id, '2026-04-10', 'NEFT IN', 0, 100, null, 'APR' || right(a.id::text, 2), 'csv_upload'
  from public.bank_accounts a where a.tenant_id = 'dddddddd-0000-0000-0000-000000252801' and a.opening_balance <> 0;
-- the other accounts' batches hold a March line each
insert into public.bank_transactions (tenant_id, bank_account_id, txn_date, description, debit, credit, balance_after, reference, source, import_batch_id) values
  ('dddddddd-0000-0000-0000-000000252801','bbbbbbbb-0000-0000-0000-000000252806','2026-03-15','IN',0,200,200,'B6','csv_upload','cccccccc-0000-0000-0000-000000252806'),
  ('dddddddd-0000-0000-0000-000000252802','bbbbbbbb-0000-0000-0000-000000252809','2026-03-15','IN',0,200,200,'B9','csv_upload','cccccccc-0000-0000-0000-000000252809');

create function pg_temp.r2528_sms_rows() returns jsonb language sql as $f$
  -- 50 × ₹10 fees, then the ₹17.70 SMS charge (LEFT OUT of the file), then a ₹10 fee on 31 Mar:
  -- ₹10,000.00 → ₹9,472.30 by the bank's balances.
  select jsonb_agg(x order by o) from (
    select g as o, jsonb_build_object('txn_date', '2025-06-01', 'description', 'FEE ' || g, 'debit', 10, 'credit', 0,
                                      'balance_after', 10000 - 10 * g, 'reference', 'S' || g) as x
      from generate_series(1, 50) g
    union all
    select 51, '{"txn_date":"2026-03-31","description":"FEE LAST","debit":10,"credit":0,"balance_after":9472,"balance_paise":947230,"reference":"SZ"}'::jsonb
  ) s;
$f$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252801","role":"authenticated"}', true);

-- ── A. SUBHVISION with its paise: matches, paise stored, drift −2 ─────────────────────────
do $$
declare j jsonb; np bigint; bp bigint; d bigint;
begin
  j := public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252801',
    '[{"txn_date":"2025-04-10","description":"RTGS OUT","debit":500001,"credit":0,"amount_paise":50000050,"balance_after":1520918,"balance_paise":152091846,"reference":"F1"},
      {"txn_date":"2025-11-21","description":"FD BOOKED","debit":655237,"credit":0,"amount_paise":65523650,"balance_after":865682,"balance_paise":86568196,"reference":"F2"},
      {"txn_date":"2026-03-31","description":"NEFT IN","debit":0,"credit":1000,"amount_paise":100047,"balance_after":866682,"balance_paise":86668243,"reference":"F3"},
      {"txn_date":"2026-03-31","description":"BANK CHARGES","debit":301,"credit":0,"amount_paise":30050,"balance_after":866382,"balance_paise":86638193,"reference":"F4"},
      {"txn_date":"2026-04-01","value_date":"2026-03-31","description":"NEFT CR-SUBHVISION","debit":0,"credit":37170,"balance_after":903552,"balance_paise":90355193,"reference":"IN42609055612841"}]'::jsonb,
    'fy2526.xls', 'xlsx', 2020919, '2025-04-01', false, null);
  if (j -> 'opening' ->> 'difference')::bigint <> 0 or (j -> 'opening' ->> 'balance_on_old_date')::bigint <> 903552 then
    raise exception 'FAIL A1: SUBHVISION refused or off (%)', j -> 'opening';
  end if;
  select net_paise, balance_after_paise into np, bp from public.bank_transactions where reference = 'F1';
  if np is distinct from -50000050 or bp is distinct from 152091846 then raise exception 'FAIL A2: paise not stored (%, %)', np, bp; end if;
  select net_paise into np from public.bank_transactions where reference = 'IN42609055612841';
  if np is distinct from 3717000 then raise exception 'FAIL A3: whole-rupee line net_paise % (expected 3717000)', np; end if;
  select rounding_drift into d from public.bank_opening_history where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252801';
  if d is distinct from -2 then raise exception 'FAIL A4: rounding_drift % (expected -2)', d; end if;
end $$;

-- ── B. 48+ lines missing a ₹17.70 line: refused without the override ──────────────────────
do $$
declare ok boolean := false; msg text;
begin
  begin
    perform public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252802', pg_temp.r2528_sms_rows(),
      'fy.csv', 'csv', 10000, '2025-04-01', false, null);
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    ok := msg like '%difference ₹+18%';
  end;
  if not ok then raise exception 'FAIL B: a statement missing a ₹17.70 line was taken as rounding (got %)', msg; end if;
end $$;

-- ── C. Override: the owner with a reason yes; an accountant no ────────────────────────────
do $$
declare j jsonb; ok boolean := false;
begin
  j := public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252803', pg_temp.r2528_sms_rows(),
    'fy.csv', 'csv', 10000, '2025-04-01', true, 'SMS charge 17.70 on 30 Sep missing from the export');
  if (j -> 'opening' ->> 'difference')::bigint <> 18 then raise exception 'FAIL C1: owner override result %', j -> 'opening'; end if;
  if not exists (select 1 from public.bank_opening_history where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252803'
                  and accepted_difference and accepted_reason like 'SMS charge%' and rounding_drift is null) then
    raise exception 'FAIL C2: history does not keep the accepted difference + reason';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252802","role":"authenticated"}', true);
  begin
    perform public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252802', pg_temp.r2528_sms_rows(),
      'fy.csv', 'csv', 10000, '2025-04-01', true, 'Accountant says it is fine');
  exception when insufficient_privilege then ok := true;
  end;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252801","role":"authenticated"}', true);
  if not ok then raise exception 'FAIL C3: an accountant accepted a difference'; end if;
  if exists (select 1 from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252802' and reference = 'SZ') then
    raise exception 'FAIL C4: the refused import left lines behind';
  end if;
end $$;

-- ── D. Value date = the old date (line dated after it): a line of that day, not counted ───
do $$
declare ok boolean := false; msg text;
begin
  begin
    perform public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252804',
      '[{"txn_date":"2026-03-10","description":"IN","debit":0,"credit":300,"balance_after":800,"reference":"V1"},
        {"txn_date":"2026-04-02","value_date":"2026-04-01","description":"LATE","debit":0,"credit":200,"balance_after":1000,"reference":"V2"}]'::jsonb,
      'mar.csv', 'csv', 500, '2026-03-01', false, null);
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    ok := msg like '%difference ₹-200%';
  end;
  if not ok then raise exception 'FAIL D: a line value-dated ON the old date was counted before it (got %)', msg; end if;
end $$;

-- ── E. The batch must be this account's ───────────────────────────────────────────────────
do $$
declare ok boolean; hint text; b uuid;
begin
  foreach b in array array['cccccccc-0000-0000-0000-000000252806', 'cccccccc-0000-0000-0000-000000252809',
                           'cccccccc-0000-0000-0000-0000002528ff']::uuid[] loop
    ok := false; hint := null;
    begin
      perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000252805', 800, '2026-03-01', b, false, null);
    exception when others then
      get stacked diagnostics hint = pg_exception_hint;
      ok := hint = 'r2528_batch_not_this_account';
    end;
    if not ok then raise exception 'FAIL E: batch % of another account/company was trusted (hint %)', b, hint; end if;
  end loop;
  if exists (select 1 from public.bank_opening_history where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000252805') then
    raise exception 'FAIL E2: a refused call wrote history';
  end if;
end $$;

-- ── F. No paise sent = whole rupees: the ₹2 gap is refused ──────────────────────────────────
do $$
declare ok boolean := false; msg text;
begin
  begin
    perform public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252807',
      '[{"txn_date":"2025-04-10","description":"RTGS OUT","debit":500001,"credit":0,"balance_after":1520918,"reference":"N1"},
        {"txn_date":"2025-11-21","description":"FD BOOKED","debit":655237,"credit":0,"balance_after":865682,"reference":"N2"},
        {"txn_date":"2026-03-31","description":"NEFT IN","debit":0,"credit":1000,"balance_after":866682,"reference":"N3"},
        {"txn_date":"2026-03-31","description":"BANK CHARGES","debit":301,"credit":0,"balance_after":866382,"reference":"N4"},
        {"txn_date":"2026-04-01","value_date":"2026-03-31","description":"NEFT CR-SUBHVISION","debit":0,"credit":37170,"balance_after":903552,"reference":"N5"}]'::jsonb,
      'fy2526.xls', 'xlsx', 2020919, '2025-04-01', false, null);
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    ok := msg like '%difference ₹-2%';
  end;
  if not ok then raise exception 'FAIL F: whole-rupee lines ₹2 off the bank''s balance were taken as rounding (got %)', msg; end if;
end $$;

-- ── G. Paise that do not round to the line's rupees are not trusted ───────────────────────
do $$
declare j jsonb; np bigint; bp bigint;
begin
  j := public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000252808',
    '[{"txn_date":"2026-03-10","description":"IN","debit":0,"credit":200,"amount_paise":99999,"balance_after":1000,"balance_paise":1,"reference":"G1"}]'::jsonb,
    'mar.csv', 'csv', 800, '2026-03-01', false, null);
  select net_paise, balance_after_paise into np, bp from public.bank_transactions where reference = 'G1';
  if np is distinct from 20000 or bp is distinct from 100000 then raise exception 'FAIL G: untrusted paise stored (%, %)', np, bp; end if;
end $$;

select 'R-2528 bank opening rounding / batch: all checks passed' as result;

rollback;
