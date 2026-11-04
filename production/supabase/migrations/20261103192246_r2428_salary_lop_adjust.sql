-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.adjust_salary_lop(uuid,numeric,integer,text)') and prosrc like '%R-2428%')
-- deploy-key: r2428salarylop
-- 20261103192246_r2428_salary_lop_adjust.sql
--
-- R-2428 (3 Nov 2026) — set a salary record to the amount actually paid, as loss of pay.
--
-- Staging Anutech, 3 Nov: Keshav Malik left in his first month; his full & final of ₹19,056
-- was paid against a ₹24,358 salary record. The bank line could be linked (the record went
-- "partially paid", ₹5,302 still owed) but nothing could bring the record down to what was
-- really paid: "Edit salary" is undo + pay again, and undo is refused once a bank line is
-- linked. So the books kept a false ₹5,302 payable.
--
-- adjust_salary_lop(salary, lop_days, lop_amount, reason) — one transaction (§17b):
--   • new LOP on the record (replaces the old LOP; days and amount both ≥ 0);
--   • earned = gross − LOP + incentive (as pay_salary), net = earned − the record's own
--     deductions (unchanged); refused when net < 0 or net < what the bank already paid;
--   • the booked Salaries expense follows the new earned amount (accrual stays in its month);
--   • paid_status re-derived from paid_amount vs the new net — the same rule as
--     sync_salary_paid_status (paid when paid_amount ≥ net, partial when > 0, else unpaid);
--     a record that becomes fully paid gets its latest linked bank line as reconciled_txn_id;
--   • the reason is required and kept in the record's notes with the date.
-- Refused on a record already fully paid (nothing owed to adjust). Roles as pay_salary
-- (owner / manager / accountant, R-717); tenant from current_tenant_id().
-- Test: supabase/tests/r2428_salary_lop_adjust.test.sql (rolled back).

begin;

create or replace function public.adjust_salary_lop(
  p_salary_id uuid,
  p_lop_days numeric,
  p_lop_amount integer,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_sal     public.salary_payments;
  v_name    text;
  v_lop     integer := coalesce(p_lop_amount, -1);
  v_days    numeric := round(coalesce(p_lop_days, 0), 1);
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
  v_earned  integer;
  v_net     integer;
  v_status  text;
  v_last_txn uuid;
  v_trusted boolean;
begin
  /* R-2428: role gate — the same as pay_salary (R-717). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can edit a salary' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context' using errcode = '42501'; end if;
  if v_lop < 0 then raise exception 'Loss of pay cannot be below ₹0.'; end if;
  if v_days < 0 then raise exception 'Loss-of-pay days cannot be below 0.'; end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Say why the salary is changed (e.g. left mid-month, full & final paid).';
  end if;

  select * into v_sal from public.salary_payments
   where id = p_salary_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Salary record not found'; end if;
  select e.name into v_name from public.employees e where e.id = v_sal.employee_id;

  if v_sal.paid_status = 'paid' then
    raise exception '%''s % salary is already fully paid — nothing is owed to adjust.', v_name, v_sal.period;
  end if;
  if v_lop > v_sal.gross then
    raise exception 'Loss of pay (₹%) cannot be more than the gross salary (₹%).', v_lop, v_sal.gross;
  end if;

  v_earned := greatest(v_sal.gross - v_lop, 0) + v_sal.incentive;
  v_net := v_earned - v_sal.advance_recovered - v_sal.tds - v_sal.pf - v_sal.esi - v_sal.other_deduction;
  if v_net < 0 then
    raise exception 'Deductions (₹%) would be more than the earned pay (₹%).',
      v_sal.advance_recovered + v_sal.tds + v_sal.pf + v_sal.esi + v_sal.other_deduction, v_earned;
  end if;
  if v_net < v_sal.paid_amount then
    raise exception 'The bank has already paid ₹% on this salary — the net cannot go below that (it would be ₹%).',
      v_sal.paid_amount, v_net;
  end if;

  v_status := case when v_sal.paid_amount >= v_net and v_sal.paid_amount > 0 then 'paid'
                   when v_sal.paid_amount > 0 then 'partial'
                   when v_net = 0 then 'paid'
                   else 'unpaid' end;
  if v_status = 'paid' and v_sal.paid_amount > 0 then
    select t.id into v_last_txn from public.bank_transactions t
     where t.tenant_id = v_tenant
       and ((t.matched_to_type = 'salary' and t.matched_to_id = v_sal.id::text)
            or (t.matched_to_type = 'expense' and v_sal.expense_id is not null and t.matched_to_id = v_sal.expense_id))
     order by t.txn_date desc, t.id desc limit 1;
  end if;

  update public.salary_payments
     set lop_days = v_days,
         lop_amount = v_lop,
         net = v_net,
         paid_status = v_status,
         reconciled_txn_id = case when v_status = 'paid' then coalesce(v_last_txn, reconciled_txn_id) else reconciled_txn_id end,
         notes = concat_ws(E'\n', nullif(trim(coalesce(notes, '')), ''),
                           'LOP set to ₹' || v_lop || ' (' || v_days || ' days) on ' || to_char(public.ist_today(), 'DD Mon YYYY') || ': ' || v_reason)
   where id = v_sal.id;

  if v_sal.expense_id is not null then
    update public.expenses set amount = v_earned
     where id = v_sal.expense_id and tenant_id = v_tenant;
  end if;

  return jsonb_build_object('salary_id', v_sal.id, 'net', v_net, 'earned', v_earned,
                            'paid_amount', v_sal.paid_amount, 'paid_status', v_status);
end;
$$;

comment on function public.adjust_salary_lop(uuid, numeric, integer, text) is
  'R-2428: set loss of pay on an unpaid / part-paid salary record so its net is what was really paid; expense and paid status follow. Atomic.';

revoke all on function public.adjust_salary_lop(uuid, numeric, integer, text) from public, anon;
grant execute on function public.adjust_salary_lop(uuid, numeric, integer, text) to authenticated, service_role;

commit;
