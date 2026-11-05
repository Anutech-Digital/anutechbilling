-- R-2497 (5 Nov 2026, p0 money, G-FY2526): a bank account's balance counts only lines dated
-- on/after its opening date; a past-dated Balance Sheet leaves out later bank lines; moving the
-- opening from a statement keeps today's balance (or is refused / accepted by the owner) and
-- leaves a history row.
-- Migration 20261105071119_r2497_bank_opening_date.
-- Self-asserting, ONE transaction, rolled back. Run on a LOCAL DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Owner example (a company's current account): opening ₹1,00,000 as of 1 Apr 2026, a May
-- 2026 credit of ₹50,000 (today's balance ₹1,50,000). The FY 25-26 statement is imported:
-- opening ₹70,000 on 1 Apr 2025 and a year of lines netting +₹30,000 (so it ends FY 25-26 at
-- ₹1,00,000 — the old opening).
--
-- Proves:
--   A. Lines before the opening date are NOT counted: balance stays 1,50,000 after the import.
--   B. Balance Sheet as of a past date: 31 Mar 2026 → 1,00,000 (the opening), 30 Apr 2026 →
--      1,00,000 (May's line left out), 31 Dec 2025 → 0 (before the account's books start).
--   C. Moving the opening to 1 Apr 2025 with ₹70,000 (statement agrees): balance still
--      1,50,000; BS 31 Mar 2026 → 1,00,000, 31 Mar 2025 → 70,000; history row old/new.
--   D. Statement that does NOT agree (₹60,000): refused with the figures (hint
--      r2497_opening_mismatch), nothing changed, no history row.
--   E. An accountant cannot accept the difference; the owner can → history accepted_difference.
--   F. A fresh account (opening 0, no lines before this import) takes the statement's opening.
--   G. Account form edit leaves an 'edit' history row.
--   H. Books lock: a move into the locked period is refused.
--   I. Tenant isolation: the other company cannot read the balance, move the opening or see
--      the history; a signed-in user cannot write history rows.
--   J. Lines before the old opening are not "money to keep": a fresh account takes the opening
--      later without a batch id.
--   K. import_bank_statement_with_opening: a refused opening leaves no lines / batch behind;
--      an agreeing one imports and moves together.
--   L. Close at ₹0 uses the same balance (a line before the opening is not counted).
--   M. A receipt received by the report date but banked after it is undeposited then.

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
  ('dddddddd-0000-0000-0000-000000249701','R2497 Co','r2497@example.in','07','R2497'),
  ('dddddddd-0000-0000-0000-000000249702','R2497 Other','r2497b@example.in','07','R2497B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000249701','owner2497@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000249702','owner2497b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000249703','acct2497@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000249701','dddddddd-0000-0000-0000-000000249701','owner2497@example.in','Owner 2497','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000249702','dddddddd-0000-0000-0000-000000249702','owner2497b@example.in','Owner 2497B','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000249703','dddddddd-0000-0000-0000-000000249701','acct2497@example.in','Accountant 2497','accountant', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000249701','dddddddd-0000-0000-0000-000000249701','HDFC Current','HDFC','current', 100000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000249702','dddddddd-0000-0000-0000-000000249701','ICICI 1111','ICICI','current', 100000, '2026-04-01'),
  ('bbbbbbbb-0000-0000-0000-000000249703','dddddddd-0000-0000-0000-000000249701','New SBI','SBI','current', 0, '2026-11-01'),
  ('bbbbbbbb-0000-0000-0000-000000249704','dddddddd-0000-0000-0000-000000249702','Other HDFC','HDFC','current', 5000, '2026-04-01');
insert into public.bank_import_batches (id, tenant_id, bank_account_id, file_name, source) values
  ('cccccccc-0000-0000-0000-000000249701','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249701','fy2526.csv','csv'),
  ('cccccccc-0000-0000-0000-000000249702','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249702','fy2526.csv','csv'),
  ('cccccccc-0000-0000-0000-000000249703','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249703','new.csv','csv');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source, import_batch_id) values
  -- FY 26-27, already in the account (counted under the 1 Apr 2026 opening)
  ('22222222-0000-0000-0000-000000249701','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249701','2026-05-10','NEFT CUSTOMER',0,50000,'M1','csv_upload',null),
  -- the FY 25-26 statement (net +30,000 → 70,000 on 1 Apr 2025 ends at 1,00,000)
  ('22222222-0000-0000-0000-000000249702','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249701','2025-04-15','NEFT IN',0,80000,'F1','csv_upload','cccccccc-0000-0000-0000-000000249701'),
  ('22222222-0000-0000-0000-000000249703','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249701','2025-10-01','RENT',50000,0,'F2','csv_upload','cccccccc-0000-0000-0000-000000249701'),
  -- ICICI: same shape (net +30,000), its own FY 26-27 line
  ('22222222-0000-0000-0000-000000249704','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249702','2026-06-01','NEFT IN',0,10000,'I0','csv_upload',null),
  ('22222222-0000-0000-0000-000000249705','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249702','2025-06-01','NEFT IN',0,30000,'I1','csv_upload','cccccccc-0000-0000-0000-000000249702'),
  -- New SBI: only this import's lines
  ('22222222-0000-0000-0000-000000249706','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249703','2026-10-05','NEFT IN',0,2000,'S1','csv_upload','cccccccc-0000-0000-0000-000000249703'),
  -- the other company
  ('22222222-0000-0000-0000-000000249707','dddddddd-0000-0000-0000-000000249702','bbbbbbbb-0000-0000-0000-000000249704','2025-05-05','OTHER',0,9000,'O1','csv_upload',null);

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000249701","role":"authenticated"}', true);

-- ── A + B. Before moving the opening ──────────────────────────────────────────────────────
do $$
declare v bigint; r record;
begin
  v := public.bank_account_current_balance('bbbbbbbb-0000-0000-0000-000000249701');
  if v <> 150000 then
    raise exception 'FAIL A: balance % (expected 150000 — FY 25-26 lines are inside the 1 Apr 2026 opening, not counted again)', v;
  end if;

  select * into r from public.report_balance_sheet('2026-03-31');
  -- HDFC 1,00,000 + ICICI 1,00,000 + New SBI 0 (before its books start)
  if r.cash_and_bank <> 200000 then
    raise exception 'FAIL B1: BS 31 Mar 2026 cash % (expected 200000 — each opening, no FY 25-26 lines, nothing after)', r.cash_and_bank;
  end if;
  select * into r from public.report_balance_sheet('2026-04-30');
  if r.cash_and_bank <> 200000 then
    raise exception 'FAIL B2: BS 30 Apr 2026 cash % (expected 200000 — the May / June lines come after)', r.cash_and_bank;
  end if;
  select * into r from public.report_balance_sheet('2025-12-31');
  if r.cash_and_bank <> 0 then
    raise exception 'FAIL B3: BS 31 Dec 2025 cash % (expected 0 — before every account''s books start)', r.cash_and_bank;
  end if;
  select * into r from public.report_balance_sheet('2026-12-31');
  if r.cash_and_bank <> 150000 + 110000 + 0 then
    raise exception 'FAIL B4: BS 31 Dec 2026 cash % (expected 260000)', r.cash_and_bank;
  end if;
end $$;

-- ── C. Move HDFC's opening to 1 Apr 2025 (the statement agrees) ───────────────────────────
do $$
declare j jsonb; v bigint; r record; h record;
begin
  j := public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000249701', 70000, '2025-04-01',
                                             'cccccccc-0000-0000-0000-000000249701', false);
  if (j ->> 'balance_on_old_date')::bigint <> 100000 or (j ->> 'difference')::bigint <> 0 then
    raise exception 'FAIL C1: result % (expected balance_on_old_date 100000, difference 0)', j;
  end if;
  v := public.bank_account_current_balance('bbbbbbbb-0000-0000-0000-000000249701');
  if v <> 150000 then
    raise exception 'FAIL C2: balance % after the move (expected 150000 — today''s balance unchanged)', v;
  end if;
  select * into r from public.report_balance_sheet('2026-03-31');
  if r.cash_and_bank <> 200000 then
    raise exception 'FAIL C3: BS 31 Mar 2026 cash % (expected 200000)', r.cash_and_bank;
  end if;
  select * into r from public.report_balance_sheet('2025-03-31');
  if r.cash_and_bank <> 70000 then
    raise exception 'FAIL C4: BS 31 Mar 2025 cash % (expected 70000 — the new opening)', r.cash_and_bank;
  end if;
  select * into h from public.bank_opening_history where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000249701';
  if h.old_balance <> 100000 or h.old_date <> '2026-04-01' or h.new_balance <> 70000 or h.new_date <> '2025-04-01'
     or h.source <> 'statement' or h.accepted_difference or h.changed_by <> 'aaaaaaaa-0000-0000-0000-000000249701' then
    raise exception 'FAIL C5: history row % wrong', row_to_json(h);
  end if;
  if (select count(*) from public.bank_opening_history where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000249701') <> 1 then
    raise exception 'FAIL C6: expected exactly one history row (the trigger must not add a second)';
  end if;
end $$;

-- ── D. A statement that does not agree is refused ─────────────────────────────────────────
do $$
declare ok boolean := false; msg text; hint text;
begin
  begin
    perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000249702', 60000, '2025-04-01',
                                                  'cccccccc-0000-0000-0000-000000249702', false);
  exception when check_violation then
    get stacked diagnostics msg = message_text, hint = pg_exception_hint;
    ok := hint = 'r2497_opening_mismatch' and msg like '%start of 01 Apr 2026 is ₹90,000%' and msg like '%opening on that date is ₹1,00,000%';
  end;
  if not ok then raise exception 'FAIL D1: mismatch not refused with the figures (got %)', msg; end if;
  if (select opening_balance from public.bank_accounts where id = 'bbbbbbbb-0000-0000-0000-000000249702') <> 100000 then
    raise exception 'FAIL D2: opening changed although refused';
  end if;
  if exists (select 1 from public.bank_opening_history where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000249702') then
    raise exception 'FAIL D3: history row written although refused';
  end if;
end $$;

-- ── E. Accountant cannot accept; owner can ────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000249703","role":"authenticated"}', true);
do $$
declare ok boolean := false;
begin
  begin
    perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000249702', 60000, '2025-04-01',
                                                  'cccccccc-0000-0000-0000-000000249702', true);
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FAIL E1: an accountant accepted a statement mismatch'; end if;
end $$;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000249701","role":"authenticated"}', true);
do $$
declare h record; v bigint;
begin
  perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000249702', 60000, '2025-04-01',
                                                'cccccccc-0000-0000-0000-000000249702', true);
  select * into h from public.bank_opening_history where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000249702';
  if not h.accepted_difference or h.difference <> -10000 or h.balance_on_old_date <> 90000 then
    raise exception 'FAIL E2: accepted history row % wrong', row_to_json(h);
  end if;
  v := public.bank_account_current_balance('bbbbbbbb-0000-0000-0000-000000249702');
  if v <> 100000 then
    raise exception 'FAIL E3: balance % (expected 60000 + 30000 + 10000 = 100000)', v;
  end if;
end $$;

-- ── F. A fresh account takes the statement's opening (nothing to keep) ────────────────────
do $$
declare v bigint;
begin
  perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000249703', 12345, '2026-10-01',
                                                'cccccccc-0000-0000-0000-000000249703', false);
  v := public.bank_account_current_balance('bbbbbbbb-0000-0000-0000-000000249703');
  if v <> 14345 then raise exception 'FAIL F: balance % (expected 12345 + 2000)', v; end if;
end $$;

-- ── G. Account form edit → 'edit' history row ─────────────────────────────────────────────
update public.bank_accounts set opening_balance = 13000 where id = 'bbbbbbbb-0000-0000-0000-000000249703';
do $$
begin
  if not exists (select 1 from public.bank_opening_history
                  where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000249703' and source = 'edit'
                    and old_balance = 12345 and new_balance = 13000) then
    raise exception 'FAIL G: an edit of the opening left no history row';
  end if;
end $$;

-- ── H. Books lock ─────────────────────────────────────────────────────────────────────────
update public.tenants set books_locked_until = '2026-03-31' where id = 'dddddddd-0000-0000-0000-000000249701';
do $$
declare ok boolean := false; msg text;
begin
  begin
    perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000249703', 0, '2026-01-01', null, true);
  exception when check_violation then
    get stacked diagnostics msg = message_text;
    ok := msg like '%locked up to 31 Mar 2026%Month-end close%';
  end;
  if not ok then raise exception 'FAIL H: a move into the locked period was not refused (got %)', msg; end if;
end $$;
update public.tenants set books_locked_until = null where id = 'dddddddd-0000-0000-0000-000000249701';

-- ── J. Fresh account, earlier statement imported with the tick OFF, opening set later ─────
-- (no batch: the lines are duplicates on the second try). They are before the opening date, so
-- not in today's balance — nothing to keep; the statement's opening is taken without a check.
select set_config('request.jwt.claims', '', true);
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('bbbbbbbb-0000-0000-0000-000000249705','dddddddd-0000-0000-0000-000000249701','Kotak new','Kotak','current', 0, '2026-11-01'),
  ('bbbbbbbb-0000-0000-0000-000000249706','dddddddd-0000-0000-0000-000000249701','Old FD','HDFC','fixed_deposit', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('22222222-0000-0000-0000-000000249708','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249705','2026-06-01','NEFT IN',0,7000,'K1','csv_upload'),
  ('22222222-0000-0000-0000-000000249709','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249706','2025-09-01','FD IN',0,500,'Z1','csv_upload');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000249701","role":"authenticated"}', true);
do $$
declare j jsonb; v bigint;
begin
  j := public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000249705', 40000, '2026-04-01', null, false);
  if j ->> 'difference' is not null then
    raise exception 'FAIL J1: lines before the old opening were treated as money to keep (%)', j;
  end if;
  v := public.bank_account_current_balance('bbbbbbbb-0000-0000-0000-000000249705');
  if v <> 47000 then raise exception 'FAIL J2: balance % (expected 40000 + 7000)', v; end if;
end $$;

-- ── K. Import + opening in one transaction: a refused opening leaves no lines behind ──────
do $$
declare ok boolean := false; n_before int; n_after int; j jsonb; v bigint;
begin
  select count(*) into n_before from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000249701';
  begin
    -- HDFC now opens 70,000 on 1 Apr 2025; a "statement" claiming 1,000 on 1 Apr 2024 with one
    -- +5,000 line does not reach 70,000 by then → refused, and its line must not stay.
    perform public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000249701',
      '[{"txn_date":"2024-06-01","description":"FY24 IN","debit":0,"credit":5000,"balance_after":6000,"reference":"Y1"}]'::jsonb,
      'fy2425.csv', 'csv', 1000, '2024-04-01', false);
  exception when check_violation then ok := true;
  end;
  if not ok then raise exception 'FAIL K1: a mismatching opening was not refused'; end if;
  select count(*) into n_after from public.bank_transactions where bank_account_id = 'bbbbbbbb-0000-0000-0000-000000249701';
  if n_after <> n_before or exists (select 1 from public.bank_import_batches where file_name = 'fy2425.csv') then
    raise exception 'FAIL K2: the refused import left lines/batch behind (% → %)', n_before, n_after;
  end if;
  -- agreeing statement: 65,000 on 1 Apr 2024 + 5,000 = 70,000 at the start of 1 Apr 2025
  j := public.import_bank_statement_with_opening('bbbbbbbb-0000-0000-0000-000000249701',
      '[{"txn_date":"2024-06-01","description":"FY24 IN","debit":0,"credit":5000,"balance_after":70000,"reference":"Y1"}]'::jsonb,
      'fy2425.csv', 'csv', 65000, '2024-04-01', false);
  if (j -> 'opening' ->> 'difference')::bigint <> 0 or (j ->> 'inserted')::int <> 1 then
    raise exception 'FAIL K3: result %', j;
  end if;
  v := public.bank_account_current_balance('bbbbbbbb-0000-0000-0000-000000249701');
  if v <> 150000 then raise exception 'FAIL K4: balance % (expected 150000 — unchanged)', v; end if;
end $$;

-- ── L. Close at ₹0 uses the same balance (a line before the opening is not counted) ───────
do $$
begin
  update public.bank_accounts set is_active = false where id = 'bbbbbbbb-0000-0000-0000-000000249706';
  if (select is_active from public.bank_accounts where id = 'bbbbbbbb-0000-0000-0000-000000249706') then
    raise exception 'FAIL L: account not closed';
  end if;
exception when check_violation then
  raise exception 'FAIL L: close refused although the page shows ₹0 (%)', sqlerrm;
end $$;

-- ── M. Received by the report date, banked after it → undeposited then, not lost ──────────
select set_config('request.jwt.claims', '', true);
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-0000002497c1','dddddddd-0000-0000-0000-000000249701','Acme 2497','07','acme2497.in');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, discount_pct, tax_rate,
                           status, payment_status, billing_cycle, line_items, is_one_off, created_date)
values ('Q-2497-1', 'dddddddd-0000-0000-0000-000000249701', 'cccccccc-0000-0000-0000-0000002497c1', 'Acme 2497',
        50000, 42373, 0, 18, 'accepted', 'awaiting', 'yearly',
        jsonb_build_array(jsonb_build_object('name', 'Service', 'qty', 1, 'rate', 42373, 'one_time', true)), true, '2026-03-20');
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at) values
  ('eeeeeeee-0000-0000-0000-000000249701','dddddddd-0000-0000-0000-000000249701', 'Q-2497-1', 'cccccccc-0000-0000-0000-0000002497c1',
   50000, 'upi', 'received', '2026-03-30 10:00+05:30', now());
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source, matched_to_type, matched_to_id) values
  ('22222222-0000-0000-0000-000000249710','dddddddd-0000-0000-0000-000000249701','bbbbbbbb-0000-0000-0000-000000249702','2026-04-02','NEFT CUST',0,50000,'P1','csv_upload','payment','eeeeeeee-0000-0000-0000-000000249701');
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000249701","role":"authenticated"}', true);
do $$
declare r record;
begin
  select * into r from public.report_balance_sheet('2026-03-31');
  if r.undeposited_funds <> 50000 then
    raise exception 'FAIL M1: 31 Mar undeposited % (expected 50000 — received 30 Mar, banked 2 Apr)', r.undeposited_funds;
  end if;
  select * into r from public.report_balance_sheet('2026-04-30');
  if r.undeposited_funds <> 0 then
    raise exception 'FAIL M2: 30 Apr undeposited % (expected 0 — banked by then, in cash)', r.undeposited_funds;
  end if;
end $$;

-- ── I. Tenant isolation ───────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000249702","role":"authenticated"}', true);
set local role authenticated;
do $$
declare ok boolean := false; v bigint;
begin
  v := public.bank_account_current_balance('bbbbbbbb-0000-0000-0000-000000249701');
  if v <> 0 then raise exception 'FAIL I1: other company read the balance %', v; end if;
  v := public.bank_account_current_balance('bbbbbbbb-0000-0000-0000-000000249704');
  if v <> 5000 then raise exception 'FAIL I2: own balance % (expected 5000 — the 2025 line is before its opening)', v; end if;
  begin
    perform public.set_bank_opening_from_statement('bbbbbbbb-0000-0000-0000-000000249701', 1, '2025-04-01', null, true);
  exception when no_data_found then ok := true;
  end;
  if not ok then raise exception 'FAIL I3: other company moved the opening'; end if;
  if exists (select 1 from public.bank_opening_history) then
    raise exception 'FAIL I4: other company sees history rows';
  end if;
  ok := false;
  begin
    insert into public.bank_opening_history (tenant_id, bank_account_id, new_balance, new_date)
    values ('dddddddd-0000-0000-0000-000000249702', 'bbbbbbbb-0000-0000-0000-000000249704', 1, '2026-01-01');
  exception when insufficient_privilege then ok := true;
  end;
  if not ok then raise exception 'FAIL I5: a signed-in user wrote a history row'; end if;
end $$;
reset role;

select 'R-2497 bank opening date: all checks passed' as result;

rollback;
