-- deploy-peek: to_regprocedure('public.delete_expense(text)') is not null and to_regprocedure('public.delete_vendor_bill(text)') is not null and exists(select 1 from pg_trigger where tgname = 'trg_expense_no_orphan_bank_match')
-- deploy-key: r1577delexpense
-- ============================================================================
-- R-1577 (18 Oct 2026) — deleting an expense or a vendor bill no longer breaks the books.
--
-- Before: Accounting → Expenses / COGS Bills deleted the row straight from the browser
-- (src/lib/queries/expenses.ts:650, src/lib/queries/vendor-bills.ts:223). Nothing checked
-- what hung off it:
--   (a) the bank line matched to it (bank_transactions.matched_to_type 'expense' /
--       'vendor_bill') stayed "reconciled" to a row that no longer existed — money gone
--       from the bank, booked nowhere, and the line never came back to Unreconciled;
--   (b) emi_payments / business_loan_payments / employee_loan_repayments / tax_payments /
--       reimbursements / expense_claims / fixed_assets point at the expense with
--       ON DELETE SET NULL, so the EMI interest, the loan interest, the challan, the asset
--       stayed while its cost dropped out of the P&L (Trial Balance off by that amount);
--   (c) a salary expense was caught by the baseline trigger tg_expense_delete_guards_salary,
--       which silently UN-PAID the salary as a side effect of an Expenses-page delete.
--
-- Now (CLAUDE.md §17b / §17c / §24):
--   * public.delete_expense(id) / public.delete_vendor_bill(id) — ONE security-definer
--     transaction, role gate (the Purchases roles: owner, manager, billing, accountant —
--     src/lib/nav.ts PURCHASES), tenant guard fails closed, books lock still applies (the
--     trg_books_lock trigger fires on the delete inside).
--   * Linked record (salary, EMI, loan, tax challan, reimbursement, claim, fixed asset,
--     open payment run) → REFUSED, naming the record and the page where it is undone. Never
--     a silent cascade. The refusal carries HINT = that page's path; the app turns it into
--     the button.
--   * Bank-matched → REFUSED with "un-reconcile that bank line first" — the same rule as
--     delete_payment (20261018164416_r1567…:564-568) and delete_salary_payment. Rule
--     chosen over auto-un-reconcile because the matched line is often one the app itself
--     wrote (pay_vendor_bill, mark_payment_run_paid): silently freeing it would leave a
--     bank debit nobody asked about. After the owner un-reconciles in Banking, the delete
--     goes through and the line sits in Unreconciled, visible, for re-booking.
--   * Backstops for any other caller of a plain DELETE:
--       - tg_expense_delete_guards_salary now refuses every linked record for app callers
--         (anon / authenticated); trusted sessions (service_role, psql, tenant cascade) keep
--         the old behaviour exactly.
--       - trg_vendor_bill_delete_guard: same for a bill in an open payment run.
--       - trg_expense_no_orphan_bank_match / trg_vendor_bill_no_orphan_bank_match:
--         DEFERRED constraint triggers — at commit, no bank line may still be matched to the
--         deleted row. Deferred, so flows that delete then unmatch in the same transaction
--         (delete_employee_advance) keep working.
-- Test: supabase/tests/r1577_delete_expense_bill_links.test.sql
-- ============================================================================

-- Lookups the guards make on every delete.
create index if not exists bank_txn_matched_doc_idx
  on public.bank_transactions (tenant_id, matched_to_type, matched_to_id)
  where matched_to_id is not null;

-- ─── What blocks deleting this expense (null = nothing) ──────────────────────
-- Internal: called only from security-definer code (the RPC and the trigger below).
create or replace function public.expense_delete_blocker(p_tenant uuid, p_id text, out o_msg text, out o_href text)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  r record;
begin
  select coalesce(e.name, 'employee') as who, sp.period
    into r
    from public.salary_payments sp left join public.employees e on e.id = sp.employee_id
   where sp.tenant_id = p_tenant and sp.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s ki %s ki salary ka hai — ise Expenses se delete nahi kar sakte (salary ''Paid'' dikhti aur uska kharcha P&L se gayab ho jaata). Payroll me us salary par Undo dabao — salary aur ye kharcha dono saath hat jaayenge.', r.who, r.period);
    o_href := '/accounting/payroll';
    return;
  end if;

  select coalesce(p.name, 'EMI') as what, ep.paid_on, ep.amount
    into r
    from public.emi_payments ep left join public.emi_purchases p on p.id = ep.purchase_id
   where ep.tenant_id = p_tenant and ep.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha EMI "%s" ki %s wali kist (₹%s) ka byaaj hai — ise akele delete karne se kist bachi rehti par byaaj books se gayab ho jaata. Assets & EMIs page par wo EMI kholo.', r.what, to_char(r.paid_on, 'DD Mon YYYY'), r.amount);
    o_href := '/accounting/assets';
    return;
  end if;

  select coalesce(l.lender, 'loan') as what, lp.paid_on, lp.amount
    into r
    from public.business_loan_payments lp left join public.business_loans l on l.id = lp.loan_id
   where lp.tenant_id = p_tenant and lp.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s loan ki %s wali EMI (₹%s) ka byaaj hai — ise akele delete karne se EMI bachi rehti par byaaj books se gayab ho jaata. Business Loans page par wo loan kholo.', r.what, to_char(r.paid_on, 'DD Mon YYYY'), r.amount);
    o_href := '/accounting/business-loans';
    return;
  end if;

  select coalesce(l.employee_name, 'employee') as who, rp.repaid_on, rp.amount
    into r
    from public.employee_loan_repayments rp left join public.employee_loans l on l.id = rp.loan_id
   where rp.tenant_id = p_tenant and rp.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s ke loan ki %s wali wapsi (₹%s) se juda hai — ise akele delete karne se loan ka hisaab toot jaata. Loans & Salary Advances page par wo loan kholo.', r.who, to_char(r.repaid_on, 'DD Mon YYYY'), r.amount);
    o_href := '/accounting/loans';
    return;
  end if;

  select tp.kind, coalesce(tp.period, '') as period, tp.paid_on
    into r
    from public.tax_payments tp
   where tp.tenant_id = p_tenant and tp.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s tax challan (%s, %s) ka hai — ise akele delete karne se challan bacha rehta par uska kharcha books se gayab ho jaata. Banking me us challan ki bank line par Un-reconcile dabao — challan aur ye kharcha dono saath hat jaayenge.', upper(r.kind), nullif(r.period, ''), to_char(r.paid_on, 'DD Mon YYYY'));
    o_href := '/accounting/banking';
    return;
  end if;

  select rb.person_name, rb.purpose
    into r
    from public.reimbursements rb
   where rb.tenant_id = p_tenant and rb.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha %s ke reimbursement (%s) ka hai — ise akele delete karne se reimbursement bacha rehta. Reimbursements page par wo reimbursement delete karo — ye kharcha bhi saath hat jaayega.', r.person_name, r.purpose);
    o_href := '/accounting/reimbursements';
    return;
  end if;

  select ec.amount, ec.spent_on
    into r
    from public.expense_claims ec
   where ec.tenant_id = p_tenant and ec.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha ek employee claim (₹%s, %s) se bana hai — ise akele delete karne se claim ''approved'' rehta aur advance ka hisaab toot jaata. Loans & Salary Advances page par wo claim kholo.', r.amount, to_char(r.spent_on, 'DD Mon YYYY'));
    o_href := '/accounting/loans';
    return;
  end if;

  select fa.name
    into r
    from public.fixed_assets fa
   where fa.tenant_id = p_tenant and fa.expense_id = p_id limit 1;
  if found then
    o_msg := format('Ye kharcha fixed asset "%s" ki khareed hai — ise delete karne se asset register me rehta par uski khareed books se gayab ho jaati. Assets & EMIs page par pehle wo asset hatao, phir ye kharcha.', r.name);
    o_href := '/accounting/assets';
    return;
  end if;

  select pr.run_no, pr.status
    into r
    from public.payment_run_items it join public.payment_runs pr on pr.id = it.run_id
   where it.tenant_id = p_tenant and it.source = 'expense' and it.doc_id = p_id
     and pr.status in ('draft', 'approved') limit 1;
  if found then
    o_msg := format('Ye kharcha payment run %s (%s) me hai — delete karne par run ise bina kharche ke pay kar deta. Payment Runs me wo run cancel karo, phir ye kharcha delete karo.', r.run_no, r.status);
    o_href := '/accounting/payment-runs';
    return;
  end if;
end;
$function$;

revoke all on function public.expense_delete_blocker(uuid, text) from public, anon, authenticated;
grant execute on function public.expense_delete_blocker(uuid, text) to service_role;

-- ─── What blocks deleting this vendor bill (null = nothing) ──────────────────
create or replace function public.vendor_bill_delete_blocker(p_tenant uuid, p_id text, out o_msg text, out o_href text)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  r record;
begin
  select pr.run_no, pr.status
    into r
    from public.payment_run_items it join public.payment_runs pr on pr.id = it.run_id
   where it.tenant_id = p_tenant and it.source = 'vendor_bill' and it.doc_id = p_id
     and pr.status in ('draft', 'approved') limit 1;
  if found then
    o_msg := format('Ye bill payment run %s (%s) me hai — delete karne par run ise bina bill ke pay kar deta. Payment Runs me wo run cancel karo, phir ye bill delete karo.', r.run_no, r.status);
    o_href := '/accounting/payment-runs';
  end if;
end;
$function$;

revoke all on function public.vendor_bill_delete_blocker(uuid, text) from public, anon, authenticated;
grant execute on function public.vendor_bill_delete_blocker(uuid, text) to service_role;

-- ─── The bank line still matched to a row (null = none) ──────────────────────
create or replace function public.matched_bank_line_blocker(p_tenant uuid, p_type text, p_id text, out o_msg text, out o_href text)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  t record;
begin
  select bt.txn_date, greatest(bt.debit, bt.credit) as amt, bt.description, bt.bank_account_id
    into t
    from public.bank_transactions bt
   where bt.tenant_id = p_tenant and bt.matched_to_type = p_type and bt.matched_to_id = p_id
   order by bt.txn_date limit 1;
  if found then
    o_msg := format('Ye %s bank line (%s · ₹%s · %s) se match hai — delete karne par wo line ''reconciled'' reh jaati aur paisa kisi kharche me nahi dikhta. Pehle Banking me us line par Un-reconcile dabao, phir ye %s delete karo.',
      case p_type when 'vendor_bill' then 'bill' else 'kharcha' end,
      to_char(t.txn_date, 'DD Mon YYYY'), t.amt, left(coalesce(t.description, ''), 60),
      case p_type when 'vendor_bill' then 'bill' else 'kharcha' end);
    o_href := '/accounting/banking/' || t.bank_account_id::text;
  end if;
end;
$function$;

revoke all on function public.matched_bank_line_blocker(uuid, text, text) from public, anon, authenticated;
grant execute on function public.matched_bank_line_blocker(uuid, text, text) to service_role;

-- ─── delete_expense ──────────────────────────────────────────────────────────
create or replace function public.delete_expense(p_id text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_exp    public.expenses;
  b        record;
begin
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'billing', 'accountant') then
    raise exception 'Only an owner, manager, billing or accountant user can delete an expense' using errcode = '42501';
  end if;
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  select * into v_exp from public.expenses where id = p_id for update;
  if not found then
    raise exception 'Ye kharcha nahi mila — shayad pehle hi delete ho chuka. Page refresh karo.' using errcode = 'no_data_found';
  end if;
  if not v_trusted and v_exp.tenant_id is distinct from v_tenant then
    raise exception 'Expense not in your company' using errcode = 'insufficient_privilege';
  end if;

  select * into b from public.expense_delete_blocker(v_exp.tenant_id, v_exp.id);
  if b.o_msg is not null then
    raise exception '%', b.o_msg using errcode = 'invalid_parameter_value', hint = b.o_href;
  end if;

  select * into b from public.matched_bank_line_blocker(v_exp.tenant_id, 'expense', v_exp.id);
  if b.o_msg is not null then
    raise exception '%', b.o_msg using errcode = 'invalid_parameter_value', hint = b.o_href;
  end if;
  if v_exp.reconciled_txn_id is not null then
    -- reverse link only (the line points elsewhere now, or an older row): name that line
    select format('Ye kharcha bank line (%s · ₹%s) se juda hai — pehle Banking me us line par Un-reconcile dabao, phir ye kharcha delete karo.',
                  to_char(bt.txn_date, 'DD Mon YYYY'), greatest(bt.debit, bt.credit)) as o_msg,
           '/accounting/banking/' || bt.bank_account_id::text as o_href
      into b
      from public.bank_transactions bt where bt.id = v_exp.reconciled_txn_id;
    if found then
      raise exception '%', b.o_msg using errcode = 'invalid_parameter_value', hint = b.o_href;
    end if;
  end if;

  delete from public.expenses where id = v_exp.id and tenant_id = v_exp.tenant_id;
end;
$function$;

revoke all on function public.delete_expense(text) from public, anon;
grant execute on function public.delete_expense(text) to authenticated, service_role;

comment on function public.delete_expense(text) is
  'R-1577: delete one expense in one transaction. Refuses (HINT = page to undo it) when a salary, EMI, loan, tax challan, reimbursement, claim, fixed asset or open payment run uses it, or a bank line is matched to it — un-reconcile first (delete_payment rule). Owner/manager/billing/accountant; books lock applies.';

-- ─── delete_vendor_bill ──────────────────────────────────────────────────────
create or replace function public.delete_vendor_bill(p_id text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_bill   public.vendor_bills;
  b        record;
begin
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'billing', 'accountant') then
    raise exception 'Only an owner, manager, billing or accountant user can delete a bill' using errcode = '42501';
  end if;
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  select * into v_bill from public.vendor_bills where id = p_id for update;
  if not found then
    raise exception 'Ye bill nahi mila — shayad pehle hi delete ho chuka. Page refresh karo.' using errcode = 'no_data_found';
  end if;
  if not v_trusted and v_bill.tenant_id is distinct from v_tenant then
    raise exception 'Bill not in your company' using errcode = 'insufficient_privilege';
  end if;

  select * into b from public.vendor_bill_delete_blocker(v_bill.tenant_id, v_bill.id);
  if b.o_msg is not null then
    raise exception '%', b.o_msg using errcode = 'invalid_parameter_value', hint = b.o_href;
  end if;
  select * into b from public.matched_bank_line_blocker(v_bill.tenant_id, 'vendor_bill', v_bill.id);
  if b.o_msg is not null then
    raise exception '%', b.o_msg using errcode = 'invalid_parameter_value', hint = b.o_href;
  end if;

  delete from public.vendor_bills where id = v_bill.id and tenant_id = v_bill.tenant_id;
end;
$function$;

revoke all on function public.delete_vendor_bill(text) from public, anon;
grant execute on function public.delete_vendor_bill(text) to authenticated, service_role;

comment on function public.delete_vendor_bill(text) is
  'R-1577: delete one vendor bill in one transaction. Refuses (HINT = page) when an open payment run holds it or a bank line is matched to it (its payment) — un-reconcile first (delete_payment rule). Owner/manager/billing/accountant; books lock applies.';

-- ─── Backstop 1: app callers can never orphan a linked record with a plain DELETE ───
-- Same function name and trigger as baseline (trg_expense_delete_guards_salary); trusted
-- sessions keep the baseline body unchanged.
create or replace function public.tg_expense_delete_guards_salary()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_sp public.salary_payments;
  b    record;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    select * into b from public.expense_delete_blocker(OLD.tenant_id, OLD.id);
    if b.o_msg is not null then
      raise exception '%', b.o_msg using errcode = 'invalid_parameter_value', hint = b.o_href;
    end if;
    return OLD;
  end if;

  -- trusted session (service_role / psql / tenant cascade): baseline behaviour
  select * into v_sp from public.salary_payments where expense_id = OLD.id;
  if found then
    if v_sp.reconciled_txn_id is not null then
      raise exception 'This salary is reconciled to a bank transaction — un-reconcile that bank line first (or undo from Payroll).'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_sp.advance_recovered > 0 and v_sp.advance_loan_id is not null then
      delete from public.employee_loan_repayments
       where tenant_id = v_sp.tenant_id and loan_id = v_sp.advance_loan_id
         and method = 'salary_deduction' and amount = v_sp.advance_recovered
         and repaid_on = v_sp.pay_date and notes = 'Recovered from salary ' || v_sp.period;
      update public.employee_loans set status = 'active', updated_at = now()
       where id = v_sp.advance_loan_id;
    end if;
    delete from public.salary_payments where id = v_sp.id;
  end if;
  return OLD;
end;
$function$;

create or replace function public.tg_vendor_bill_delete_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  b record;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    select * into b from public.vendor_bill_delete_blocker(OLD.tenant_id, OLD.id);
    if b.o_msg is not null then
      raise exception '%', b.o_msg using errcode = 'invalid_parameter_value', hint = b.o_href;
    end if;
  end if;
  return OLD;
end;
$function$;

drop trigger if exists trg_vendor_bill_delete_guard on public.vendor_bills;
create trigger trg_vendor_bill_delete_guard
  before delete on public.vendor_bills
  for each row execute function public.tg_vendor_bill_delete_guard();

-- ─── Backstop 2: at commit, no bank line may still be matched to a deleted row ───
create or replace function public.tg_no_orphan_bank_match()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  b record;
begin
  select * into b from public.matched_bank_line_blocker(OLD.tenant_id, tg_argv[0], OLD.id);
  if b.o_msg is not null then
    raise exception '%', b.o_msg using errcode = 'invalid_parameter_value', hint = b.o_href;
  end if;
  return null;
end;
$function$;

drop trigger if exists trg_expense_no_orphan_bank_match on public.expenses;
create constraint trigger trg_expense_no_orphan_bank_match
  after delete on public.expenses
  deferrable initially deferred
  for each row execute function public.tg_no_orphan_bank_match('expense');

drop trigger if exists trg_vendor_bill_no_orphan_bank_match on public.vendor_bills;
create constraint trigger trg_vendor_bill_no_orphan_bank_match
  after delete on public.vendor_bills
  deferrable initially deferred
  for each row execute function public.tg_no_orphan_bank_match('vendor_bill');
