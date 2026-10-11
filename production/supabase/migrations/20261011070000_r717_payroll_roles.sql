-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.pay_salary(uuid,text,date,integer,numeric,integer,integer,uuid,integer,integer,integer,integer,uuid,text,integer,integer,integer,integer)') and prosrc like '%R-717%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.set_employee_pin(uuid,text)') and prosrc like '%R-717%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.give_employee_advance(text,integer,date,text,uuid,text)') and prosrc like '%R-717%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.top_up_employee_advance(uuid,integer,date,uuid)') and prosrc like '%R-717%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.settle_employee_advance(uuid,date,uuid)') and prosrc like '%R-717%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.approve_expense_claim(uuid)') and prosrc like '%R-717%')
-- deploy-key: r717payroll
-- 20261011070000_r717_payroll_roles.sql
--
-- R-717 (P1 SECURITY, audit 10 Oct 2026): payroll / PIN / advance / expense-claim definers
-- check the caller's ROLE, not just the company.
--
-- ══ WHAT WAS OPEN, measured on the local DB 11 Oct ═══════════════════════════════
--
--   pay_salary                 SECURITY DEFINER, checked only the tenant. salary_payments
--                              writes are owner/manager/accountant by RLS (20260930175000),
--                              but a definer skips RLS — any member (sales, support,
--                              billing, delivery…) could book a salary, an expense and an
--                              advance recovery.
--   set_employee_pin           tenant only. A sales/support login could reset a colleague's
--                              attendance-kiosk PIN and then punch in for them.
--   give / top_up / settle_employee_advance, approve_expense_claim
--                              tenant only — any member could move petty cash / advances
--                              or approve a claim against an advance.
--
-- ══ WHAT CHANGES (guards only — bodies are the newest definitions, money maths untouched) ═
--
--   pay_salary, give_employee_advance, top_up_employee_advance, settle_employee_advance,
--   approve_expense_claim  → current_user_has_role('owner', 'manager', 'accountant')
--                            (MONEY_WRITE_ROLES in src/lib/nav.ts; billing is read-only on
--                            payroll since R-254).
--   set_employee_pin       → current_user_has_role('owner', 'manager').
--   Trust rule as R-454 / R-714: service_role or a direct DB session with no request role
--   is trusted (no caller today — every caller is the signed-in browser client); anyone
--   else without the role, including a null-caller, is refused with SQLSTATE 42501.
--   Tenant match is unchanged in every body.
--
-- Sources of the bodies: pay_salary 20260927180000; the three advance functions
-- 20261001150000; approve_expense_claim + set_employee_pin baseline.sql. No later
-- migration redefines any of them (re-checked 11 Oct). Signatures unchanged → grants
-- are re-stated, not changed.
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161).
-- Test: supabase/tests/r717_payroll_roles.test.sql (rolled back).

begin;

create or replace function public.pay_salary(p_employee_id uuid, p_period text, p_pay_date date, p_gross integer, p_lop_days numeric, p_lop_amount integer, p_advance_recovered integer, p_advance_loan_id uuid, p_tds integer, p_pf integer, p_esi integer, p_other integer, p_bank_account_id uuid, p_notes text DEFAULT NULL::text, p_incentive integer DEFAULT 0, p_esi_employer integer DEFAULT 0, p_pf_employer integer DEFAULT 0, p_pf_wage integer DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_emp public.employees;
  v_gross integer := greatest(coalesce(p_gross,0),0);
  v_lop_amt integer := greatest(coalesce(p_lop_amount,0),0);
  v_inc integer := greatest(coalesce(p_incentive,0),0);
  v_adv integer := greatest(coalesce(p_advance_recovered,0),0);
  v_tds integer := greatest(coalesce(p_tds,0),0);
  v_pf integer := greatest(coalesce(p_pf,0),0);
  v_esi integer := greatest(coalesce(p_esi,0),0);
  v_esi_emp integer := greatest(coalesce(p_esi_employer,0),0);
  v_pf_emp integer := greatest(coalesce(p_pf_employer,0),0);
  v_other integer := greatest(coalesce(p_other,0),0);
  v_earned integer; v_net integer; v_exp_id text; v_esi_exp_id text; v_pf_exp_id text; v_pay_id uuid;
  v_loan public.employee_loans; v_paid integer; v_outstd integer;
  v_exp_date date;
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can pay a salary' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_period is null or p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Salary period must be YYYY-MM'; end if;
  select * into v_emp from public.employees where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Pay-out account not found'; end if;
  v_earned := greatest(v_gross - v_lop_amt, 0) + v_inc;
  v_net := v_earned - v_adv - v_tds - v_pf - v_esi - v_other;
  if v_net < 0 then raise exception 'Deductions (%) exceed earned pay (%)', v_adv+v_tds+v_pf+v_esi+v_other, v_earned; end if;
  if v_adv > 0 then
    if p_advance_loan_id is null then raise exception 'Pick which advance/loan the recovery reduces'; end if;
    select * into v_loan from public.employee_loans where id = p_advance_loan_id and tenant_id = v_tenant;
    if not found then raise exception 'Advance/loan not found'; end if;
    select coalesce(sum(amount),0) into v_paid from public.employee_loan_repayments where loan_id = p_advance_loan_id;
    v_outstd := v_loan.principal - v_paid;
    if v_adv > v_outstd then raise exception 'Advance recovery (%) exceeds its outstanding (%)', v_adv, v_outstd; end if;
  end if;

  -- Accrual: the cost sits in the salary month, whatever day it was paid.
  v_exp_date := public.salary_expense_date(p_period, p_pay_date);

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values (v_exp_id, v_tenant, 'Salaries', v_emp.name, v_exp_date, v_earned, 0, 'payroll',
          'Salary ' || p_period || ' — ' || v_emp.name || case when v_inc > 0 then ' (incl. incentive)' else '' end);

  if v_esi_emp > 0 then
    v_esi_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'E';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_esi_exp_id, v_tenant, 'ESI — Employer', v_emp.name, v_exp_date, v_esi_emp, 0, 'statutory',
            'ESI employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  if v_pf_emp > 0 then
    v_pf_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint)) || '-' || upper(to_hex((random() * 255)::int)) || 'P';
    insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
    values (v_pf_exp_id, v_tenant, 'PF — Employer', v_emp.name, v_exp_date, v_pf_emp, 0, 'statutory',
            'PF employer contribution ' || p_period || ' — ' || v_emp.name);
  end if;

  insert into public.salary_payments
    (tenant_id, employee_id, period, pay_date, gross, lop_days, lop_amount, incentive, advance_recovered,
     tds, pf, esi, esi_employer, pf_employer, other_deduction, net, bank_account_id, expense_id, advance_loan_id, notes, paid_status, pf_wage)
  values
    (v_tenant, p_employee_id, p_period, p_pay_date, v_gross, coalesce(p_lop_days,0), v_lop_amt, v_inc, v_adv,
     v_tds, v_pf, v_esi, v_esi_emp, v_pf_emp, v_other, v_net, p_bank_account_id, v_exp_id,
     case when v_adv > 0 then p_advance_loan_id else null end, nullif(trim(coalesce(p_notes,'')),''), 'unpaid',
     case when p_pf_wage is null then null else greatest(p_pf_wage, 0) end)
  returning id into v_pay_id;

  if v_adv > 0 then
    insert into public.employee_loan_repayments (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, notes)
    values (v_tenant, p_advance_loan_id, v_adv, p_pay_date, 'salary_deduction', null, 'Recovered from salary ' || p_period);
    update public.employee_loans set status = case when (v_outstd - v_adv) <= 0 then 'closed' else 'active' end, updated_at = now() where id = p_advance_loan_id;
  end if;
  return v_pay_id;
end; $function$;

create or replace function public.give_employee_advance(
  p_name        text,
  p_amount      int,
  p_date        date default current_date,
  p_method      text default 'cash',
  p_account     uuid default null,
  p_note        text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_id     uuid;
  v_leg    uuid;
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can give an employee advance' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if nullif(trim(coalesce(p_name, '')), '') is null then raise exception 'Enter who you gave the money to.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be more than ₹0.'; end if;
  if p_account is not null and not exists (select 1 from public.bank_accounts where id = p_account and tenant_id = v_tenant) then
    raise exception 'That bank / cash account is not in your company.';
  end if;

  insert into public.prepaid_advances
    (tenant_id, vendor_name, category, total_amount, consumed_amount, paid_date, payment_method,
     bank_account_id, notes, created_by)
  values
    (v_tenant, trim(p_name), 'Employee advance', p_amount, 0, coalesce(p_date, current_date), p_method,
     p_account, nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;

  v_leg := public._employee_advance_cash_leg(v_tenant, p_account, coalesce(p_date, current_date), p_amount, 0,
                                             'Advance to ' || trim(p_name), v_id);
  if v_leg is not null then
    update public.prepaid_advances set bank_txn_id = v_leg where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.top_up_employee_advance(
  p_advance_id uuid,
  p_amount     int,
  p_date       date default current_date,
  p_account    uuid default null
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_adv    public.prepaid_advances;
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can top up an employee advance' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be more than ₹0.'; end if;
  select * into v_adv from public.prepaid_advances
   where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
  if not found then raise exception 'Advance not found.'; end if;

  update public.prepaid_advances
     set total_amount = total_amount + p_amount, closed_at = null, updated_at = now(),
         notes = concat_ws(E'\n', notes, 'Top-up ₹' || p_amount || ' on ' || to_char(coalesce(p_date, current_date), 'DD Mon YYYY'))
   where id = p_advance_id;

  perform public._employee_advance_cash_leg(v_tenant, coalesce(p_account, v_adv.bank_account_id), coalesce(p_date, current_date),
                                            p_amount, 0, 'Advance top-up to ' || v_adv.vendor_name, p_advance_id);
  return v_adv.total_amount + p_amount - v_adv.consumed_amount;
end $$;

create or replace function public.settle_employee_advance(
  p_advance_id uuid,
  p_date       date default current_date,
  p_account    uuid default null
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_adv      public.prepaid_advances;
  v_returned int;
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can settle an employee advance' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  select * into v_adv from public.prepaid_advances
   where id = p_advance_id and tenant_id = v_tenant and category = 'Employee advance' for update;
  if not found then raise exception 'Advance not found.'; end if;
  if v_adv.closed_at is not null then raise exception 'This advance is already settled.'; end if;

  v_returned := v_adv.total_amount - v_adv.consumed_amount;
  update public.prepaid_advances
     set total_amount = consumed_amount, closed_at = now(), updated_at = now(),
         notes = concat_ws(E'\n', notes, 'Settled on ' || to_char(coalesce(p_date, current_date), 'DD Mon YYYY')
                                         || ' · ₹' || v_returned || ' returned')
   where id = p_advance_id;

  if v_returned > 0 then
    perform public._employee_advance_cash_leg(v_tenant, coalesce(p_account, v_adv.bank_account_id), coalesce(p_date, current_date),
                                              0, v_returned, 'Advance returned by ' || v_adv.vendor_name, p_advance_id);
  end if;
  return v_returned;
end $$;

CREATE OR REPLACE FUNCTION "public"."approve_expense_claim"("p_claim_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_claim       public.expense_claims;
  v_loan        public.employee_loans;
  v_paid        integer;
  v_outstanding integer;
  v_exp_id      text;
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can approve an expense claim' using errcode = '42501';
  end if;
  select * into v_claim from public.expense_claims
    where id = p_claim_id and tenant_id = v_tenant;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'This claim is already %', v_claim.status; end if;

  select * into v_loan from public.employee_loans
    where id = v_claim.loan_id and tenant_id = v_tenant;
  if not found then raise exception 'The advance for this claim no longer exists'; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.employee_loan_repayments where loan_id = v_loan.id;
  v_outstanding := v_loan.principal - v_paid;
  if v_claim.amount > v_outstanding then
    raise exception 'Claim (%) now exceeds the remaining advance (%)', v_claim.amount, v_outstanding;
  end if;

  v_exp_id := 'EXP-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                     || '-' || upper(to_hex((random() * 255)::int));
  insert into public.expenses
    (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, payment_method, description)
  values
    (v_exp_id, v_tenant, v_claim.category, v_loan.employee_name, v_claim.spent_on, v_claim.amount, 0, 'advance',
     coalesce(v_claim.purpose, 'Expense claim') || ' (claimed by ' || v_loan.employee_name || ')');

  insert into public.employee_loan_repayments
    (tenant_id, loan_id, amount, repaid_on, method, bank_account_id, expense_id, notes)
  values
    (v_tenant, v_loan.id, v_claim.amount, v_claim.spent_on, 'expense', null, v_exp_id, v_claim.purpose);

  update public.employee_loans
     set status     = case when (v_outstanding - v_claim.amount) <= 0 then 'closed' else 'active' end,
         updated_at = now()
   where id = v_loan.id;

  update public.expense_claims
     set status = 'approved', expense_id = v_exp_id, reviewed_at = now()
   where id = p_claim_id;
end;
$$;

CREATE OR REPLACE FUNCTION "public"."set_employee_pin"("p_employee_id" "uuid", "p_pin" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $_$
declare
  v_tenant uuid := public.current_tenant_id();
  v_trusted boolean;
begin
  /* R-717: role gate. Trusted = service_role or a direct DB session with no request role
     (same rule as R-454 / R-714). Everyone else must hold one of the roles below — a
     null-caller (no public.users row) holds none, so it is refused here too. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager') then
    raise exception 'Only an owner or manager can set an attendance kiosk PIN' using errcode = '42501';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4 to 6 digits';
  end if;
  update public.employees
     set pin_hash = crypt(p_pin, gen_salt('bf')), updated_at = now()
   where id = p_employee_id and tenant_id = v_tenant;
  if not found then raise exception 'Employee not found'; end if;
end;
$_$;

revoke all on function public.pay_salary(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer) from public, anon;
revoke all on function public.set_employee_pin(uuid, text) from public, anon;
revoke all on function public.give_employee_advance(text, int, date, text, uuid, text) from public, anon;
revoke all on function public.top_up_employee_advance(uuid, int, date, uuid) from public, anon;
revoke all on function public.settle_employee_advance(uuid, date, uuid) from public, anon;
revoke all on function public.approve_expense_claim(uuid) from public, anon;
grant execute on function public.pay_salary(uuid, text, date, integer, numeric, integer, integer, uuid, integer, integer, integer, integer, uuid, text, integer, integer, integer, integer) to authenticated, service_role;
grant execute on function public.set_employee_pin(uuid, text) to authenticated, service_role;
grant execute on function public.give_employee_advance(text, int, date, text, uuid, text) to authenticated, service_role;
grant execute on function public.top_up_employee_advance(uuid, int, date, uuid) to authenticated, service_role;
grant execute on function public.settle_employee_advance(uuid, date, uuid) to authenticated, service_role;
grant execute on function public.approve_expense_claim(uuid) to authenticated, service_role;

commit;
