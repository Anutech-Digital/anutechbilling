-- 0125: partial salary payments
-- ============================================================================
-- A salary can now be paid in PARTS (e.g. cash crunch: ₹70k now of a ₹90k
-- salary, the ₹20k balance owed and paid later). `net` stays the full earned
-- amount; a new `paid_amount` tracks how much has actually cleared the bank,
-- and `paid_status` derives:
--     unpaid   paid_amount = 0
--     partial  0 < paid_amount < net
--     paid     paid_amount >= net
--
-- The bank-line trigger becomes AMOUNT-BASED: each reconciled money-out line
-- adds its debit to the matched salary's paid_amount; un-reconcile subtracts.
-- A full match (debit == net) lands straight on 'paid' — backward compatible.

alter table public.salary_payments
  add column if not exists paid_amount integer not null default 0;

-- Backfill: already-paid rows are paid in full; everything else has nothing paid.
update public.salary_payments set paid_amount = net
 where paid_status = 'paid' and paid_amount = 0;

-- Allow the new 'partial' state.
alter table public.salary_payments drop constraint if exists salary_payments_paid_status_check;
alter table public.salary_payments
  add constraint salary_payments_paid_status_check
  check (paid_status = any (array['unpaid'::text, 'partial'::text, 'paid'::text]));

-- ── Amount-based sync trigger ───────────────────────────────────────────────
create or replace function public.sync_salary_paid_status()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old_sal uuid;
  v_new_sal uuid;
begin
  -- Which salary (if any) did the OLD / NEW match point at?
  -- A 'salary' match carries the salary id directly; an 'expense' match
  -- carries the salary's booked expense_id.
  if tg_op = 'UPDATE' and old.matched_to_type = 'salary' and old.matched_to_id is not null then
    v_old_sal := old.matched_to_id::uuid;
  elsif tg_op = 'UPDATE' and old.matched_to_type = 'expense' and old.matched_to_id is not null then
    select id into v_old_sal from public.salary_payments
     where expense_id = old.matched_to_id and tenant_id = old.tenant_id;
  end if;

  if new.matched_to_type = 'salary' and new.matched_to_id is not null then
    v_new_sal := new.matched_to_id::uuid;
  elsif new.matched_to_type = 'expense' and new.matched_to_id is not null then
    select id into v_new_sal from public.salary_payments
     where expense_id = new.matched_to_id and tenant_id = new.tenant_id;
  end if;

  -- Remove the OLD contribution when the match moved away from that salary
  -- (un-reconcile, or re-pointed to a different record).
  if v_old_sal is not null and v_old_sal is distinct from v_new_sal then
    update public.salary_payments
       set paid_amount = greatest(0, paid_amount - old.debit),
           paid_status = case
             when greatest(0, paid_amount - old.debit) <= 0   then 'unpaid'
             when greatest(0, paid_amount - old.debit) >= net then 'paid'
             else 'partial' end,
           reconciled_txn_id = case when reconciled_txn_id = old.id then null else reconciled_txn_id end
     where id = v_old_sal;
  end if;

  -- Add the NEW contribution when the match landed on a salary.
  if v_new_sal is not null and (tg_op = 'INSERT' or v_new_sal is distinct from v_old_sal) then
    update public.salary_payments
       set paid_amount = paid_amount + new.debit,
           paid_status = case
             when paid_amount + new.debit >= net then 'paid'
             when paid_amount + new.debit <= 0   then 'unpaid'
             else 'partial' end,
           -- Only stamp the "the line that completed it" reference once fully paid.
           reconciled_txn_id = case when paid_amount + new.debit >= net then new.id else reconciled_txn_id end
     where id = v_new_sal;
  end if;

  -- SPLIT reversal: a split reconcile (reconcile_expenses_to_bank_txn) marks its
  -- matched salaries paid + stamps reconciled_txn_id directly (it doesn't use a
  -- per-salary bank line), so undo it here when the split line is un-reconciled.
  if tg_op = 'UPDATE' and old.matched_to_type = 'split' and new.matched_to_type is null then
    update public.salary_payments
       set paid_status = 'unpaid', paid_amount = 0, reconciled_txn_id = null
     where reconciled_txn_id = old.id;
    update public.expenses set reconciled_txn_id = null where reconciled_txn_id = old.id;
  end if;

  return new;
end;
$function$;

-- ── Split reconcile also sets paid_amount = net for its salaries ─────────────
create or replace function public.reconcile_expenses_to_bank_txn(p_bank_txn_id uuid, p_expense_ids text[])
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn    public.bank_transactions;
  v_sum    integer;
  v_cnt    integer;
  v_want   integer := coalesce(array_length(p_expense_ids, 1), 0);
begin
  select * into v_txn from public.bank_transactions where id = p_bank_txn_id;
  if not found then raise exception 'Bank transaction not found'; end if;
  if v_tenant is not null and v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_txn.debit <= 0 then
    raise exception 'Only a money-out (debit) line can be matched to expenses' using errcode = 'invalid_parameter_value';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled — un-reconcile it first' using errcode = 'invalid_parameter_value';
  end if;
  if v_want < 1 then raise exception 'Pick at least one expense to match'; end if;

  select coalesce(sum(amount), 0), count(*) into v_sum, v_cnt
  from public.expenses
  where id = any (p_expense_ids) and tenant_id = v_txn.tenant_id and reconciled_txn_id is null;

  if v_cnt <> v_want then
    raise exception 'Some selected expenses are missing or already reconciled — refresh and try again'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_sum <> v_txn.debit then
    raise exception 'Selected expenses total % but this bank line is % — they must add up exactly', v_sum, v_txn.debit
      using errcode = 'invalid_parameter_value';
  end if;

  update public.expenses set reconciled_txn_id = p_bank_txn_id
   where id = any (p_expense_ids) and tenant_id = v_txn.tenant_id;

  update public.salary_payments sp
     set paid_status = 'paid', paid_amount = sp.net, reconciled_txn_id = p_bank_txn_id
   where sp.tenant_id = v_txn.tenant_id and sp.expense_id = any (p_expense_ids) and sp.paid_status <> 'paid';

  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null,
         matched_at = now(), matched_by = auth.uid(), match_confidence = 'manual'
   where id = p_bank_txn_id;
end;
$function$;

-- ── Undo guard: block while ANY money is reconciled against the salary ───────
create or replace function public.delete_salary_payment(p_salary_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sp     public.salary_payments;
begin
  select * into v_sp from public.salary_payments where id = p_salary_id;
  if not found then raise exception 'Salary payment not found'; end if;
  if v_tenant is not null and v_sp.tenant_id is distinct from v_tenant then
    raise exception 'Salary payment not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  -- A partially-paid salary has bank line(s) reconciled against it even when
  -- reconciled_txn_id is still null (only the completing line stamps it), so
  -- guard on paid_amount, not just reconciled_txn_id.
  if v_sp.paid_amount > 0 then
    raise exception 'This salary has % reconciled against it — un-reconcile that bank line first, then undo.', v_sp.paid_amount
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

  delete from public.salary_payments where id = p_salary_id;

  if v_sp.expense_id is not null then
    delete from public.expenses where id = v_sp.expense_id and tenant_id = v_sp.tenant_id;
  end if;
end;
$function$;
