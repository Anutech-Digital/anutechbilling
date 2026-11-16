-- R-2674 (11 Nov 2026): Balance Sheet — loans given / staff loans due back within 12 months are
-- CURRENT assets. Migration 20261111201800_r2674_loans_current_split (on R-544 loans_given, R-2340 EMI
-- plan, R-1584 books lock).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
-- Balance Sheet date in every case: 31 Mar 2026 → the 12 months end on 31 Mar 2027.
--
-- Proves:
--   A.  One-date loans: due 31 Dec 2026 → current; due 1 Apr 2027 → non-current; overdue with a part
--       repaid → what is left is current.
--   B.  24 monthly instalments of ₹2,40,010 from 30 Apr 2026, ₹25,000 already repaid: the 12 parts due
--       by 30 Mar 2027 less the ₹25,000 = ₹95,000 current; the rest (incl. the ₹10 rounding) non-current.
--   C.  EMI loan given ₹1,20,000 @ 12%, EMI ₹10,662 × 12 from 5 May 2026: receipts 1–11 current
--       (₹1,09,446), the 12th (5 Apr 2027, ₹10,554) non-current — the app schedule's own rupees.
--   D.  No due date: not answered → non-current + counted "undecided"; Yes → current; No → non-current;
--       Loans given total (loans_given_asset) the same before and after every change.
--   D2. A choice on a loan WITH a due date is refused.   D3. The same answer twice → one log row.
--   D4. Books locked past the loan's date → the choice is still saved (presentation only).
--   E.  Fully repaid loan → 0. Over-repaid books → current never above the Balance Sheet total.
--   E2. A repayment removed (un-reconciled receipt) → its principal is back in the current part.
--   F.  Staff: a loan is current by default, No → non-current; salary advance always current and a
--       choice on it is refused; staff total unchanged.
--   G.  Sales user: choice refused, totals 0, no per-loan rows. Manager: totals yes, per-loan rows no,
--       choice refused. Another company's loan → "not found"; the other company's figures never move.

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
  ('dddddddd-0000-0000-0000-000000267401','R2674 Co','r2674@example.in','07','R2674'),
  ('dddddddd-0000-0000-0000-000000267402','R2674 Other','r2674b@example.in','07','R2674B'),
  ('dddddddd-0000-0000-0000-000000267403','R2674 Over','r2674c@example.in','07','R2674C');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000267401','owner2674@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000267402','sales2674@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000267403','manager2674@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000267404','acct2674@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000267405','owner2674b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000267406','owner2674c@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000267401','dddddddd-0000-0000-0000-000000267401','owner2674@example.in','Owner 2674','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000267402','dddddddd-0000-0000-0000-000000267401','sales2674@example.in','Sales 2674','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000267403','dddddddd-0000-0000-0000-000000267401','manager2674@example.in','Manager 2674','manager', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000267404','dddddddd-0000-0000-0000-000000267401','acct2674@example.in','Accountant 2674','accountant', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000267405','dddddddd-0000-0000-0000-000000267402','owner2674b@example.in','Owner 2674 B','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000267406','dddddddd-0000-0000-0000-000000267403','owner2674c@example.in','Owner 2674 C','owner', now() - interval '1 day');

-- Loans given, company 1 (ids end in the case letter).
insert into public.loans_given (id, tenant_id, borrower_name, principal, given_on, interest_rate, repayment_plan, due_on, instalments, emi_amount) values
  ('11111111-0000-0000-0000-0000002674a1','dddddddd-0000-0000-0000-000000267401','A1 due this year',   100000,'2025-06-01', 0,'one_shot',   '2026-12-31', null, null),
  ('11111111-0000-0000-0000-0000002674a2','dddddddd-0000-0000-0000-000000267401','A2 due after a year', 200000,'2025-06-01', 0,'one_shot',   '2027-04-01', null, null),
  ('11111111-0000-0000-0000-0000002674a3','dddddddd-0000-0000-0000-000000267401','A3 overdue',           50000,'2025-06-01', 0,'one_shot',   '2026-01-15', null, null),
  ('11111111-0000-0000-0000-0000002674b1','dddddddd-0000-0000-0000-000000267401','B1 instalments',      240010,'2025-06-01', 0,'instalments','2026-04-30', 24,   null),
  ('11111111-0000-0000-0000-0000002674c1','dddddddd-0000-0000-0000-000000267401','C1 emi',              120000,'2025-06-01',12,'emi',        '2026-05-05', 12,   10662),
  ('11111111-0000-0000-0000-0000002674d1','dddddddd-0000-0000-0000-000000267401','D1 no date',          300000,'2025-06-01', 0,'one_shot',   null,         null, null),
  ('11111111-0000-0000-0000-0000002674e1','dddddddd-0000-0000-0000-000000267401','E1 repaid',            40000,'2025-06-01', 0,'one_shot',   '2026-06-30', null, null);
insert into public.loan_repayments (id, tenant_id, loan_id, repaid_on, amount, principal_part, interest_part) values
  ('33333333-0000-0000-0000-0000002674a3','dddddddd-0000-0000-0000-000000267401','11111111-0000-0000-0000-0000002674a3','2025-12-01',20000,20000,0),
  ('33333333-0000-0000-0000-0000002674b1','dddddddd-0000-0000-0000-000000267401','11111111-0000-0000-0000-0000002674b1','2026-02-01',25000,25000,0),
  ('33333333-0000-0000-0000-0000002674e1','dddddddd-0000-0000-0000-000000267401','11111111-0000-0000-0000-0000002674e1','2026-02-01',40000,40000,0);
-- Company 2: one loan with no date, never answered.
insert into public.loans_given (id, tenant_id, borrower_name, principal, given_on, repayment_plan) values
  ('11111111-0000-0000-0000-0000002674f2','dddddddd-0000-0000-0000-000000267402','Other co loan', 70000,'2025-06-01','one_shot');
-- Company 3: over-repaid books — X ₹10,000 (no date, answered Yes) + Y ₹5,000 repaid ₹12,000 → total ₹3,000.
insert into public.loans_given (id, tenant_id, borrower_name, principal, given_on, repayment_plan, due_on, due_within_12m) values
  ('11111111-0000-0000-0000-0000002674f3','dddddddd-0000-0000-0000-000000267403','X', 10000,'2025-06-01','one_shot', null, true),
  ('11111111-0000-0000-0000-0000002674f4','dddddddd-0000-0000-0000-000000267403','Y',  5000,'2025-06-01','one_shot', '2030-01-01', null);
insert into public.loan_repayments (tenant_id, loan_id, repaid_on, amount, principal_part, interest_part) values
  ('dddddddd-0000-0000-0000-000000267403','11111111-0000-0000-0000-0000002674f4','2026-01-01',12000,12000,0);

-- Staff, company 1: loan ₹8,00,000 (₹1,00,000 back) + salary advance ₹20,000.
insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on, kind) values
  ('44444444-0000-0000-0000-000000267401','dddddddd-0000-0000-0000-000000267401','Staff One', 800000,'2025-07-01','loan'),
  ('44444444-0000-0000-0000-000000267402','dddddddd-0000-0000-0000-000000267401','Staff Two',  20000,'2026-03-01','salary_advance');
insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method) values
  ('dddddddd-0000-0000-0000-000000267401','44444444-0000-0000-0000-000000267401',100000,'2026-01-31','salary_deduction');

create function pg_temp.split(k text) returns bigint language sql as
  $f$ select (public.loans_current_split('2026-03-31') ->> k)::bigint $f$;
create function pg_temp.part(p_loan uuid) returns integer language sql as
  $f$ select current_part from public.loans_given_current_parts('2026-03-31') where loan_id = p_loan $f$;
create function pg_temp.refused(p_kind text, p_loan uuid, p_val boolean, p_like text, p_case text) returns void language plpgsql as $f$
begin
  begin
    perform public.set_loan_due_within_12m(p_kind, p_loan, p_val);
    raise exception 'FAIL % : accepted', p_case;
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like p_like then raise exception 'FAIL % : wrong refusal: %', p_case, sqlerrm; end if;
  end;
end $f$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000267401","role":"authenticated"}', true);

-- ── A, B, C, E: the schedule decides ────────────────────────────────────────────────────────
do $$
begin
  if pg_temp.part('11111111-0000-0000-0000-0000002674a1') <> 100000 then raise exception 'FAIL A1: % not 100000', pg_temp.part('11111111-0000-0000-0000-0000002674a1'); end if;
  if pg_temp.part('11111111-0000-0000-0000-0000002674a2') <> 0      then raise exception 'FAIL A2: % not 0', pg_temp.part('11111111-0000-0000-0000-0000002674a2'); end if;
  if pg_temp.part('11111111-0000-0000-0000-0000002674a3') <> 30000  then raise exception 'FAIL A3: % not 30000', pg_temp.part('11111111-0000-0000-0000-0000002674a3'); end if;
  if pg_temp.part('11111111-0000-0000-0000-0000002674b1') <> 95000  then raise exception 'FAIL B: % not 95000', pg_temp.part('11111111-0000-0000-0000-0000002674b1'); end if;
  if pg_temp.part('11111111-0000-0000-0000-0000002674c1') <> 109446 then raise exception 'FAIL C: % not 109446', pg_temp.part('11111111-0000-0000-0000-0000002674c1'); end if;
  if pg_temp.part('11111111-0000-0000-0000-0000002674e1') <> 0      then raise exception 'FAIL E: repaid loan % not 0', pg_temp.part('11111111-0000-0000-0000-0000002674e1'); end if;
  -- the date boundary: due exactly on BS date + 12 months is current, one day later is not
  if public.loan_given_current_principal(1000, 'one_shot', '2027-03-31', null, null, 0, 0, null, '2026-03-31') <> 1000
     or public.loan_given_current_principal(1000, 'one_shot', '2027-04-01', null, null, 0, 0, null, '2026-03-31') <> 0 then
    raise exception 'FAIL A: 12-month boundary';
  end if;
  -- instalments: the last part carries the rounding (₹100 in 3 → 33, 33, 34), all due → 100
  if public.loan_given_current_principal(100, 'instalments', '2026-04-30', 3, null, 0, 0, null, '2026-03-31') <> 100
     or public.loan_given_current_principal(100, 'instalments', '2027-02-28', 3, null, 0, 0, null, '2026-03-31') <> 66
     or public.loan_given_current_principal(100, 'instalments', '2027-02-28', 3, null, 0, 40, null, '2026-03-31') <> 26 then
    raise exception 'FAIL B: instalment rounding / repaid-first';
  end if;
  if (select basis from public.loans_given_current_parts('2026-03-31') where loan_id = '11111111-0000-0000-0000-0000002674b1') <> 'schedule'
     or (select principal_left from public.loans_given_current_parts('2026-03-31') where loan_id = '11111111-0000-0000-0000-0000002674b1') <> 215010 then
    raise exception 'FAIL B: basis / principal left';
  end if;

  -- Totals: 100000 + 0 + 30000 + 95000 + 109446 (+ D1 not answered = 0)
  if pg_temp.split('loans_given_current') <> 334446 then raise exception 'FAIL total: current % not 334446', pg_temp.split('loans_given_current'); end if;
  if pg_temp.split('loans_given_undecided') <> 1 or pg_temp.split('loans_given_undecided_amount') <> 300000 then
    raise exception 'FAIL D: undecided % / %', pg_temp.split('loans_given_undecided'), pg_temp.split('loans_given_undecided_amount');
  end if;
  if public.loans_given_asset() <> 965010 then raise exception 'FAIL total: Loans given asset % not 965010', public.loans_given_asset(); end if;
end $$;

-- ── D: the choice on a loan with no date ────────────────────────────────────────────────────
do $$
declare v_changed boolean;
begin
  if (select basis from public.loans_given_current_parts('2026-03-31') where loan_id = '11111111-0000-0000-0000-0000002674d1') <> 'undecided' then
    raise exception 'FAIL D: basis not undecided';
  end if;
  v_changed := public.set_loan_due_within_12m('loan_given', '11111111-0000-0000-0000-0000002674d1', true);
  if not v_changed then raise exception 'FAIL D: Yes not saved'; end if;
  if pg_temp.split('loans_given_current') <> 634446 or pg_temp.split('loans_given_undecided') <> 0 then
    raise exception 'FAIL D: after Yes current % undecided %', pg_temp.split('loans_given_current'), pg_temp.split('loans_given_undecided');
  end if;
  if public.loans_given_asset() <> 965010 then raise exception 'FAIL D: total moved to %', public.loans_given_asset(); end if;

  -- D3: the same answer again → nothing changes, still one log row
  if public.set_loan_due_within_12m('loan_given', '11111111-0000-0000-0000-0000002674d1', true) then
    raise exception 'FAIL D3: repeat reported a change';
  end if;
  if (select count(*) from public.activity_log where tenant_id = 'dddddddd-0000-0000-0000-000000267401' and action = 'loan.due_within_12m_set') <> 1 then
    raise exception 'FAIL D3: log rows %', (select count(*) from public.activity_log where tenant_id = 'dddddddd-0000-0000-0000-000000267401' and action = 'loan.due_within_12m_set');
  end if;

  perform public.set_loan_due_within_12m('loan_given', '11111111-0000-0000-0000-0000002674d1', false);
  if pg_temp.split('loans_given_current') <> 334446 or pg_temp.split('loans_given_undecided') <> 0 then
    raise exception 'FAIL D: after No current % undecided %', pg_temp.split('loans_given_current'), pg_temp.split('loans_given_undecided');
  end if;
  if (select basis from public.loans_given_current_parts('2026-03-31') where loan_id = '11111111-0000-0000-0000-0000002674d1') <> 'choice' then
    raise exception 'FAIL D: basis not choice';
  end if;
  if public.loans_given_asset() <> 965010 then raise exception 'FAIL D: total moved to %', public.loans_given_asset(); end if;

  -- D2: a loan with a due date follows it
  perform pg_temp.refused('loan_given', '11111111-0000-0000-0000-0000002674a2', true, 'This loan has a due date%', 'D2');
  if pg_temp.part('11111111-0000-0000-0000-0000002674a2') <> 0 then raise exception 'FAIL D2: refused call changed the loan'; end if;
  perform pg_temp.refused('nonsense', '11111111-0000-0000-0000-0000002674d1', true, 'Pick a loan given or a staff loan%', 'D2 kind');
end $$;

-- ── D4: books locked past the loan's date — the choice still saves, nothing else does ───────
select set_config('request.jwt.claims', '', true);
update public.tenants set books_locked_until = '2026-03-31' where id = 'dddddddd-0000-0000-0000-000000267401';
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000267404","role":"authenticated"}', true);   -- accountant
do $$
begin
  perform public.set_loan_due_within_12m('loan_given', '11111111-0000-0000-0000-0000002674d1', true);
  if pg_temp.split('loans_given_current') <> 634446 then raise exception 'FAIL D4: locked books refused the choice (current %)', pg_temp.split('loans_given_current'); end if;
  -- a staff loan given in the locked period: the choice saves too (and back to the default)
  perform public.set_loan_due_within_12m('employee_loan', '44444444-0000-0000-0000-000000267401', false);
  if pg_temp.split('employee_loans_current') <> 20000 then raise exception 'FAIL D4: locked books refused the staff choice (%)', pg_temp.split('employee_loans_current'); end if;
  perform public.set_loan_due_within_12m('employee_loan', '44444444-0000-0000-0000-000000267401', null);
  -- the lock itself still holds for money columns
  begin
    update public.loans_given set principal = 1 where id = '11111111-0000-0000-0000-0000002674d1';
    if found then raise exception 'FAIL D4: a locked loan''s amount could be changed'; end if;
  exception when check_violation then null;
           when insufficient_privilege then null;
  end;
  if (select principal from public.loans_given where id = '11111111-0000-0000-0000-0000002674d1') <> 300000 then
    raise exception 'FAIL D4: principal changed under lock';
  end if;
end $$;
select set_config('request.jwt.claims', '', true);
update public.tenants set books_locked_until = null where id = 'dddddddd-0000-0000-0000-000000267401';
-- E2: an un-reconciled receipt (its repayment row goes) → the principal is owed, and current, again.
delete from public.loan_repayments where id = '33333333-0000-0000-0000-0000002674a3';
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000267401","role":"authenticated"}', true);
do $$
begin
  if pg_temp.part('11111111-0000-0000-0000-0000002674a3') <> 50000 then raise exception 'FAIL E2: % not 50000', pg_temp.part('11111111-0000-0000-0000-0000002674a3'); end if;
  if pg_temp.split('loans_given_current') <> 654446 then raise exception 'FAIL E2: current % not 654446', pg_temp.split('loans_given_current'); end if;
end $$;

-- ── F: staff loans ──────────────────────────────────────────────────────────────────────────
do $$
begin
  if pg_temp.split('employee_loans_current') <> 720000 then raise exception 'FAIL F: staff current % not 720000', pg_temp.split('employee_loans_current'); end if;
  perform public.set_loan_due_within_12m('employee_loan', '44444444-0000-0000-0000-000000267401', false);
  if pg_temp.split('employee_loans_current') <> 20000 then raise exception 'FAIL F: after No staff current % not 20000', pg_temp.split('employee_loans_current'); end if;
  perform pg_temp.refused('employee_loan', '44444444-0000-0000-0000-000000267402', false, 'A salary or expense advance is always shown under Current assets%', 'F advance');
  if pg_temp.split('employee_loans_current') <> 20000 then raise exception 'FAIL F: advance moved'; end if;
  -- F2: the type edited to a salary advance → the "No" answer is forgotten; edited back to a loan → current (default), not silently non-current
  update public.employee_loans set kind = 'salary_advance' where id = '44444444-0000-0000-0000-000000267401';
  if (select due_within_12m from public.employee_loans where id = '44444444-0000-0000-0000-000000267401') is not null then
    raise exception 'FAIL F2: the answer survived the type change';
  end if;
  update public.employee_loans set kind = 'loan' where id = '44444444-0000-0000-0000-000000267401';
  if pg_temp.split('employee_loans_current') <> 720000 then raise exception 'FAIL F2: loan again → % not 720000', pg_temp.split('employee_loans_current'); end if;
  perform public.set_loan_due_within_12m('employee_loan', '44444444-0000-0000-0000-000000267401', false);
  perform public.set_loan_due_within_12m('employee_loan', '44444444-0000-0000-0000-000000267401', null);   -- back to the default
  if pg_temp.split('employee_loans_current') <> 720000 then raise exception 'FAIL F: default not restored'; end if;
  if (select (public.report_balance_sheet('2026-03-31')).employee_loans) <> 720000 then
    raise exception 'FAIL F: Balance Sheet staff total moved';
  end if;
  -- loans given were not touched by the staff choice
  if pg_temp.split('loans_given_current') <> 654446 then raise exception 'FAIL F: loans given moved'; end if;
end $$;

-- ── G: roles and companies ──────────────────────────────────────────────────────────────────
do $$
begin
  perform pg_temp.refused('loan_given', '11111111-0000-0000-0000-0000002674f2', true, 'Loan not found in your company%', 'G other company loan');
  perform pg_temp.refused('employee_loan', '11111111-0000-0000-0000-0000002674f2', true, 'Loan not found in your company%', 'G wrong kind id');
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000267402","role":"authenticated"}', true);   -- sales
do $$
begin
  perform pg_temp.refused('loan_given', '11111111-0000-0000-0000-0000002674d1', false, 'Only the owner or the accountant%', 'G sales');
  if pg_temp.split('loans_given_current') <> 0 or pg_temp.split('employee_loans_current') <> 0 or pg_temp.split('loans_given_undecided') <> 0 then
    raise exception 'FAIL G: sales user got figures';
  end if;
  if exists (select 1 from public.loans_given_current_parts('2026-03-31')) then raise exception 'FAIL G: sales user got per-loan rows'; end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000267403","role":"authenticated"}', true);   -- manager
do $$
begin
  perform pg_temp.refused('loan_given', '11111111-0000-0000-0000-0000002674d1', false, 'Only the owner or the accountant%', 'G manager');
  if pg_temp.split('loans_given_current') <> 654446 or pg_temp.split('employee_loans_current') <> 720000 then
    raise exception 'FAIL G: manager totals % / %', pg_temp.split('loans_given_current'), pg_temp.split('employee_loans_current');
  end if;
  if exists (select 1 from public.loans_given_current_parts('2026-03-31')) then raise exception 'FAIL G: manager got per-loan rows (names are owner / accountant only)'; end if;
  -- a manager may edit a staff loan row directly (its update policy) — but not the Balance Sheet answer
  begin
    update public.employee_loans set due_within_12m = false where id = '44444444-0000-0000-0000-000000267401';
    raise exception 'FAIL G: manager changed the answer by a direct table write';
  exception when insufficient_privilege then null;
  end;
  update public.employee_loans set notes = 'manager note' where id = '44444444-0000-0000-0000-000000267401';   -- other edits still work
  if pg_temp.split('employee_loans_current') <> 720000 then raise exception 'FAIL G: staff current moved'; end if;
  -- the activity log (which a manager can read) never names the borrower of a loan given
  if exists (select 1 from public.activity_log where tenant_id = 'dddddddd-0000-0000-0000-000000267401'
              and action = 'loan.due_within_12m_set' and entity = 'loan_given' and label like '%D1 no date%') then
    raise exception 'FAIL G: the log names the borrower of a loan given';
  end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000267405","role":"authenticated"}', true);   -- other company's owner
do $$
begin
  if pg_temp.split('loans_given_current') <> 0 or pg_temp.split('loans_given_undecided') <> 1 or pg_temp.split('loans_given_undecided_amount') <> 70000
     or pg_temp.split('employee_loans_current') <> 0 then
    raise exception 'FAIL G: the other company''s figures moved: %', public.loans_current_split('2026-03-31');
  end if;
  perform pg_temp.refused('loan_given', '11111111-0000-0000-0000-0000002674d1', false, 'Loan not found in your company%', 'G cross company');
  if (select count(*) from public.loans_given_current_parts('2026-03-31')) <> 1 then raise exception 'FAIL G: other company sees % loans', (select count(*) from public.loans_given_current_parts('2026-03-31')); end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000267406","role":"authenticated"}', true);   -- over-repaid books
do $$
begin
  if public.loans_given_asset() <> 3000 then raise exception 'FAIL E: over-repaid total % not 3000', public.loans_given_asset(); end if;
  if pg_temp.split('loans_given_current') <> 3000 then raise exception 'FAIL E: current % above the Balance Sheet total 3000', pg_temp.split('loans_given_current'); end if;
end $$;

-- no caller at all (anon / no company): zeros, never an error
select set_config('request.jwt.claims', '', true);
do $$
begin
  if pg_temp.split('loans_given_current') <> 0 or pg_temp.split('employee_loans_current') <> 0 then raise exception 'FAIL G: no-company caller got figures'; end if;
end $$;

rollback;
