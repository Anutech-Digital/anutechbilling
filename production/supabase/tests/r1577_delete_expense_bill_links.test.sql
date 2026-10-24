-- R-1577 — deleting an expense or a vendor bill never leaves broken records behind.
--
-- Before (src/lib/queries/expenses.ts:650 and src/lib/queries/vendor-bills.ts:223 deleted
-- the row straight from the browser):
--   * a bank-matched expense / paid bill vanished while its bank line stayed "reconciled";
--   * an EMI-interest / fixed-asset / payment-run expense lost its link (ON DELETE SET NULL),
--     its cost dropped out of the P&L and the Trial Balance moved;
--   * a salary expense silently UN-PAID the salary (baseline tg_expense_delete_guards_salary).
-- Now delete_expense / delete_vendor_bill refuse with the page to undo it (HINT), and plain
-- DELETEs hit the same guards. Every step checks the derived Trial Balance (Dr − Cr) does not
-- move, except the one that deliberately leaves a bank line in Unreconciled.
--
--   node <bundle> begin; <migration> <this file> rollback; | docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1
-- Self-asserting; ROLLS BACK.

begin;

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('15770000-0000-4000-8000-000000000001', 'R1577 TEST', 'r1577@example.in', '07', 'R157'),
  ('15770000-0000-4000-8000-000000000002', 'R1577 OTHER', 'r1577o@example.in', '07', 'R15O');
insert into auth.users (id, instance_id, aud, role, email) values
  ('15770000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1577-owner@example.in'),
  ('15770000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1577-sales@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('15770000-0000-4000-8000-0000000000a1', '15770000-0000-4000-8000-000000000001', 'r1577-owner@example.in', 'owner'),
  ('15770000-0000-4000-8000-0000000000a2', '15770000-0000-4000-8000-000000000001', 'r1577-sales@example.in', 'sales');
insert into public.bank_accounts (id, tenant_id, name, bank_name, opening_balance, opening_balance_date) values
  ('15770000-0000-4000-8000-0000000000b1', '15770000-0000-4000-8000-000000000001', 'R1577 HDFC', 'HDFC', 0, '2026-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('15770000-0000-4000-8000-0000000000f1', '15770000-0000-4000-8000-000000000001', '15770000-0000-4000-8000-0000000000b1', current_date, 'NEFT DR STATIONERY SHOP', 1000, 0, 'csv_upload');
insert into public.employees (id, tenant_id, name, monthly_gross) values
  ('15770000-0000-4000-8000-0000000000e1', '15770000-0000-4000-8000-000000000001', 'R1577 Emp', 30000);
-- another company's expense (tenant guard)
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values ('EXP-R1577-OTHER', '15770000-0000-4000-8000-000000000002', 'Office Supplies', 'X', current_date, 100, 0, 'cash', 'other co');

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', '15770000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);

/* Dr − Cr of the derived Trial Balance — same formula as tb_money_events_balanced.test.sql. */
create function pg_temp.tb_gap() returns bigint language plpgsql as $$
declare
  b record; p record;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_fy date;
  v_dues bigint; v_gst bigint; v_assets bigint; v_liab bigint; v_profit bigint;
begin
  select * into b from public.report_balance_sheet(null);
  v_fy := make_date(b.fy_start_year, 4, 1);
  select * into p from public.report_pnl(v_fy, v_today);
  v_dues := b.dues_salary_tds + b.dues_pf + b.dues_esi + b.dues_vendor_tds
          - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(b.dues_paid) x), 0);
  v_gst  := b.gst_output - b.bills_gst
          - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(b.tax_payments) x where x->>'kind' = 'gst'), 0);
  v_assets := b.cash_and_bank + b.undeposited_funds + b.receivables + b.project_receivable + b.tds_receivable
            + b.employee_loans + b.prepaid_advances + b.emi_unregistered_cost
            - b.expenses_paid_unbanked;
  v_liab   := b.credit_card_payable + b.payables + b.advances_from_customers + b.salary_payable + v_dues
            + b.reimbursements_payable + b.emi_loans_payable + b.business_loans_payable + v_gst
            + b.expenses_payable + b.salary_other_deductions;
  v_profit := (p.inv_taxable - p.cn_taxable + p.dn_taxable) - p.cogs - p.commissions
            - coalesce((select sum((x->>'amount')::bigint) from jsonb_array_elements(p.expense_groups) x), 0);
  return v_assets - v_liab - v_profit;
end $$;

/* Run p_sql; it must be refused with a message LIKE p_msg (and HINT LIKE p_hint when given). */
create function pg_temp.refused(p_label text, p_sql text, p_msg text, p_hint text default null) returns void language plpgsql as $$
declare v_msg text; v_hint text;
begin
  begin
    execute p_sql;
    set constraints all immediate;     -- fire the deferred bank-line check now
    set constraints all deferred;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
    if v_msg not like p_msg then
      raise exception 'FAIL %: refused with the wrong message: %', p_label, v_msg;
    end if;
    if p_hint is not null and coalesce(v_hint, '') not like p_hint then
      raise exception 'FAIL %: hint % (want %)', p_label, v_hint, p_hint;
    end if;
    raise notice 'ok  %: refused — %', p_label, left(v_msg, 90);
    return;
  end;
  raise exception 'FAIL %: was NOT refused (%)', p_label, p_sql;
end $$;

do $$
declare
  g bigint; g2 bigint;
  v_e1 text; v_sal_exp text; v_sal uuid; v_emi uuid; v_emi_exp text; v_line uuid;
begin
  -- ── A. Bank-matched expense ───────────────────────────────────────────────
  v_e1 := public.book_bank_txn_as_expense('15770000-0000-4000-8000-0000000000f1', 'Office Supplies', 'Stationery Shop', 0, null);
  g := pg_temp.tb_gap();
  perform pg_temp.refused('A1 delete_expense on a bank-matched expense',
    format('select public.delete_expense(%L)', v_e1), '%Un-reconcile%', '/accounting/banking/15770000-0000-4000-8000-0000000000b1');
  perform pg_temp.refused('A2 plain DELETE of a bank-matched expense (deferred check)',
    format('delete from public.expenses where id = %L', v_e1), '%Un-reconcile%', '/accounting/banking/%');
  if not exists (select 1 from public.expenses where id = v_e1)
     or (select matched_to_type from public.bank_transactions where id = '15770000-0000-4000-8000-0000000000f1') is distinct from 'expense' then
    raise exception 'FAIL A3: refusal changed something';
  end if;
  if pg_temp.tb_gap() <> g then raise exception 'FAIL A4: TB moved on a refusal'; end if;
  -- the next step works: un-reconcile in Banking, then delete
  perform public.reconcile_bank_txn('15770000-0000-4000-8000-0000000000f1', null, null, null);
  perform public.delete_expense(v_e1);
  if exists (select 1 from public.expenses where id = v_e1) then raise exception 'FAIL A5: not deleted after un-reconcile'; end if;
  if (select matched_to_type from public.bank_transactions where id = '15770000-0000-4000-8000-0000000000f1') is not null then
    raise exception 'FAIL A6: bank line is not back in Unreconciled';
  end if;
  -- the only TB move is the ₹1,000 bank debit now waiting in Unreconciled
  if abs(pg_temp.tb_gap() - g) <> 1000 then raise exception 'FAIL A7: TB moved by % (want exactly the ₹1000 unreconciled line)', pg_temp.tb_gap() - g; end if;
  raise notice 'ok  A: reconciled expense — refused, then un-reconcile + delete leaves the line in Unreconciled';

  -- ── B. Salary expense ─────────────────────────────────────────────────────
  g := pg_temp.tb_gap();
  perform public.pay_salary('15770000-0000-4000-8000-0000000000e1', to_char(current_date, 'YYYY-MM'), current_date, 30000, 0, 0, 0, null,
                            1000, 1800, 0, 0, '15770000-0000-4000-8000-0000000000b1', null, 0, 0, 0, null);
  select id, expense_id into v_sal, v_sal_exp from public.salary_payments where employee_id = '15770000-0000-4000-8000-0000000000e1';
  if v_sal_exp is null then raise exception 'SETUP: pay_salary made no expense'; end if;
  g2 := pg_temp.tb_gap();
  perform pg_temp.refused('B1 delete_expense on a salary expense',
    format('select public.delete_expense(%L)', v_sal_exp), '%salary%Payroll%Undo%', '/accounting/payroll');
  perform pg_temp.refused('B2 plain DELETE of a salary expense',
    format('delete from public.expenses where id = %L', v_sal_exp), '%salary%Payroll%', '/accounting/payroll');
  if not exists (select 1 from public.salary_payments where id = v_sal) or not exists (select 1 from public.expenses where id = v_sal_exp) then
    raise exception 'FAIL B3: salary or its expense is gone after a refusal';
  end if;
  if pg_temp.tb_gap() <> g2 then raise exception 'FAIL B4: TB moved on a refusal'; end if;
  -- Payroll Undo (the next step) still removes both together
  perform public.delete_salary_payment(v_sal);
  if exists (select 1 from public.salary_payments where id = v_sal) or exists (select 1 from public.expenses where id = v_sal_exp) then
    raise exception 'FAIL B5: Payroll Undo did not remove salary + expense';
  end if;
  if pg_temp.tb_gap() <> g then raise exception 'FAIL B6: TB moved after Payroll Undo'; end if;
  raise notice 'ok  B: salary expense — refused with Payroll Undo; Undo still works';

  -- ── C. EMI interest expense ───────────────────────────────────────────────
  v_emi := public.record_emi_purchase('R1577 Laptop', 'equipment', 100000, 0, 10, 10000, current_date, null, 'R1577 Bank', null);
  perform public.record_emi_payment(v_emi, 10000, 1000, current_date, '15770000-0000-4000-8000-0000000000b1', null);
  select expense_id into v_emi_exp from public.emi_payments where purchase_id = v_emi;
  if v_emi_exp is null then raise exception 'SETUP: EMI payment made no interest expense'; end if;
  g := pg_temp.tb_gap();
  perform pg_temp.refused('C1 delete_expense on EMI interest',
    format('select public.delete_expense(%L)', v_emi_exp), '%EMI%Assets & EMIs%', '/accounting/assets');
  perform pg_temp.refused('C2 plain DELETE of EMI interest',
    format('delete from public.expenses where id = %L', v_emi_exp), '%EMI%', '/accounting/assets');
  if (select expense_id from public.emi_payments where purchase_id = v_emi) is distinct from v_emi_exp then
    raise exception 'FAIL C3: EMI payment lost its expense link';
  end if;
  if pg_temp.tb_gap() <> g then raise exception 'FAIL C4: TB moved on a refusal'; end if;
  raise notice 'ok  C: EMI interest — refused';

  -- ── D. Plain expenses delete, TB unchanged ────────────────────────────────
  g := pg_temp.tb_gap();
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values ('EXP-R1577-CASH', '15770000-0000-4000-8000-000000000001', 'Office Supplies', 'Shop', current_date, 500, 0, 'cash', 'cash');
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, paid)
    values ('EXP-R1577-UNPAID', '15770000-0000-4000-8000-000000000001', 'Software', 'Vendor', current_date, 2000, 0, null, 'unpaid', false);
  perform public.delete_expense('EXP-R1577-CASH');
  perform public.delete_expense('EXP-R1577-UNPAID');
  if exists (select 1 from public.expenses where id in ('EXP-R1577-CASH', 'EXP-R1577-UNPAID')) then
    raise exception 'FAIL D1: plain expenses not deleted';
  end if;
  if pg_temp.tb_gap() <> g then raise exception 'FAIL D2: TB moved after deleting plain expenses'; end if;
  raise notice 'ok  D: plain expenses delete, TB unchanged';

  -- ── E. Vendor bills ───────────────────────────────────────────────────────
  insert into public.vendor_bills (id, tenant_id, vendor_name, bill_no, bill_date, category, subtotal, cgst, sgst, igst, total)
    values ('BILL-R1577-PAID', '15770000-0000-4000-8000-000000000001', 'R1577 Supplier', 'S-1', current_date, 'COGS-Other', 5000, 450, 450, 0, 5900),
           ('BILL-R1577-OPEN', '15770000-0000-4000-8000-000000000001', 'R1577 Supplier', 'S-2', current_date, 'COGS-Other', 1000, 90, 90, 0, 1180);
  perform public.pay_vendor_bill('BILL-R1577-PAID', 5900, current_date, '15770000-0000-4000-8000-0000000000b1', 'neft');
  select id into v_line from public.bank_transactions where matched_to_type = 'vendor_bill' and matched_to_id = 'BILL-R1577-PAID';
  g := pg_temp.tb_gap();
  perform pg_temp.refused('E1 delete_vendor_bill on a paid (bank-matched) bill',
    $q$select public.delete_vendor_bill('BILL-R1577-PAID')$q$, '%bill%Un-reconcile%', '/accounting/banking/%');
  perform pg_temp.refused('E2 plain DELETE of a paid bill (deferred check)',
    $q$delete from public.vendor_bills where id = 'BILL-R1577-PAID'$q$, '%Un-reconcile%', '/accounting/banking/%');
  if pg_temp.tb_gap() <> g then raise exception 'FAIL E3: TB moved on a refusal'; end if;
  perform public.delete_vendor_bill('BILL-R1577-OPEN');
  if exists (select 1 from public.vendor_bills where id = 'BILL-R1577-OPEN') then raise exception 'FAIL E4: unpaid bill not deleted'; end if;
  if pg_temp.tb_gap() <> g then raise exception 'FAIL E5: TB moved after deleting an unpaid bill'; end if;
  perform public.reconcile_bank_txn(v_line, null, null, null);
  perform public.delete_vendor_bill('BILL-R1577-PAID');
  if (select matched_to_type from public.bank_transactions where id = v_line) is not null then
    raise exception 'FAIL E6: bill payment line not back in Unreconciled';
  end if;
  raise notice 'ok  E: paid bill refused until un-reconciled; unpaid bill deletes, TB unchanged';

  -- ── F. Open payment run ───────────────────────────────────────────────────
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description, paid)
    values ('EXP-R1577-RUN', '15770000-0000-4000-8000-000000000001', 'Software', 'Vendor', current_date, 700, 0, null, 'in a run', false);
end $$;

-- payment run rows: written as the table owner (the run RPCs need more setup than this test is about)
reset role;
insert into public.payment_runs (id, tenant_id, run_no, status, bank_account_id, created_by)
  values ('15770000-0000-4000-8000-0000000000c1', '15770000-0000-4000-8000-000000000001', 'PR-R1577', 'draft', '15770000-0000-4000-8000-0000000000b1', '15770000-0000-4000-8000-0000000000a1');
insert into public.payment_run_items (run_id, tenant_id, source, doc_id, vendor_name, amount)
  values ('15770000-0000-4000-8000-0000000000c1', '15770000-0000-4000-8000-000000000001', 'expense', 'EXP-R1577-RUN', 'Vendor', 700);
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values ('EXP-R1577-FA', '15770000-0000-4000-8000-000000000001', 'Computers', 'Dell', current_date, 20000, 0, 'cash', 'printer');
insert into public.fixed_assets (tenant_id, name, block, cost, put_to_use, expense_id)
  values ('15770000-0000-4000-8000-000000000001', 'R1577 Printer', 'computers', 20000, current_date, 'EXP-R1577-FA');
set local role authenticated;

do $$
begin
  perform pg_temp.refused('F1 delete_expense in an open payment run',
    $q$select public.delete_expense('EXP-R1577-RUN')$q$, '%payment run PR-R1577%', '/accounting/payment-runs');
  perform pg_temp.refused('G1 delete_expense of a fixed asset purchase',
    $q$select public.delete_expense('EXP-R1577-FA')$q$, '%fixed asset%', '/accounting/assets');
  perform pg_temp.refused('G2 plain DELETE of a fixed asset purchase',
    $q$delete from public.expenses where id = 'EXP-R1577-FA'$q$, '%fixed asset%', '/accounting/assets');

  -- ── H. Guards: tenant, role, books lock ───────────────────────────────────
  perform pg_temp.refused('H1 another company''s expense',
    $q$select public.delete_expense('EXP-R1577-OTHER')$q$, '%not in your company%');
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values ('EXP-R1577-LOCK', '15770000-0000-4000-8000-000000000001', 'Office Supplies', 'Shop', current_date - 1, 300, 0, 'cash', 'locked');
end $$;

reset role;
update public.tenants set books_locked_until = current_date - 1 where id = '15770000-0000-4000-8000-000000000001';
set local role authenticated;
do $$ begin
  perform pg_temp.refused('H2 books lock still applies',
    $q$select public.delete_expense('EXP-R1577-LOCK')$q$, '%lock%');
end $$;

select set_config('request.jwt.claims', json_build_object('sub', '15770000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
do $$ begin
  perform pg_temp.refused('H3 sales role cannot delete an expense',
    $q$select public.delete_expense('EXP-R1577-RUN')$q$, 'Only an owner, manager, billing or accountant%');
  perform pg_temp.refused('H4 sales role cannot delete a bill',
    $q$select public.delete_vendor_bill('BILL-R1577-NONE')$q$, 'Only an owner, manager, billing or accountant%');
end $$;

do $$ begin raise notice 'PASS: r1577_delete_expense_bill_links'; end $$;
rollback;
