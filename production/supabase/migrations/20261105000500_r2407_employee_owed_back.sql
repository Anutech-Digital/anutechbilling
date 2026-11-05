-- deploy-peek: to_regprocedure('public.reconcile_salary_with_owed_back(uuid,uuid,uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_employee_advance(uuid,text,text,uuid,uuid,text)') and prosrc like '%R-2407%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_employee_advance_line_unmatched()') and prosrc like '%R-2407%')
-- deploy-key: r2407employeeowedback
--
-- R-2407 (Pardeep, 3 Nov 2026) — staging 4523, 26 Oct: UPI Neelam ₹16,000 came IN. She had paid
-- the company by mistake; it went back to her later, added to her salary. The Reconcile sheet had
-- no right place: "Employee return" listed only employees with an open advance (Neelam had none),
-- "Other income" puts it in the P&L, and "Mark reconciled manually" makes the later salary payout
-- book ₹16,000 of extra salary expense.
--
-- ══ THE ACCOUNTING ══════════════════════════════════════════════════════════════════════
--   Money an employee paid in by mistake is neither income nor an advance coming back: the company
--   now OWES it back to her — a payable. The employee-advance system (R-1871) already has its
--   payable side: a pending row in reimbursements is "owed to the employee" and shows on the
--   Balance Sheet as Reimbursements payable (report_balance_sheet: sum of pending amounts). So
--   the ₹16,000 is booked there — pending, NO expense (expense_id null, so the P&L does not move),
--   with the employee's id. No new ledger.
--   When the money goes back inside her salary transfer (₹30,000 salary + ₹16,000 = ₹46,000 line),
--   that one line is split: the salary part pays the salary (no extra salary expense — the salary
--   was already booked for its month) and the rest settles the payable.
--
-- ══ WHAT THIS CHANGES (no stored data is changed) ═══════════════════════════════════════
--   1. employee_advance_bank_links: a new kind 'owed_back' (money-in → payable). Like
--      'reimburse' it carries the reimbursement, never an advance. New nullable columns
--      salary_payment_id + salary_amount: the salary part a salary + owed-back line paid.
--   2. book_bank_txn_as_employee_advance ← 20261024202000_r1871_employee_advance_bank (latest;
--      checked all anutech/* branches: no later redefinition). Body unchanged, plus kind
--      'owed_back': money-in line, p_name = an employee of the company (any, not only one with an
--      open advance) → pending reimbursement "Paid to the company by mistake — owed back", line
--      reconciled as manual 'reimbursement:<id>' (the same shape R-1871's reimburse uses).
--   3. reconcile_salary_with_owed_back(p_txn_id, p_salary_id, p_reimbursement_id) — new: one
--      money-out line = salary part + a payable owed to the SAME employee. Salary paid_amount +
--      salary part (never more than still due), the payable settled, line matched 'split' (no id —
--      'salary' would make trg_sync_salary_paid add the WHOLE debit to the salary), and an R-1871
--      link kind 'reimburse' carrying the salary part.
--   4. tg_employee_advance_line_unmatched ← 20261024202000_r1871 (latest). Body unchanged, plus
--      'owed_back': un-reconciling / deleting the money-in line removes its payable — refused while
--      the payable is already paid back (un-reconcile that payout first); and 'reimburse' with a
--      salary part: the payable is pending again AND exactly that part comes off the salary (it runs
--      before trg_sync_salary_paid and clears reconciled_txn_id, so R-2472's 'split' branch — which
--      zeroes paid_amount — finds nothing; earlier payments on the salary stay). Also on DELETE.
--   5. trg_reimbursement_owed_back_guard (new, BEFORE DELETE on reimbursements): an owed-back
--      payable made by a bank line is removed only by un-reconciling that line (else the line stays
--      reconciled to nothing and the Balance Sheet loses the liability).
--
-- R-2472 (20261104090200) is respected, not redefined: reconcile_bank_txn, sync_salary_paid_status
-- and trg_bank_match_target_company are untouched. The lines here are matched 'manual' / 'split',
-- which trg_bank_match_target_company leaves to the definer flow — and both functions below check
-- every id (line, salary, payable, employee) against the caller's company themselves.
-- Guard: no company → 28000 (fail closed, before any row is read); money roles owner / manager /
-- accountant (the R-1871 bank choices); bank line, salary and payable locked FOR UPDATE; books
-- lock: trg_books_lock on bank_transactions / salary_payments / reimbursements (R-1584).
-- Proof: supabase/tests/r2407_employee_owed_back.test.sql (one rollback; red without this file).

begin;

-- ── 1. A new link kind ──────────────────────────────────────────────────────────────────
alter table public.employee_advance_bank_links drop constraint if exists employee_advance_bank_links_kind_check;
alter table public.employee_advance_bank_links add constraint employee_advance_bank_links_kind_check
  check (kind in ('give', 'top_up', 'return', 'reimburse', 'owed_back'));
alter table public.employee_advance_bank_links drop constraint if exists employee_advance_bank_links_check;
alter table public.employee_advance_bank_links add constraint employee_advance_bank_links_check
  check ((kind in ('reimburse', 'owed_back')) = (reimbursement_id is not null and advance_id is null));

-- The salary part a salary + owed-back line paid, so un-reconciling / deleting that line takes back
-- exactly that part — not the whole salary (R-2472's 'split' branch would set paid_amount to 0).
alter table public.employee_advance_bank_links
  add column if not exists salary_payment_id uuid references public.salary_payments(id) on delete set null,
  add column if not exists salary_amount     integer check (salary_amount is null or salary_amount > 0);

comment on table public.employee_advance_bank_links is
  'R-1871: bank line ↔ employee office-expense advance movement (give / top-up / return) or reimbursement paid. R-2407: owed_back = money an employee paid in by mistake (a payable). Un-reconcile reverses it.';

-- ── 2. Bank line → advance / return / reimbursement / owed back ──────────────────────────
create or replace function public.book_bank_txn_as_employee_advance(
  p_txn_id            uuid,
  p_kind              text,
  p_name              text default null,
  p_advance_id        uuid default null,
  p_reimbursement_id  uuid default null,
  p_note              text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_txn      public.bank_transactions;
  v_adv      public.prepaid_advances;
  v_reimb    public.reimbursements;
  v_emp      public.employees;
  v_emp_id   uuid;
  v_id       uuid;
  v_amount   integer;
  v_left     integer;
  v_result   integer;
begin
  /* R-1871: §17c guard + the advance money roles (give / top-up / settle refuse anyone else). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can book an employee advance from the bank' using errcode = '42501';
  end if;
  /* R-2407: 'owed_back' = money an employee paid in by mistake → owed back to them (a payable). */
  if p_kind is null or p_kind not in ('give', 'top_up', 'return', 'reimburse', 'owed_back') then
    raise exception 'Pick what this line is: advance given, top-up, advance returned, reimbursement or owed back to the employee.';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled — un-reconcile it first.'; end if;
  if exists (select 1 from public.bank_accounts where id = v_txn.bank_account_id and account_type = 'cash') then
    raise exception 'This is a Petty Cash line. Give or top up from Petty Cash on Accounting → Advances — it adds the cash line itself.';
  end if;

  if p_kind in ('give', 'top_up', 'reimburse') then
    v_amount := coalesce(v_txn.debit, 0);
    if v_amount <= 0 then raise exception 'Money given to an employee must be a money-out line.'; end if;
  else
    v_amount := coalesce(v_txn.credit, 0);
    if v_amount <= 0 then raise exception 'Money returned by an employee must be a money-in line.'; end if;
  end if;

  if p_kind = 'give' then
    if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Pick the employee who got the money.'; end if;
    -- The Advances page's own RPC. The line's account is a bank (not cash) → no extra cash line.
    v_id := public.give_employee_advance(trim(p_name), v_amount, v_txn.txn_date, 'bank_transfer', v_txn.bank_account_id,
                                         coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Office expenses'));
    update public.prepaid_advances set bank_txn_id = p_txn_id where id = v_id;
    v_result := v_amount;

  elsif p_kind = 'owed_back' then
    /* R-2407: any employee of THIS company (an active one first when two share a name). */
    if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Pick the employee who paid this money in.'; end if;
    -- p_name: the employee's id (the Reconcile sheet sends it — two people can share a name) or name.
    v_emp_id := case when trim(p_name) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then trim(p_name)::uuid end;
    select * into v_emp from public.employees
     where tenant_id = v_tenant
       and (id = v_emp_id or (v_emp_id is null and lower(trim(name)) = lower(trim(p_name))))
     order by is_active desc nulls last, created_at
     limit 1;
    if not found then
      raise exception 'That person is not an employee of your company. Add them on Payroll → Employees first.';
    end if;
    insert into public.reimbursements
      (tenant_id, person_name, purpose, category, amount, gst_paid, incurred_on, paid_via, status, employee_id, created_by)
    values
      (v_tenant, v_emp.name,
       left('Paid to the company by mistake — owed back (bank line ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ')'
            || coalesce(' · ' || nullif(trim(coalesce(p_note, '')), ''), ''), 500),
       'Owed to employee', v_amount, 0, v_txn.txn_date, 'Bank (money in)', 'pending', v_emp.id, auth.uid())
    returning * into v_reimb;
    v_result := v_amount;

  elsif p_kind in ('top_up', 'return') then
    select * into v_adv from public.prepaid_advances
     where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
    if not found then raise exception 'Pick the employee''s advance — that one is not in your company.'; end if;
    v_id := v_adv.id;

    if p_kind = 'top_up' then
      v_result := public.top_up_employee_advance(v_adv.id, v_amount, v_txn.txn_date, v_txn.bank_account_id);
    else
      if v_adv.closed_at is not null then raise exception 'The advance with % is already settled.', v_adv.vendor_name; end if;
      v_left := v_adv.total_amount - v_adv.consumed_amount;
      if v_amount > v_left then
        raise exception 'Only ₹% is still with %. A return of ₹% is more than that — book the extra as something else.', v_left, v_adv.vendor_name, v_amount;
      end if;
      if v_amount = v_left then
        -- The whole balance came back: the Advances page's Settle (advance closed).
        perform public.settle_employee_advance(v_adv.id, v_txn.txn_date, v_txn.bank_account_id);
        v_result := 0;
      else
        -- Part of it came back; the rest stays with the employee (carried forward).
        update public.prepaid_advances
           set total_amount = total_amount - v_amount, updated_at = now(),
               notes = concat_ws(E'\n', notes, 'Returned ₹' || v_amount || ' on ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
                                                || ' · ₹' || (v_left - v_amount) || ' still with them')
         where id = v_adv.id;
        v_result := v_left - v_amount;
      end if;
    end if;

  else -- reimburse
    select * into v_reimb from public.reimbursements
     where id = p_reimbursement_id and tenant_id = v_tenant for update;
    if not found then raise exception 'Pick the reimbursement — that one is not in your company.'; end if;
    if v_reimb.status <> 'pending' then raise exception 'That reimbursement is already paid.'; end if;
    if v_reimb.amount <> v_amount then
      raise exception 'The reimbursement is ₹% but this line is ₹%. Pick the matching one.', v_reimb.amount, v_amount;
    end if;
    perform public.settle_reimbursement(v_reimb.id, v_txn.txn_date, 'Paid by bank line ' || to_char(v_txn.txn_date, 'DD Mon YYYY'));
    v_result := 0;
  end if;

  update public.bank_transactions
     set matched_to_type  = case when p_kind = 'owed_back' then 'manual'
                                 when p_kind = 'reimburse' then
                              case when v_reimb.expense_id is not null then 'expense' else 'manual' end
                            else 'prepaid' end,
         matched_to_id    = case when p_kind = 'owed_back' then 'reimbursement:' || v_reimb.id::text
                                 when p_kind = 'reimburse' then coalesce(v_reimb.expense_id, 'reimbursement:' || v_reimb.id::text)
                            else v_id::text end,
         match_confidence = 'manual', matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;
  if p_kind = 'reimburse' and v_reimb.expense_id is not null then
    update public.expenses set reconciled_txn_id = p_txn_id where id = v_reimb.expense_id and tenant_id = v_tenant;
  end if;

  insert into public.employee_advance_bank_links (tenant_id, bank_txn_id, kind, advance_id, reimbursement_id, amount, created_by)
  values (v_tenant, p_txn_id, p_kind, case when p_kind in ('reimburse', 'owed_back') then null else v_id end,
          case when p_kind in ('reimburse', 'owed_back') then v_reimb.id end, v_amount, auth.uid());

  return jsonb_build_object('kind', p_kind, 'advance_id', case when p_kind in ('reimburse', 'owed_back') then null else v_id end,
                            'reimbursement_id', case when p_kind in ('reimburse', 'owed_back') then v_reimb.id end,
                            'employee', case when p_kind = 'owed_back' then v_emp.name end,
                            'amount', v_amount, 'left', v_result);
end;
$$;

revoke all on function public.book_bank_txn_as_employee_advance(uuid, text, text, uuid, uuid, text) from public, anon;
grant execute on function public.book_bank_txn_as_employee_advance(uuid, text, text, uuid, uuid, text) to authenticated, service_role;

-- ── 3. Salary payout that also pays back what is owed to the employee ─────────────────────
create or replace function public.reconcile_salary_with_owed_back(
  p_txn_id            uuid,
  p_salary_id         uuid,
  p_reimbursement_id  uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trusted  boolean;
  v_tenant   uuid := public.current_tenant_id();
  v_txn      public.bank_transactions;
  v_sal      public.salary_payments;
  v_emp      public.employees;
  v_reimb    public.reimbursements;
  v_due      integer;
  v_part     integer;
begin
  /* R-2407: same guard + roles as the R-1871 bank choices; fail closed with no company. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can reconcile a salary with money owed back' using errcode = '42501';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then raise exception 'Bank line not found in your company.'; end if;
  if v_txn.matched_to_type is not null then raise exception 'This line is already reconciled — un-reconcile it first.'; end if;
  if coalesce(v_txn.debit, 0) <= 0 then raise exception 'A salary payout must be a money-out line.'; end if;

  select * into v_sal from public.salary_payments where id = p_salary_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Salary not found in your company.'; end if;
  select * into v_emp from public.employees where id = v_sal.employee_id and tenant_id = v_tenant;

  select * into v_reimb from public.reimbursements where id = p_reimbursement_id and tenant_id = v_tenant for update;
  if not found then raise exception 'What is owed to the employee was not found in your company.'; end if;
  if v_reimb.status <> 'pending' then
    raise exception 'The ₹% owed to % is already paid (%).', v_reimb.amount, v_reimb.person_name, coalesce(to_char(v_reimb.settled_on, 'DD Mon YYYY'), 'settled');
  end if;
  -- The payable must be the salary's own employee (by id; by name for an old row with no id).
  if not (v_reimb.employee_id = v_sal.employee_id
          or (v_reimb.employee_id is null and lower(trim(v_reimb.person_name)) = lower(trim(coalesce(v_emp.name, ''))))) then
    raise exception 'That ₹% is owed to %, not to %. Pick the salary of the same employee.',
      v_reimb.amount, v_reimb.person_name, coalesce(v_emp.name, 'this employee');
  end if;

  v_due  := v_sal.net - coalesce(v_sal.paid_amount, 0);
  v_part := v_txn.debit - v_reimb.amount;
  if v_part <= 0 then
    raise exception 'This line (₹%) is not more than the ₹% owed — book it as the reimbursement alone.', v_txn.debit, v_reimb.amount;
  end if;
  if v_part > v_due then
    raise exception 'The salary part (₹% = ₹% − ₹% owed back) is more than the ₹% still due on % · %.',
      v_part, v_txn.debit, v_reimb.amount, v_due, coalesce(v_emp.name, 'this salary'), v_sal.period;
  end if;

  -- 1. The salary part pays the salary (no new salary expense — it was booked for its month).
  update public.salary_payments
     set paid_amount = coalesce(paid_amount, 0) + v_part,
         paid_status = case when coalesce(paid_amount, 0) + v_part >= net then 'paid' else 'partial' end,
         reconciled_txn_id = p_txn_id
   where id = v_sal.id and tenant_id = v_tenant;

  -- 2. The rest settles what was owed back (the payable goes to 0).
  update public.reimbursements
     set status = 'settled', settled_on = v_txn.txn_date,
         settled_notes = 'Paid back with ' || coalesce(v_emp.name, 'the employee') || '''s salary ' || v_sal.period
                         || ' · bank line ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
   where id = v_reimb.id and tenant_id = v_tenant;
  if v_reimb.expense_id is not null then
    update public.expenses set reconciled_txn_id = p_txn_id where id = v_reimb.expense_id and tenant_id = v_tenant;
  end if;

  -- 3. The line is a split (salary + payable). 'salary' would add the WHOLE debit to the salary.
  update public.bank_transactions
     set matched_to_type = 'split', matched_to_id = null, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = p_txn_id;

  -- 4. Un-reconcile / delete → the payable is pending again and exactly the salary part is taken
  --    back from the salary (R-1871 trigger, kind 'reimburse' + salary_payment_id).
  insert into public.employee_advance_bank_links
    (tenant_id, bank_txn_id, kind, advance_id, reimbursement_id, amount, salary_payment_id, salary_amount, created_by)
  values (v_tenant, p_txn_id, 'reimburse', null, v_reimb.id, v_reimb.amount, v_sal.id, v_part, auth.uid());

  return jsonb_build_object('salary_id', v_sal.id, 'salary_part', v_part, 'reimbursement_id', v_reimb.id,
                            'owed_back', v_reimb.amount, 'employee', coalesce(v_emp.name, v_reimb.person_name),
                            'salary_left', v_due - v_part);
end;
$$;

revoke all on function public.reconcile_salary_with_owed_back(uuid, uuid, uuid) from public, anon;
grant execute on function public.reconcile_salary_with_owed_back(uuid, uuid, uuid) to authenticated, service_role;

-- ── 4. Un-reconcile / delete of a linked line reverses its movement ───────────────────────
create or replace function public.tg_employee_advance_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link  public.employee_advance_bank_links;
  v_adv   public.prepaid_advances;
  v_reimb public.reimbursements;
begin
  if tg_op = 'UPDATE' and not (old.matched_to_type is not null
       and (new.matched_to_type is distinct from old.matched_to_type or new.matched_to_id is distinct from old.matched_to_id)) then
    return null;
  end if;
  select * into v_link from public.employee_advance_bank_links where bank_txn_id = old.id;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    return null;
  end if;

  if v_link.kind = 'top_up' then
    select * into v_adv from public.prepaid_advances where id = v_link.advance_id for update;
    if found then
      if v_adv.total_amount - v_link.amount < v_adv.consumed_amount then
        raise exception 'Bills of ₹% are already booked against % and the advance would go below that. Remove those bills first, then un-reconcile.',
          v_adv.consumed_amount, v_adv.vendor_name;
      end if;
      update public.prepaid_advances
         set total_amount = total_amount - v_link.amount, updated_at = now(),
             notes = concat_ws(E'\n', notes, 'Top-up ₹' || v_link.amount || ' undone (bank line un-reconciled)')
       where id = v_adv.id;
    end if;
  elsif v_link.kind = 'return' then
    update public.prepaid_advances
       set total_amount = total_amount + v_link.amount, closed_at = null, updated_at = now(),
           notes = concat_ws(E'\n', notes, 'Return ₹' || v_link.amount || ' undone (bank line un-reconciled)')
     where id = v_link.advance_id;
  elsif v_link.kind = 'reimburse' then
    update public.reimbursements set status = 'pending', settled_on = null, settled_notes = null
     where id = v_link.reimbursement_id;
    update public.expenses set reconciled_txn_id = null where reconciled_txn_id = old.id;
    /* R-2407: a salary + owed-back line also takes back exactly its salary part. This trigger runs
       before trg_sync_salary_paid (name order), whose 'split' branch then finds no salary pointing
       at the line (reconciled_txn_id cleared here) — so earlier payments on the salary stay. */
    if v_link.salary_payment_id is not null and coalesce(v_link.salary_amount, 0) > 0 then
      update public.salary_payments
         set paid_amount = greatest(0, coalesce(paid_amount, 0) - v_link.salary_amount),
             paid_status = case
               when greatest(0, coalesce(paid_amount, 0) - v_link.salary_amount) <= 0   then 'unpaid'
               when greatest(0, coalesce(paid_amount, 0) - v_link.salary_amount) >= net then 'paid'
               else 'partial' end,
             reconciled_txn_id = case when reconciled_txn_id = old.id then null else reconciled_txn_id end
       where id = v_link.salary_payment_id and tenant_id = old.tenant_id;
    end if;
  elsif v_link.kind = 'owed_back' then
    /* R-2407: the money-in line is no longer "owed back" → its payable goes, unless it was
       already paid back (then the payout that settled it must be un-reconciled first). */
    select * into v_reimb from public.reimbursements
     where id = v_link.reimbursement_id and tenant_id = old.tenant_id for update;
    if found then
      if v_reimb.status <> 'pending' then
        raise exception 'The ₹% owed back to % was already paid back (%). Undo that payment first (un-reconcile the salary or payout line that paid it).',
          v_reimb.amount, v_reimb.person_name, coalesce(to_char(v_reimb.settled_on, 'DD Mon YYYY'), 'settled');
      end if;
      delete from public.employee_advance_bank_links where id = v_link.id;
      delete from public.reimbursements where id = v_reimb.id and tenant_id = old.tenant_id;
    end if;
  end if;

  delete from public.employee_advance_bank_links where id = v_link.id;
  if tg_op = 'DELETE' then return old; end if;
  return null;
end;
$$;

revoke all on function public.tg_employee_advance_line_unmatched() from public, anon;

-- ── 5. An owed-back payable that a bank line made is removed only through that line ─────────
-- (Reimbursements page Delete would cascade the link away and leave the money-in line reconciled
--  to nothing — the Balance Sheet would lose the liability while the bank keeps the cash.)
create or replace function public.tg_reimbursement_owed_back_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
begin
  /* R-2407: the un-reconcile trigger above deletes the link first, so it passes here. A whole
     company being removed (cascade from tenants) is not stopped. */
  if not exists (select 1 from public.tenants where id = old.tenant_id) then return old; end if;
  select t.* into v_txn
    from public.employee_advance_bank_links l
    join public.bank_transactions t on t.id = l.bank_txn_id
   where l.reimbursement_id = old.id and l.kind = 'owed_back' and l.tenant_id = old.tenant_id
   limit 1;
  if found then
    raise exception 'This ₹% owed back to % came from the bank line of % (₹%). Un-reconcile that bank line instead — it removes this too.',
      old.amount, old.person_name, to_char(v_txn.txn_date, 'DD Mon YYYY'), v_txn.credit
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

revoke all on function public.tg_reimbursement_owed_back_guard() from public, anon, authenticated;

drop trigger if exists trg_reimbursement_owed_back_guard on public.reimbursements;
create trigger trg_reimbursement_owed_back_guard
  before delete on public.reimbursements
  for each row execute function public.tg_reimbursement_owed_back_guard();

commit;
