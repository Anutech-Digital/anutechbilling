-- 0186 — Reconcile one money-out line as SALARY + EMPLOYEE ADVANCE (overpayment)
--
-- Real case: an employee's salary is ₹90,000 but ₹1,50,000 was transferred by
-- mistake. The single bank debit is part salary (expense) + part advance (a
-- recoverable asset). Neither the plain salary-match (over-pay guard blocks it)
-- nor "book whole line as advance" is correct. This splits ONE line atomically:
--   • the salary portion is applied to the chosen salary (paid/partial), and
--   • the excess is booked as an employee salary-advance — WITHOUT a new cash
--     leg, because THIS bank line already IS the cash-out.
-- The line is then marked reconciled (matched_to_type='split').

create or replace function public.reconcile_salary_advance_split(
  p_txn_id         uuid,
  p_salary_id      uuid,
  p_advance_amount integer,
  p_employee_name  text,
  p_notes          text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_txn public.bank_transactions%rowtype;
  v_sal public.salary_payments%rowtype;
  v_salary_portion integer;
begin
  select * into v_txn from public.bank_transactions where id = p_txn_id and tenant_id = v_tenant;
  if not found then raise exception 'Bank line not found'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'Only a money-out line can be split into salary + advance'; end if;

  select * into v_sal from public.salary_payments where id = p_salary_id and tenant_id = v_tenant;
  if not found then raise exception 'Salary not found'; end if;

  if p_advance_amount is null or p_advance_amount <= 0 then raise exception 'Advance amount must be positive'; end if;
  v_salary_portion := v_txn.debit - p_advance_amount;
  if v_salary_portion <= 0 then raise exception 'Salary portion must be positive'; end if;
  if v_salary_portion > (v_sal.net - v_sal.paid_amount) then
    raise exception 'Salary portion (%) is more than the % still due on this salary',
      v_salary_portion, (v_sal.net - v_sal.paid_amount);
  end if;

  -- 1. Apply the salary portion to the salary (paid_amount + status).
  update public.salary_payments
     set paid_amount = paid_amount + v_salary_portion,
         paid_status = case
           when paid_amount + v_salary_portion >= net then 'paid'
           when paid_amount + v_salary_portion <= 0   then 'unpaid'
           else 'partial' end,
         reconciled_txn_id = p_txn_id
   where id = p_salary_id;

  -- 2. Book the excess as a recoverable salary-advance. No new bank leg — this
  --    line is the cash-out; disburse_employee_loan would double-count it.
  insert into public.employee_loans
    (tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind, notes, created_by)
  values
    (v_tenant, trim(coalesce(p_employee_name, 'Employee')), p_advance_amount, v_txn.txn_date, v_txn.bank_account_id,
     'salary_advance', coalesce(nullif(trim(p_notes), ''), 'Salary overpaid — excess booked as recoverable advance'), auth.uid());

  -- 3. Mark the bank line reconciled as a split. (matched_to_type='salary' would
  --    make the trigger add the WHOLE debit to the salary — hence 'split' here.)
  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null,
         match_confidence = 'manual', matched_at = now(), matched_by = auth.uid()
   where id = p_txn_id;
end;
$$;

grant execute on function public.reconcile_salary_advance_split(uuid, uuid, integer, text, text) to authenticated;
