-- deploy-peek: to_regprocedure('public.salary_tds_lock(uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_salary_payment(uuid)') and prosrc like '%app.r2812_salary_edit%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.edit_salary_payment(uuid,uuid,text,date,integer,numeric,integer,integer,uuid,integer,integer,integer,integer,uuid,text,integer,integer,integer,integer,integer)') and prosrc like '%salary_tds_lock%')
-- deploy-key: r2812salarytdsdepositedlock
-- 20261114110000_r2812_salary_tds_deposited_lock.sql
--
-- R-2812 (p1 money, 14 Nov 2026 — independent review of R-2772, finding F3; R-2771 followUp 3).
--
-- THE GAP. delete_salary_payment (payroll "Undo salary") checked the bank link and the books lock
-- only. A salary whose TDS the government already has — the month's TDS challan is booked, or the
-- quarter's 24Q is marked filed — could still be undone, and edit_salary_payment (R-2772, the
-- one-step Edit the Salary Register is about to call) is one more door to it. After that the
-- challan, the filed 24Q and Form 16 no longer match the books.
--
-- THE RULE (only salaries with TDS > 0; TDS 0 works as before).
--   "Deposited" = a TDS challan for the salary month: statutory_dues_payments kind 'tds' / 'mixed'
--     with period = the salary month (the challan the 24Q working picks, tds-24q.ts), or kind 'tds'
--     with no period paid in the following month (the R-1920 vendor lock's rule).
--   "Filed" = the quarter's TDS return is marked filed: Compliance calendar (compliance_log,
--     obligation tds_return, period <fyStart>-q<n>) or the Month close tick tds_return_filed on
--     any month of that quarter. Both can be un-marked by the owner (that is the way back).
--   Undo  -> refused with a plain message naming the challan / quarter + HINT (the page to fix it).
--   Edit  -> deposited: allowed while the TDS stays the same (the challan still matches);
--            filed: allowed while the 24Q figures stay the same (pay date, gross, LOP amount,
--            incentive, TDS — what the 24Q working reads); anything else is refused and,
--            as the whole Edit is one transaction, nothing changes.
--   How Edit gets past its own Undo half: edit_salary_payment writes a transaction-local setting
--   app.r2812_salary_edit = <that salary id> after it read the row and checked the TDS; the lock in
--   delete_salary_payment skips only that id. The data gateway runs only public-schema RPCs, each
--   in its own transaction, so an app session cannot set it for a direct Undo.
--
--   1. salary_tds_lock(p_salary_id) — the shared check (security definer, read-only). An app
--      session sees only its own company's salaries and only with a payroll role (owner / manager /
--      accountant, as salary_payments RLS); anything else gets an empty answer.
--   2. delete_salary_payment = R-2772 body (20261114083830) + the lock (+ one declare).
--   3. edit_salary_payment = R-2772 body + the TDS / 24Q checks around its Undo + Pay. Still
--      SECURITY INVOKER.
--
-- No data is changed. Role checks call public.current_request_role() directly (R-2487).
-- Test: supabase/tests/r2812_salary_tds_deposited_lock.test.sql (rolled back).

begin;

-- ── 1. salary_tds_lock: is this salary's TDS already deposited / in a filed 24Q? ───────────────
create or replace function public.salary_tds_lock(p_salary_id uuid,
  out o_kind text, out o_what text, out o_href text, out o_name text, out o_month text)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  s        public.salary_payments;
  v_m      date;
  v_mon    integer;
  v_fy     integer;
  v_q      integer;
  v_qstart date;
  v_filed  date;
  d        record;
begin
  /* R-2812. o_kind = 'filed' (24Q of the quarter marked filed) or 'deposited' (TDS challan for the
     month), else null. Filed wins: it is the stricter one. */
  if p_salary_id is null then return; end if;
  select * into s from public.salary_payments where id = p_salary_id;
  if not found or coalesce(s.tds, 0) <= 0 then return; end if;
  -- App sessions: own company + payroll role only (the trusted test is delete_salary_payment's).
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and (s.tenant_id is distinct from public.current_tenant_id()
          or not public.current_user_has_role('owner', 'manager', 'accountant')) then
    return;
  end if;

  v_m   := to_date(s.period || '-01', 'YYYY-MM-DD');
  v_mon := extract(month from v_m)::integer;
  v_fy  := case when v_mon >= 4 then extract(year from v_m)::integer else extract(year from v_m)::integer - 1 end;
  v_q   := case when v_mon between 4 and 6 then 1 when v_mon between 7 and 9 then 2
                when v_mon between 10 and 12 then 3 else 4 end;
  v_qstart := make_date(case when v_q = 4 then v_fy + 1 else v_fy end,
                        case v_q when 1 then 4 when 2 then 7 when 3 then 10 else 1 end, 1);
  select e.name into o_name from public.employees e where e.id = s.employee_id;
  o_name  := coalesce(o_name, 'this employee');
  o_month := to_char(v_m, 'Mon YYYY');

  select c.filed_date into v_filed from public.compliance_log c
   where c.tenant_id = s.tenant_id and c.obligation_key = 'tds_return' and c.period_key = v_fy || '-q' || v_q
   limit 1;
  if v_filed is null then
    select (m.done_at at time zone 'Asia/Kolkata')::date into v_filed from public.month_close_checks m
     where m.tenant_id = s.tenant_id and m.key = 'tds_return_filed'
       and m.period in (to_char(v_qstart, 'YYYY-MM'), to_char(v_qstart + interval '1 month', 'YYYY-MM'),
                        to_char(v_qstart + interval '2 months', 'YYYY-MM'))
     order by m.done_at limit 1;
  end if;
  if v_filed is not null then
    o_kind := 'filed';
    o_what := format('The 24Q for Q%s FY %s-%s (%s – %s) is marked filed (%s)', v_q, v_fy, lpad(((v_fy + 1) % 100)::text, 2, '0'),
                     to_char(v_qstart, 'Mon'), to_char(v_qstart + interval '2 months', 'Mon YYYY'), to_char(v_filed, 'DD Mon YYYY'));
    o_href := '/compliance';
    return;
  end if;

  select x.challan_no, x.amount, x.paid_on, x.bank_account_id into d
    from public.statutory_dues_payments x
   where x.tenant_id = s.tenant_id
     and ((x.kind in ('tds', 'mixed') and x.period = s.period)
          or (x.kind = 'tds' and x.period is null
              and date_trunc('month', x.paid_on)::date = (v_m + interval '1 month')::date))
   order by x.paid_on, x.created_at, x.id
   limit 1;
  if found then
    o_kind := 'deposited';
    o_what := format('TDS challan%s of ₹%s paid on %s for %s', coalesce(' ' || d.challan_no, ''), d.amount,
                     to_char(d.paid_on, 'DD Mon YYYY'), o_month);
    o_href := case when d.bank_account_id is not null then '/accounting/banking/' || d.bank_account_id::text
                   else '/accounting/banking' end;
  end if;
end;
$function$;

revoke all on function public.salary_tds_lock(uuid) from public, anon;
grant execute on function public.salary_tds_lock(uuid) to authenticated, service_role;

-- ── 2. delete_salary_payment: R-2772 body + the TDS lock ────────────────────────────────────────
create or replace function public.delete_salary_payment(p_salary_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_sp     public.salary_payments;
  v_name   text;
  v_date   date;
  v_pf_id  text;
  v_esi_id text;
  v_e      record;
  v_kind   text;
  v_href   text;
  v_run    text;
  v_lock   record;
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — payroll group (R-717 rule): owner, manager, accountant).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can undo a salary payment' using errcode = '42501';
  end if;
  -- R-2772: hold the row while it is undone (a second Undo / Edit waits for this one and then
  -- finds nothing).
  select * into v_sp from public.salary_payments where id = p_salary_id for update;
  if not found then raise exception 'Salary payment not found'; end if;
  if (v_tenant is null and coalesce(public.current_request_role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_sp.tenant_id is distinct from v_tenant) then
    raise exception 'Salary payment not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if v_sp.paid_amount > 0 then
    raise exception 'This salary has % reconciled against it — un-reconcile that bank line first, then undo.', v_sp.paid_amount
      using errcode = 'invalid_parameter_value';
  end if;

  /* R-2812: salary TDS the government already has — the month's TDS challan is booked, or the
     quarter's 24Q is marked filed. Undo would leave the challan / the filed return with TDS the
     books no longer carry. edit_salary_payment skips this for its own salary only (it then
     checks that the new booking keeps the same TDS / 24Q figures) — the transaction-local
     setting is written only there, after it read this row. */
  if v_sp.tds > 0 and coalesce(current_setting('app.r2812_salary_edit', true), '') is distinct from p_salary_id::text then
    select * into v_lock from public.salary_tds_lock(p_salary_id);
    if v_lock.o_kind = 'filed' then
      raise exception '% and has %''s % salary in it (TDS ₹%). Undoing it would make the books differ from the filed return. If this salary really was wrong: file a correction 24Q (your CA / RPU), mark that 24Q not filed (Compliance page, or untick it in Month close), then undo. To change only the bank account, notes or PF / ESI / other deductions, use Edit.',
        v_lock.o_what, v_lock.o_name, v_lock.o_month, v_sp.tds
        using errcode = 'check_violation', hint = v_lock.o_href;
    elsif v_lock.o_kind = 'deposited' then
      raise exception 'The ₹% TDS on %''s % salary is already deposited (%). Undoing it would leave that challan with no salary TDS behind it. To change other figures, use Edit and keep the TDS at ₹%. If the TDS itself was wrong, un-reconcile the challan''s bank line first (Banking), then undo.',
        v_sp.tds, v_lock.o_name, v_lock.o_month, v_lock.o_what, v_sp.tds
        using errcode = 'check_violation', hint = v_lock.o_href;
    end if;
  end if;

  /* R-2772: the employer PF / ESI expense rows pay_salary booked for THIS salary.
     Linked (booked since R-2772) → by id. Not linked (booked before) → the one row of this company
     that pay_salary would have written for this salary: same category, 'statutory', the salary
     row's employer figure, the salary's expense date (salary month since 20260927170000, the pay
     date before that, or the date its own Salaries expense carries), pay_salary's description for
     the month and the name on this salary's own Salaries expense; never a row another salary is
     linked to. The picked row is locked, so two Undos can never pick the same one. No match (the
     row was edited or deleted by hand) → nothing else is deleted; the report script lists it. */
  v_pf_id  := v_sp.pf_employer_expense_id;
  v_esi_id := v_sp.esi_employer_expense_id;
  if (v_pf_id is null and v_sp.pf_employer > 0) or (v_esi_id is null and v_sp.esi_employer > 0) then
    select e.vendor_name, e.expense_date into v_name, v_date from public.expenses e
     where e.id = v_sp.expense_id and e.tenant_id = v_sp.tenant_id;
    if v_name is null then
      select emp.name into v_name from public.employees emp where emp.id = v_sp.employee_id;
    end if;
    if v_pf_id is null and v_sp.pf_employer > 0 then
      select e.id into v_pf_id from public.expenses e
       where e.tenant_id = v_sp.tenant_id and e.category = 'PF — Employer' and e.payment_method = 'statutory'
         and e.amount = v_sp.pf_employer and e.vendor_name = v_name
         and e.expense_date in (public.salary_expense_date(v_sp.period, v_sp.pay_date), v_sp.pay_date, v_date)
         and e.description = 'PF employer contribution ' || v_sp.period || ' — ' || v_name
         and not exists (select 1 from public.salary_payments s where s.pf_employer_expense_id = e.id)
       order by e.created_at desc, e.id desc limit 1
       for update;
    end if;
    if v_esi_id is null and v_sp.esi_employer > 0 then
      select e.id into v_esi_id from public.expenses e
       where e.tenant_id = v_sp.tenant_id and e.category = 'ESI — Employer' and e.payment_method = 'statutory'
         and e.amount = v_sp.esi_employer and e.vendor_name = v_name
         and e.expense_date in (public.salary_expense_date(v_sp.period, v_sp.pay_date), v_sp.pay_date, v_date)
         and e.description = 'ESI employer contribution ' || v_sp.period || ' — ' || v_name
         and not exists (select 1 from public.salary_payments s where s.esi_employer_expense_id = e.id)
       order by e.created_at desc, e.id desc limit 1
       for update;
    end if;
  end if;

  /* An employer row that is itself matched to a bank line, in an open payment run, or marked paid:
     say which and where (HINT = the page with the button), undo nothing. */
  for v_e in
    select e.id, coalesce(e.paid_amount, 0) as paid, e.reconciled_txn_id from public.expenses e
     where e.tenant_id = v_sp.tenant_id and e.id in (v_pf_id, v_esi_id)
     order by e.id
     for update
  loop
    v_kind := case when v_e.id = v_pf_id then 'PF' else 'ESI' end;
    select b.o_href into v_href from public.matched_bank_line_blocker(v_sp.tenant_id, 'expense', v_e.id) b;
    if v_href is not null or v_e.reconciled_txn_id is not null then
      raise exception 'The employer % cost of this salary is matched to a bank line — un-reconcile that bank line first, then undo.', v_kind
        using errcode = 'invalid_parameter_value', hint = coalesce(v_href, '/accounting/banking');
    end if;
    select pr.run_no into v_run
      from public.payment_run_items it join public.payment_runs pr on pr.id = it.run_id
     where it.tenant_id = v_sp.tenant_id and it.source = 'expense' and it.doc_id = v_e.id
       and pr.status in ('draft', 'approved') limit 1;
    if v_run is not null then
      raise exception 'The employer % cost of this salary is in payment run % — cancel that run (or take it out) first, then undo.', v_kind, v_run
        using errcode = 'invalid_parameter_value', hint = '/accounting/payment-runs';
    end if;
    if v_e.paid > 0 then
      raise exception 'The employer % cost of this salary is marked paid (₹%) — undo that payment on the Expenses page first, then undo.', v_kind, v_e.paid
        using errcode = 'invalid_parameter_value', hint = '/accounting/expenses';
    end if;
  end loop;

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
  -- By id: a linked row is this salary's row even if its category was edited on the Expenses page.
  if v_pf_id is not null then
    delete from public.expenses where id = v_pf_id and tenant_id = v_sp.tenant_id;
  end if;
  if v_esi_id is not null then
    delete from public.expenses where id = v_esi_id and tenant_id = v_sp.tenant_id;
  end if;
end;
$function$;

revoke all on function public.delete_salary_payment(uuid) from public, anon;
grant execute on function public.delete_salary_payment(uuid) to authenticated, service_role;

-- ── 3. edit_salary_payment: R-2772 body + the TDS / 24Q checks ──────────────────────────────────
create or replace function public.edit_salary_payment(p_salary_id uuid, p_employee_id uuid, p_period text, p_pay_date date, p_gross integer, p_lop_days numeric, p_lop_amount integer, p_advance_recovered integer, p_advance_loan_id uuid, p_tds integer, p_pf integer, p_esi integer, p_other integer, p_bank_account_id uuid, p_notes text DEFAULT NULL::text, p_incentive integer DEFAULT 0, p_esi_employer integer DEFAULT 0, p_pf_employer integer DEFAULT 0, p_pf_wage integer DEFAULT NULL, p_arrears integer DEFAULT 0)
 returns uuid
 language plpgsql
 security invoker
 set search_path to 'public'
as $function$
declare
  v_old   public.salary_payments;
  v_new   public.salary_payments;
  v_id    uuid;
  v_kind  text;
  v_what  text;
  v_href  text;
  v_name  text;
  v_month text;
  v_msg   text;
begin
  /* R-2772: one call = one transaction. Both halves are the existing RPCs (their role and company
     checks, bank-link refusal, arrears limit, books lock all apply); if the new booking raises,
     the Undo is rolled back with it — the month never ends up without its salary. */
  select s.* into v_old from public.salary_payments s where s.id = p_salary_id;
  if not found then
    -- Not there, or not readable by this login (RLS: owner / manager / accountant of the company).
    if coalesce(public.current_request_role(), '') in ('anon', 'authenticated')
       and not public.current_user_has_role('owner', 'manager', 'accountant') then
      raise exception 'Only an owner, manager or accountant can edit a salary' using errcode = '42501';
    end if;
    raise exception 'Salary payment not found';
  end if;
  if v_old.employee_id is distinct from p_employee_id or v_old.period is distinct from p_period then
    raise exception 'Edit changes this month''s salary only — to move it to another month or employee, undo it and pay again.'
      using errcode = 'invalid_parameter_value';
  end if;

  /* R-2812: TDS the government already has. Deposited → the TDS must stay the same; 24Q filed →
     the 24Q figures (pay date, gross, LOP amount, incentive, TDS) must stay the same. Only then,
     and only for this salary, does the Undo half skip its own TDS lock. */
  if v_old.tds > 0 then
    select l.o_kind, l.o_what, l.o_href, l.o_name, l.o_month into v_kind, v_what, v_href, v_name, v_month
      from public.salary_tds_lock(p_salary_id) l;
  end if;
  if v_kind = 'filed' then
    v_msg := format('%s and has %s''s %s salary in it (TDS ₹%s). Edit can change only what the 24Q does not carry (bank account, notes, PF / ESI / other deductions) — the pay date, gross, LOP, incentive and TDS stay as filed. If they really were wrong: file a correction 24Q (your CA / RPU), mark that 24Q not filed (Compliance page, or untick it in Month close), then edit.',
                    v_what, v_name, v_month, v_old.tds);
  elsif v_kind = 'deposited' then
    v_msg := format('The ₹%s TDS on %s''s %s salary is already deposited (%s). Edit can change this salary but not its TDS — keep it at ₹%s. If the TDS itself was wrong, un-reconcile the challan''s bank line first (Banking), then edit.',
                    v_old.tds, v_name, v_month, v_what, v_old.tds);
  end if;
  if v_kind is not null then
    if greatest(coalesce(p_tds, 0), 0) <> v_old.tds then
      raise exception '%', v_msg using errcode = 'check_violation', hint = v_href;
    end if;
    perform set_config('app.r2812_salary_edit', p_salary_id::text, true);
  end if;

  perform public.delete_salary_payment(p_salary_id);
  if v_kind is not null then
    perform set_config('app.r2812_salary_edit', '', true);
  end if;
  v_id := public.pay_salary_with_arrears(p_employee_id, p_period, p_pay_date, p_gross, p_lop_days, p_lop_amount,
                                         p_advance_recovered, p_advance_loan_id, p_tds, p_pf, p_esi, p_other,
                                         p_bank_account_id, p_notes, p_incentive, p_esi_employer, p_pf_employer,
                                         p_pf_wage, p_arrears);
  if v_kind is not null then
    select * into v_new from public.salary_payments where id = v_id;
    if v_new.tds is distinct from v_old.tds
       or (v_kind = 'filed' and (v_new.pay_date, v_new.gross, v_new.lop_amount, v_new.incentive)
                                is distinct from (v_old.pay_date, v_old.gross, v_old.lop_amount, v_old.incentive)) then
      -- raising here rolls back the Undo and the new booking with it
      raise exception '%', v_msg using errcode = 'check_violation', hint = v_href;
    end if;
  end if;
  return v_id;
end;
$function$;

revoke all on function public.edit_salary_payment(uuid, uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer, integer) from public, anon;
grant execute on function public.edit_salary_payment(uuid, uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer, integer) to authenticated, service_role;

commit;
