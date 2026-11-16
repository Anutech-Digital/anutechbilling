-- R-2812 — Undo / Edit of a salary whose TDS the government already has is refused (TDS challan
-- booked for the month, or the quarter's 24Q marked filed). Independent review of R-2772, F3.
-- Migration: 20261114110000_r2812_salary_tds_deposited_lock.sql
--
-- FAILS without the migration (case A: Undo of a deposited month goes through), PASSES with it.
--
--   A   Oct 2026, TDS 2,000, TDS challan for 2026-10 booked → Undo refused (names the challan,
--       HINT = that bank account), salary + Salaries row still there.
--   B   Edit Oct keeping TDS 2,000 (gross 30,000 → 31,000) → allowed; the edit-only setting is
--       cleared afterwards.   B2  Edit Oct TDS 2,000 → 2,500 → refused, nothing changed.
--   C   Nov 2026 (no TDS challan — only a PF one; another company's Q3 24Q filed) → Undo works.
--   D   TDS 0 salary in the deposited month → Undo works.
--   E   Aug 2026, Q2 24Q marked filed on the Compliance calendar → Undo refused (HINT /compliance);
--       Edit of bank account / notes only → allowed; Edit of gross → refused; Edit of TDS → refused.
--   F   May 2026, "TDS return filed" ticked in Month close for Jun 2026 (same quarter) → Undo refused;
--       untick it → Undo works (the owner's way back).
--   G   Mar 2026, TDS challan with no period paid 7 Apr → Undo refused.
--       Remove that challan → Undo works.
--   H   Feb 2026, a 'mixed' challan for 2026-02 (the 24Q working counts it) → Undo refused.
--   I   The edit-only setting naming ANOTHER salary does not open a direct Undo.
--   J   salary_tds_lock: the owner sees 'deposited'; a sales login and another company's owner get
--       an empty answer.
--   K   the table's own rights (RLS lets payroll roles delete / update salary_payments) meet the same
--       lock: direct delete, TDS change on a deposited month, LOP change in a filed quarter refused;
--       notes / bank account still change.
--   L   TDS-0 salary in a deposited month: Edit / Undo work; an Edit that ADDS TDS is refused.
--   M   merge_employees / employee-only move: deposited month OK; filed quarter only when both employees
--       have the same PAN (P7 no PAN on the duplicate, P10 PAN blanked first, P12 kept record without
--       PAN -> refused, each with its own way out); never to another company's employee, whose name /
--       PAN is never shown (P11 deposited, P13 filed).
--   N   incentive from a bank line onto a locked month: refused with its own message + HINT.
--
-- Run (needs 20261114083830_r2772 + this migration on the DB):
--   node scripts/test-sql.mjs --local supabase/tests/r2812_salary_tds_deposited_lock.test.sql
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c2812000-0000-0000-0000-0000000000a1', 'r2812-owner@example.test'),
  ('c2812000-0000-0000-0000-0000000000a2', 'r2812-sales@example.test'),
  ('c2812000-0000-0000-0000-0000000000a3', 'r2812-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2812000-0000-0000-0000-0000000000f0', 'R2812 T', 'r2812@example.test', '07', 'R2812'),
  ('c2812000-0000-0000-0000-0000000000f1', 'R2812 Other', 'r2812o@example.test', '07', 'R2812O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2812000-0000-0000-0000-0000000000a1', 'c2812000-0000-0000-0000-0000000000f0', 'r2812-owner@example.test', 'R2812 Owner', 'owner', true),
  ('c2812000-0000-0000-0000-0000000000a2', 'c2812000-0000-0000-0000-0000000000f0', 'r2812-sales@example.test', 'R2812 Sales', 'sales', true),
  ('c2812000-0000-0000-0000-0000000000a3', 'c2812000-0000-0000-0000-0000000000f1', 'r2812-other@example.test', 'R2812 Other', 'owner', true);

insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance, opening_balance_date) values
  ('c2812000-0000-4000-8000-0000000000b1', 'c2812000-0000-0000-0000-0000000000f0', 'HDFC', 'HDFC', 'current', 500000, '2025-04-01'),
  ('c2812000-0000-4000-8000-0000000000b2', 'c2812000-0000-0000-0000-0000000000f0', 'ICICI', 'ICICI', 'current', 0, '2025-04-01');

insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, joining_date) values
  ('c2812000-0000-4000-8000-0000000000e1', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Meena', 30000, 15000, '2025-01-01'),
  ('c2812000-0000-4000-8000-0000000000e2', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Asha',  30000, 15000, '2025-01-01'),
  ('c2812000-0000-4000-8000-0000000000e3', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Ravi',  30000, 15000, '2025-01-01'),
  ('c2812000-0000-4000-8000-0000000000e4', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Kiran', 30000, 15000, '2025-01-01');
-- M (merge_employees, R-2380): duplicates to merge — no PAN / same PAN / another PAN.
insert into public.employees (id, tenant_id, name, monthly_gross, basic_monthly, joining_date, pan) values
  ('c2812000-0000-4000-8000-0000000000e5', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Sunil Dup',  30000, 15000, '2025-01-01', null),
  ('c2812000-0000-4000-8000-0000000000e6', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Sunil',      30000, 15000, '2025-01-01', 'ABCPS1234K'),
  ('c2812000-0000-4000-8000-0000000000e7', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Neha Dup',   30000, 15000, '2025-01-01', 'ABCPN5678L'),
  ('c2812000-0000-4000-8000-0000000000e8', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Neha',       30000, 15000, '2025-01-01', 'abcpn5678l'),
  ('c2812000-0000-4000-8000-0000000000e9', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Vikas Dup',  30000, 15000, '2025-01-01', 'ABCPV1111M'),
  ('c2812000-0000-4000-8000-0000000000ea', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Vikas',      30000, 15000, '2025-01-01', 'ABCPV2222N'),
  ('c2812000-0000-4000-8000-0000000000ec', 'c2812000-0000-0000-0000-0000000000f0', 'R2812 Rekha Dup',  30000, 15000, '2025-01-01', null),
  -- another company's employee (re-review: a move there must be refused, its name / PAN never shown)
  ('c2812000-0000-4000-8000-0000000000eb', 'c2812000-0000-0000-0000-0000000000f1', 'R2812 OtherCo Emp', 30000, 15000, '2025-01-01', 'ZZZPZ9999Z');
-- N (book_bank_txn_as_incentive, R-1839): two money-out lines to book as incentive.
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit) values
  ('c2812000-0000-4000-8000-0000000000c1', 'c2812000-0000-0000-0000-0000000000f0', 'c2812000-0000-4000-8000-0000000000b1', '2026-11-10', 'R2812 INCENTIVE OCT', 900, 0),
  ('c2812000-0000-4000-8000-0000000000c2', 'c2812000-0000-0000-0000-0000000000f0', 'c2812000-0000-4000-8000-0000000000b1', '2026-11-11', 'R2812 INCENTIVE AUG', 500, 0);

-- What the government already has (the owner's real path books these from a bank line / a tick).
insert into public.statutory_dues_payments (id, tenant_id, kind, amount, paid_on, period, challan_no, bank_account_id) values
  ('c2812000-0000-4000-8000-0000000000d1', 'c2812000-0000-0000-0000-0000000000f0', 'tds',   2000, '2026-11-06', '2026-10', 'CH-OCT', 'c2812000-0000-4000-8000-0000000000b1'),
  ('c2812000-0000-4000-8000-0000000000d2', 'c2812000-0000-0000-0000-0000000000f0', 'pf',    3600, '2026-11-14', '2026-11', 'PF-NOV', 'c2812000-0000-4000-8000-0000000000b1'),
  ('c2812000-0000-4000-8000-0000000000d3', 'c2812000-0000-0000-0000-0000000000f0', 'tds',   2000, '2026-04-07', null,      'CH-MAR', 'c2812000-0000-4000-8000-0000000000b1'),
  ('c2812000-0000-4000-8000-0000000000d4', 'c2812000-0000-0000-0000-0000000000f0', 'mixed', 5000, '2026-03-06', '2026-02', 'CH-FEB', 'c2812000-0000-4000-8000-0000000000b1');
insert into public.compliance_log (tenant_id, obligation_key, period_key, period_label, filed_date) values
  ('c2812000-0000-0000-0000-0000000000f0', 'tds_return', '2026-q2', 'Q2 2026-27', '2026-10-30'),
  ('c2812000-0000-0000-0000-0000000000f1', 'tds_return', '2026-q3', 'Q3 2026-27', '2026-11-10');
insert into public.month_close_checks (tenant_id, period, key) values
  ('c2812000-0000-0000-0000-0000000000f0', '2026-06', 'tds_return_filed');

create function pg_temp.r2812_count(p_emp uuid, p_period text) returns text language sql stable as $f$
  select (select count(*) from public.salary_payments s where s.employee_id = p_emp and s.period = p_period)::text || '/'
      || (select count(*) from public.expenses e join public.employees emp on emp.id = p_emp
           where e.tenant_id = 'c2812000-0000-0000-0000-0000000000f0' and e.category = 'Salaries'
             and e.vendor_name = emp.name and e.description like '% ' || p_period || '%')::text
$f$;
grant execute on function pg_temp.r2812_count(uuid, text) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', 'c2812000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);

-- Salaries: pay_salary(emp, period, pay_date, gross, lop_days, lop_amt, adv, loan, tds, pf, esi, other, bank, notes, incentive, esi_er, pf_er, pf_wage)
create temp table r2812_ids (k text primary key, id uuid) on commit drop;
grant all on r2812_ids to authenticated;
insert into r2812_ids values
  ('oct',   public.pay_salary('c2812000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 30000, 0, 0, 0, null, 2000, 0, 0, 0, 'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null)),
  ('nov',   public.pay_salary('c2812000-0000-4000-8000-0000000000e1', '2026-11', '2026-11-13', 30000, 0, 0, 0, null, 2000, 0, 0, 0, 'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null)),
  ('oct0',  public.pay_salary('c2812000-0000-4000-8000-0000000000e4', '2026-10', '2026-10-31', 30000, 0, 0, 0, null, 0,    0, 0, 0, 'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null)),
  ('aug',   public.pay_salary('c2812000-0000-4000-8000-0000000000e2', '2026-08', '2026-08-31', 30000, 0, 0, 0, null, 2000, 0, 0, 0, 'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null)),
  ('may',   public.pay_salary('c2812000-0000-4000-8000-0000000000e3', '2026-05', '2026-05-31', 30000, 0, 0, 0, null, 2000, 0, 0, 0, 'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null)),
  ('mar',   public.pay_salary('c2812000-0000-4000-8000-0000000000e3', '2026-03', '2026-03-31', 30000, 0, 0, 0, null, 2000, 0, 0, 0, 'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null)),
  ('feb',   public.pay_salary('c2812000-0000-4000-8000-0000000000e3', '2026-02', '2026-02-28', 30000, 0, 0, 0, null, 2000, 0, 0, 0, 'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null));

-- ── A. Deposited month: Undo refused ────────────────────────────────────────────────
do $$
declare v_id uuid := (select id from r2812_ids where k = 'oct'); v_msg text; v_hint text;
begin
  begin
    perform public.delete_salary_payment(v_id);
  exception when others then get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_msg is null then raise exception 'FAIL A: Undo of a salary whose TDS month is deposited went through'; end if;
  if v_msg not like 'TDS for Oct 2026 is already deposited (TDS challan CH-OCT of ₹2000 paid on 06 Nov 2026 for Oct 2026) and R2812 Meena''s salary carries ₹2000 of it. Undoing it%later month''s TDS%'
     or v_msg not like '%use Edit and keep the TDS at ₹2000%' then
    raise exception 'FAIL A1: message: %', v_msg;
  end if;
  if v_hint is distinct from '/accounting/banking/c2812000-0000-4000-8000-0000000000b1' then raise exception 'FAIL A2: hint %', v_hint; end if;
  if pg_temp.r2812_count('c2812000-0000-4000-8000-0000000000e1', '2026-10') <> '1/1' then
    raise exception 'FAIL A3: after refused Undo: %', pg_temp.r2812_count('c2812000-0000-4000-8000-0000000000e1', '2026-10');
  end if;
  raise notice 'PASS A: Undo of a deposited TDS month refused, names the challan, nothing changed';
end $$;

-- ── B. Edit of the deposited month: same TDS allowed, TDS change refused ────────────
do $$
declare v_id uuid := (select id from r2812_ids where k = 'oct'); v_new uuid; v_s public.salary_payments; v_msg text; v_hint text;
begin
  v_new := public.edit_salary_payment(v_id, 'c2812000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 31000, 0, 0, 0, null, 2000, 0, 0, 0,
                                      'c2812000-0000-4000-8000-0000000000b1', 'raise', 0, 0, 0, null, 0);
  select * into v_s from public.salary_payments where id = v_new;
  if v_s.gross <> 31000 or v_s.tds <> 2000 or pg_temp.r2812_count('c2812000-0000-4000-8000-0000000000e1', '2026-10') <> '1/1' then
    raise exception 'FAIL B1: edit keeping TDS: gross % tds % rows %', v_s.gross, v_s.tds, pg_temp.r2812_count('c2812000-0000-4000-8000-0000000000e1', '2026-10');
  end if;
  if coalesce(current_setting('app.r2812_salary_edit', true), '') <> '' then
    raise exception 'FAIL B2: edit-only setting left behind: %', current_setting('app.r2812_salary_edit', true);
  end if;
  update r2812_ids set id = v_new where k = 'oct';
  raise notice 'PASS B: Edit of a deposited month keeping the TDS goes through (gross 31,000), setting cleared';

  begin
    perform public.edit_salary_payment(v_new, 'c2812000-0000-4000-8000-0000000000e1', '2026-10', '2026-10-31', 31000, 0, 0, 0, null, 2500, 0, 0, 0,
                                       'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null, 0);
  exception when others then get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_msg is null or v_msg not like 'TDS for Oct 2026 is already deposited (TDS challan CH-OCT%Edit can change this salary but not its TDS — keep it at ₹2000%' then
    raise exception 'FAIL B3: TDS change on a deposited month: %', coalesce(v_msg, 'went through');
  end if;
  select * into v_s from public.salary_payments where id = v_new;
  if not found or v_s.tds <> 2000 or v_s.gross <> 31000 then raise exception 'FAIL B4: refused edit changed the salary'; end if;
  raise notice 'PASS B2: Edit that changes a deposited TDS is refused, nothing changed';
end $$;

-- ── C / D. Not deposited / TDS 0 → Undo works ───────────────────────────────────────
do $$
begin
  perform public.delete_salary_payment((select id from r2812_ids where k = 'nov'));
  if pg_temp.r2812_count('c2812000-0000-4000-8000-0000000000e1', '2026-11') <> '0/0' then raise exception 'FAIL C: Nov not undone'; end if;
  raise notice 'PASS C: month with only a PF challan (and another company''s 24Q filed) undoes as before';
  perform public.delete_salary_payment((select id from r2812_ids where k = 'oct0'));
  if pg_temp.r2812_count('c2812000-0000-4000-8000-0000000000e4', '2026-10') <> '0/0' then raise exception 'FAIL D: TDS-0 salary not undone'; end if;
  raise notice 'PASS D: TDS 0 salary in a deposited month undoes as before';
end $$;

-- ── E. 24Q filed (Compliance calendar) ──────────────────────────────────────────────
do $$
declare v_id uuid := (select id from r2812_ids where k = 'aug'); v_new uuid; v_s public.salary_payments; v_msg text; v_hint text;
begin
  begin
    perform public.delete_salary_payment(v_id);
  exception when others then get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_msg is null or v_msg not like 'The TDS return (24Q / 26Q) for Q2 FY 2026-27 (Jul – Sep 2026) is marked filed (30 Oct 2026) and has R2812 Asha''s Aug 2026 salary in it (TDS ₹2000). Undoing it%file a correction return%mark that return not filed%' then
    raise exception 'FAIL E1: Undo in a filed quarter: %', coalesce(v_msg, 'went through');
  end if;
  if v_hint is distinct from '/compliance' then raise exception 'FAIL E2: hint %', v_hint; end if;

  -- bank account + notes only → allowed
  v_new := public.edit_salary_payment(v_id, 'c2812000-0000-4000-8000-0000000000e2', '2026-08', '2026-08-31', 30000, 0, 0, 0, null, 2000, 0, 0, 0,
                                      'c2812000-0000-4000-8000-0000000000b2', 'paid from ICICI', 0, 0, 0, null, 0);
  select * into v_s from public.salary_payments where id = v_new;
  if v_s.bank_account_id <> 'c2812000-0000-4000-8000-0000000000b2' or v_s.notes is distinct from 'paid from ICICI' then
    raise exception 'FAIL E3: bank / notes edit in a filed quarter not saved';
  end if;
  raise notice 'PASS E: Undo in a filed 24Q quarter refused; Edit of bank account / notes allowed';

  v_msg := null;
  begin
    perform public.edit_salary_payment(v_new, 'c2812000-0000-4000-8000-0000000000e2', '2026-08', '2026-08-31', 32000, 0, 0, 0, null, 2000, 0, 0, 0,
                                       'c2812000-0000-4000-8000-0000000000b2', null, 0, 0, 0, null, 0);
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like '%is marked filed%the pay date, gross, LOP, incentive and TDS stay as filed%' then
    raise exception 'FAIL E4: gross edit in a filed quarter: %', coalesce(v_msg, 'went through');
  end if;
  v_msg := null;
  begin
    perform public.edit_salary_payment(v_new, 'c2812000-0000-4000-8000-0000000000e2', '2026-08', '2026-08-31', 30000, 0, 0, 0, null, 1500, 0, 0, 0,
                                       'c2812000-0000-4000-8000-0000000000b2', null, 0, 0, 0, null, 0);
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like '%is marked filed%' then raise exception 'FAIL E5: TDS edit in a filed quarter: %', coalesce(v_msg, 'went through'); end if;
  v_msg := null;
  begin
    perform public.edit_salary_payment(v_new, 'c2812000-0000-4000-8000-0000000000e2', '2026-08', '2026-09-02', 30000, 0, 0, 0, null, 2000, 0, 0, 0,
                                       'c2812000-0000-4000-8000-0000000000b2', null, 0, 0, 0, null, 0);
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like '%is marked filed%' then raise exception 'FAIL E6: pay-date edit in a filed quarter: %', coalesce(v_msg, 'went through'); end if;
  select * into v_s from public.salary_payments where id = v_new;
  if not found or v_s.gross <> 30000 or v_s.tds <> 2000 or v_s.pay_date <> '2026-08-31'
     or pg_temp.r2812_count('c2812000-0000-4000-8000-0000000000e2', '2026-08') <> '1/1' then
    raise exception 'FAIL E7: a refused edit changed the filed salary';
  end if;
  raise notice 'PASS E2: Edit of gross / TDS / pay date in a filed quarter refused, nothing changed';
end $$;

-- ── F. 24Q ticked filed in Month close (Jun) → May locked; untick → Undo works ──────
do $$
declare v_id uuid := (select id from r2812_ids where k = 'may'); v_msg text;
begin
  begin
    perform public.delete_salary_payment(v_id);
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like 'The TDS return (24Q / 26Q) for Q1 FY 2026-27 (Apr – Jun 2026) is marked filed%R2812 Ravi''s May 2026 salary%' then
    raise exception 'FAIL F1: Undo with the Month close tick: %', coalesce(v_msg, 'went through');
  end if;
  delete from public.month_close_checks where period = '2026-06' and key = 'tds_return_filed';
  perform public.delete_salary_payment(v_id);
  if pg_temp.r2812_count('c2812000-0000-4000-8000-0000000000e3', '2026-05') <> '0/0' then raise exception 'FAIL F2: May not undone after untick'; end if;
  raise notice 'PASS F: Month close tick locks the quarter; untick (the owner''s way back) → Undo works';
end $$;

-- ── G / H. Challan with no period (paid next month); 'mixed' challan ──────────────
do $$
declare v_msg text;
begin
  begin
    perform public.delete_salary_payment((select id from r2812_ids where k = 'mar'));
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like 'TDS for Mar 2026 is already deposited (TDS challan CH-MAR of ₹2000 paid on 07 Apr 2026 for Mar 2026)%' then
    raise exception 'FAIL G1: no-period challan paid next month: %', coalesce(v_msg, 'went through');
  end if;
  v_msg := null;
  begin
    perform public.delete_salary_payment((select id from r2812_ids where k = 'feb'));
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like 'TDS for Feb 2026 is already deposited (TDS challan CH-FEB%' then
    raise exception 'FAIL H: mixed challan for the month: %', coalesce(v_msg, 'went through');
  end if;
  raise notice 'PASS G/H: no-period TDS challan paid next month and a mixed challan both lock the month';
end $$;

reset role;
delete from public.statutory_dues_payments where id = 'c2812000-0000-4000-8000-0000000000d3';
set local role authenticated;
do $$
begin
  perform public.delete_salary_payment((select id from r2812_ids where k = 'mar'));
  if pg_temp.r2812_count('c2812000-0000-4000-8000-0000000000e3', '2026-03') <> '0/0' then raise exception 'FAIL G2: Mar not undone after the challan went'; end if;
  raise notice 'PASS G2: challan taken off → Undo works';
end $$;

-- ── I. The edit-only setting for ANOTHER salary does not open a direct Undo ─────────
do $$
declare v_msg text;
begin
  perform set_config('app.r2812_salary_edit', (select id from r2812_ids where k = 'aug')::text, true);
  begin
    perform public.delete_salary_payment((select id from r2812_ids where k = 'oct'));
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  perform set_config('app.r2812_salary_edit', '', true);
  if v_msg is null or v_msg not like '%already deposited%' then raise exception 'FAIL I: %', coalesce(v_msg, 'went through'); end if;
  raise notice 'PASS I: the edit-only skip is tied to its own salary id';
end $$;

-- ── K. The table's own delete / update rights meet the same lock (code review) ──────
do $$
declare v_oct uuid := (select id from r2812_ids where k = 'oct'); v_aug uuid; v_msg text; v_n int;
begin
  select id into v_aug from public.salary_payments where employee_id = 'c2812000-0000-4000-8000-0000000000e2' and period = '2026-08';
  begin
    delete from public.salary_payments where id = v_oct;
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like 'TDS for Oct 2026 is already deposited%' then raise exception 'FAIL K1: direct delete: %', coalesce(v_msg, 'went through'); end if;
  v_msg := null;
  begin
    update public.salary_payments set tds = 0 where id = v_oct;
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like '%not its TDS — keep it at ₹2000%' then raise exception 'FAIL K2: direct TDS update: %', coalesce(v_msg, 'went through'); end if;
  update public.salary_payments set notes = 'checked' where id = v_oct;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL K3: a notes change on a deposited month was blocked'; end if;
  v_msg := null;
  begin
    update public.salary_payments set lop_amount = 500 where id = v_aug;
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like '%is marked filed%stay as filed%' then raise exception 'FAIL K4: LOP change in a filed quarter: %', coalesce(v_msg, 'went through'); end if;
  update public.salary_payments set bank_account_id = 'c2812000-0000-4000-8000-0000000000b1' where id = v_aug;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL K5: a bank account change in a filed quarter was blocked'; end if;
  raise notice 'PASS K: direct delete / TDS / LOP change refused like Undo / Edit; notes and bank account still change';
end $$;

-- ── L. A TDS-0 salary is free — unless an edit would give it TDS ────────────────────
do $$
declare v_id uuid; v_new uuid; v_msg text;
begin
  v_id := public.pay_salary('c2812000-0000-4000-8000-0000000000e4', '2026-10', '2026-10-31', 30000, 0, 0, 0, null, 0, 0, 0, 0,
                            'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null);
  v_new := public.edit_salary_payment(v_id, 'c2812000-0000-4000-8000-0000000000e4', '2026-10', '2026-10-31', 32000, 0, 0, 0, null, 0, 0, 0, 0,
                                      'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null, 0);
  begin
    perform public.edit_salary_payment(v_new, 'c2812000-0000-4000-8000-0000000000e4', '2026-10', '2026-10-31', 32000, 0, 0, 0, null, 500, 0, 0, 0,
                                       'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null, 0);
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like 'TDS for Oct 2026 is already deposited%keep it at ₹0%' then
    raise exception 'FAIL L1: TDS added to a TDS-0 salary in a deposited month: %', coalesce(v_msg, 'went through');
  end if;
  if (select tds from public.salary_payments where id = v_new) <> 0 then raise exception 'FAIL L2: refused edit changed the TDS'; end if;
  perform public.delete_salary_payment(v_new);
  raise notice 'PASS L: TDS-0 salary edits / undoes freely, but an edit cannot add TDS to a deposited month';
end $$;

-- ── M. merge_employees moves a salary to the kept employee (independent review, finding 1) ──
do $$
declare v_msg text; v_hint text; v_res jsonb;
begin
  -- deposited month, only the employee changes → allowed (the challan is a month total)
  perform public.pay_salary('c2812000-0000-4000-8000-0000000000e5', '2026-10', '2026-10-31', 30000, 0, 0, 0, null, 1500, 0, 0, 0,
                            'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null);
  v_res := public.merge_employees('c2812000-0000-4000-8000-0000000000e6', 'c2812000-0000-4000-8000-0000000000e5');
  if not exists (select 1 from public.salary_payments where employee_id = 'c2812000-0000-4000-8000-0000000000e6' and period = '2026-10' and tds = 1500) then
    raise exception 'FAIL M1: merge in a deposited month did not move the salary';
  end if;
  -- filed quarter, same PAN (any case) → allowed
  perform public.pay_salary('c2812000-0000-4000-8000-0000000000e7', '2026-08', '2026-08-31', 30000, 0, 0, 0, null, 1500, 0, 0, 0,
                            'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null);
  v_res := public.merge_employees('c2812000-0000-4000-8000-0000000000e8', 'c2812000-0000-4000-8000-0000000000e7');
  if not exists (select 1 from public.salary_payments where employee_id = 'c2812000-0000-4000-8000-0000000000e8' and period = '2026-08') then
    raise exception 'FAIL M2: merge with the same PAN in a filed quarter did not move the salary';
  end if;
  -- filed quarter, another PAN → refused with the merge message, nothing moved
  perform public.pay_salary('c2812000-0000-4000-8000-0000000000e9', '2026-08', '2026-08-31', 30000, 0, 0, 0, null, 1500, 0, 0, 0,
                            'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null);
  begin
    v_res := public.merge_employees('c2812000-0000-4000-8000-0000000000ea', 'c2812000-0000-4000-8000-0000000000e9');
  exception when others then get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_msg is null or v_msg not like '%Q2 FY 2026-27%is filed with R2812 Vikas Dup''s PAN (ABCPV1111M)%unmark the return on the Compliance page first, or file a revised return%' then
    raise exception 'FAIL M3: merge across PANs in a filed quarter: %', coalesce(v_msg, 'went through');
  end if;
  if v_hint is distinct from '/compliance' then raise exception 'FAIL M4: hint %', v_hint; end if;
  if not exists (select 1 from public.salary_payments where employee_id = 'c2812000-0000-4000-8000-0000000000e9' and period = '2026-08') then
    raise exception 'FAIL M5: refused merge moved the salary';
  end if;
  -- re-review: a move to ANOTHER company's employee is refused (deposited AND filed) without its name / PAN
  v_msg := null;
  begin
    update public.salary_payments set employee_id = 'c2812000-0000-4000-8000-0000000000eb'
     where employee_id = 'c2812000-0000-4000-8000-0000000000e6' and period = '2026-10';
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg like '%OtherCo%' or v_msg like '%ZZZPZ9999Z%' or v_msg not like '%employee of this company%' then
    raise exception 'FAIL M6: move to another company''s employee (deposited): %', coalesce(v_msg, 'went through');
  end if;
  v_msg := null;
  begin
    update public.salary_payments set employee_id = 'c2812000-0000-4000-8000-0000000000eb'
     where employee_id = 'c2812000-0000-4000-8000-0000000000e9' and period = '2026-08';
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg like '%OtherCo%' or v_msg like '%ZZZPZ9999Z%' or v_msg not like '%employee of this company%' then
    raise exception 'FAIL M7: move to another company''s employee (filed): %', coalesce(v_msg, 'went through');
  end if;
  -- filed quarter, duplicate has a PAN, kept record has none → refused, and told to add the PAN there first
  update public.employees set pan = null where id = 'c2812000-0000-4000-8000-0000000000ea';
  v_msg := null;
  begin
    v_res := public.merge_employees('c2812000-0000-4000-8000-0000000000ea', 'c2812000-0000-4000-8000-0000000000e9');
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like '%Add the PAN to the kept employee first: put ABCPV1111M as R2812 Vikas''s PAN (Employees)%'
     or v_msg like '%unmark the return%' then
    raise exception 'FAIL M8 (P12): kept record without PAN: %', coalesce(v_msg, 'went through');
  end if;
  -- rev2 decision: filed quarter needs a PAN on BOTH sides. Duplicate without PAN (P7) → refused.
  perform public.pay_salary('c2812000-0000-4000-8000-0000000000ec', '2026-08', '2026-08-31', 30000, 0, 0, 0, null, 1500, 0, 0, 0,
                            'c2812000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null);
  v_msg := null;
  begin
    v_res := public.merge_employees('c2812000-0000-4000-8000-0000000000e6', 'c2812000-0000-4000-8000-0000000000ec');
  exception when others then get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_msg is null or v_msg not like 'Add the same PAN to both employees first (The TDS return (24Q / 26Q) for Q2 FY 2026-27%' then
    raise exception 'FAIL M9 (P7): duplicate without PAN in a filed quarter: %', coalesce(v_msg, 'went through');
  end if;
  -- P10: blank the duplicate's PAN, then move straight on the table → refused the same way
  update public.employees set pan = null where id = 'c2812000-0000-4000-8000-0000000000e9';
  v_msg := null;
  begin
    update public.salary_payments set employee_id = 'c2812000-0000-4000-8000-0000000000e6'
     where employee_id = 'c2812000-0000-4000-8000-0000000000e9' and period = '2026-08';
  exception when others then get stacked diagnostics v_msg = message_text;
  end;
  if v_msg is null or v_msg not like 'Add the same PAN to both employees first%' then
    raise exception 'FAIL M10 (P10): blanked PAN then move: %', coalesce(v_msg, 'went through');
  end if;
  raise notice 'PASS M: merge moves a deposited month''s salary; filed quarter only with the same PAN (or no PAN), else a merge message; never to another company''s employee';
end $$;

-- ── N. Incentive booked from a bank line onto a locked month gets its own message ────
do $$
declare v_msg text; v_hint text;
begin
  begin
    perform public.book_bank_txn_as_incentive('c2812000-0000-4000-8000-0000000000c1', 'c2812000-0000-4000-8000-0000000000e1', '2026-10', 100);
  exception when others then get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_msg is null or v_msg not like 'TDS for Oct 2026 is already deposited (TDS challan CH-OCT%this incentive%TDS in a later month%' then
    raise exception 'FAIL N1: incentive with TDS onto a deposited month: %', coalesce(v_msg, 'went through');
  end if;
  if v_hint is distinct from '/accounting/banking/c2812000-0000-4000-8000-0000000000b1' then raise exception 'FAIL N2: hint %', v_hint; end if;
  v_msg := null;
  begin
    perform public.book_bank_txn_as_incentive('c2812000-0000-4000-8000-0000000000c2', 'c2812000-0000-4000-8000-0000000000e2', '2026-08', 0);
  exception when others then get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
  end;
  if v_msg is null or v_msg not like '%is marked filed%this incentive%later month%' or v_hint is distinct from '/compliance' then
    raise exception 'FAIL N3: incentive onto a filed quarter: % / %', coalesce(v_msg, 'went through'), v_hint;
  end if;
  raise notice 'PASS N: incentive from a bank line onto a locked month is refused with its own message + HINT';
end $$;

-- ── J. salary_tds_lock: who sees what ───────────────────────────────────────────────
do $$
declare v_kind text; v_id uuid := (select id from r2812_ids where k = 'oct');
begin
  select o_kind into v_kind from public.salary_tds_lock(v_id);
  if v_kind is distinct from 'deposited' then raise exception 'FAIL J1: owner sees %', v_kind; end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2812000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  select o_kind into v_kind from public.salary_tds_lock(v_id);
  if v_kind is not null then raise exception 'FAIL J2: sales login sees %', v_kind; end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c2812000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
  select o_kind into v_kind from public.salary_tds_lock(v_id);
  if v_kind is not null then raise exception 'FAIL J3: another company''s owner sees %', v_kind; end if;
  raise notice 'PASS J: lock helper answers only the own company''s payroll roles';
end $$;

rollback;
