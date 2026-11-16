-- deploy-peek: to_regprocedure('public.loans_current_split(date)') is not null and to_regprocedure('public.loans_given_current_parts(date)') is not null and to_regprocedure('public.set_loan_due_within_12m(text,uuid,boolean)') is not null and to_regprocedure('public.tg_r2674_staff_loan_kind_clears_choice()') is not null and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'employee_loans' and column_name = 'due_within_12m')
-- deploy-key: r2674loanscurrent
--
-- R-2674 (11 Nov 2026, Pardeep haan): Balance Sheet — loans given and staff loans that come back
-- within 12 months are CURRENT assets. Until now every loan sat outside "current" (the current
-- ratio fell when loans were booked), whatever its due date.
--
-- ONE rule, here in SQL (the Balance Sheet, its ratios and its CSV all read loans_current_split()):
--   Loans given (loans_given — outside parties and directors, R-544 / R-1853 / R-2340 / R-2603):
--     • a loan WITH a due date / schedule follows it: the principal parts still unpaid that fall due
--       on or before <Balance Sheet date + 12 months> (an overdue part too) are current, the rest
--       non-current. Principal already repaid is taken off the earliest parts first — the same rule
--       as the app's schedule (lib/accounting/loans-given.ts loanSchedule):
--         one_shot     all principal on due_on
--         instalments  N equal monthly principal parts from due_on (the last takes the rounding)
--         emi          reducing balance: interest = round(left × rate / 1200), principal = EMI −
--                      interest, the last receipt clears the rest (R-2340)
--     • a loan with NO due date follows the owner's / accountant's answer to "Due back within 12
--       months?" (loans_given.due_within_12m): yes → current, no → non-current, not answered yet →
--       non-current (as before) and counted as "undecided" so the screens ask.
--   Staff loans (employee_loans): they have no schedule. A salary advance / expense advance is
--     always current; a staff LOAN is current unless the owner / accountant says it is not
--     (employee_loans.due_within_12m = false).
--   MONEY: nothing moves. The Balance Sheet totals stay loans_given_asset() and
--     report_balance_sheet().employee_loans (tenant-level greatest(0, given − repaid)); the current
--     part is clamped to that total, so current + non-current = the old one line, always.
--   The choice is presentation only (no amount, no date), so it is allowed in a locked period: the
--     books-lock triggers on the two tables get due_within_12m as a free column (R-1584's own
--     "free columns" rule, as R-2623 did for vendor_bills) — every other change stays refused.
--   WHO: the choice = owner / accountant (loans_given's rule). The totals = owner / manager /
--     accountant, totals only, no borrower names (as loans_given_asset). Per-loan parts = owner /
--     accountant (who may read loans_given).
-- Out of scope: loans TAKEN (business_loans, EMI loans, loans from directors — liabilities) and
-- prepaid / vendor / office-expense advances (prepaid_advances).
--
-- Proof: supabase/tests/r2674_loans_current_split.test.sql (one rollback).

begin;

alter table public.loans_given    add column if not exists due_within_12m boolean;
alter table public.employee_loans add column if not exists due_within_12m boolean;

comment on column public.loans_given.due_within_12m is
  'R-2674: "Due back within 12 months?" for a loan with NO due date — true = current asset, false = non-current, null = not answered (non-current, the screens ask). A loan with a due date / schedule ignores it.';
comment on column public.employee_loans.due_within_12m is
  'R-2674: staff LOAN only — false = non-current asset; null / true = current. Salary and expense advances are always current.';

-- The choice changes no amount and no date → allowed in a locked period (R-1584 free columns).
drop trigger if exists trg_books_lock on public.loans_given;
create trigger trg_books_lock
  before insert or update or delete on public.loans_given
  for each row execute function public.tg_books_locked('given_on', 'closed_on', 'status,notes,due_within_12m');
drop trigger if exists trg_books_lock on public.employee_loans;
create trigger trg_books_lock
  before insert or update or delete on public.employee_loans
  for each row execute function public.tg_books_locked('disbursed_on', '', 'status,notes,due_within_12m');


-- ── One loan given: the principal still owed that is CURRENT on p_as_of ─────────────────────
create or replace function public.loan_given_current_principal(
  p_principal   integer,
  p_plan        text,
  p_due_on      date,
  p_instalments integer,
  p_emi         integer,
  p_rate        numeric,
  p_repaid      bigint,
  p_choice      boolean,
  p_as_of       date
) returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  v_repaid  bigint  := greatest(0, coalesce(p_repaid, 0));
  v_left    bigint  := greatest(0, coalesce(p_principal, 0) - v_repaid);
  v_cutoff  date    := (p_as_of + interval '12 months')::date;
  v_n       integer := coalesce(p_instalments, 0);
  v_each    integer;
  v_part    integer;
  v_before  bigint  := 0;
  v_bal     integer;
  v_int     integer;
  v_current bigint  := 0;
  i         integer;
begin
  -- R-2674
  if v_left = 0 or p_as_of is null then return 0; end if;

  if p_due_on is null then
    -- No date to go by: the owner's / accountant's answer (not answered = non-current).
    return case when p_choice is true then v_left else 0 end::integer;
  end if;

  if p_plan = 'instalments' and v_n > 0 then
    v_each := p_principal / v_n;
    for i in 0 .. v_n - 1 loop
      v_part := case when i = v_n - 1 then p_principal - v_each * (v_n - 1) else v_each end;
      if (p_due_on + make_interval(months => i))::date <= v_cutoff then
        v_current := v_current + (v_part - least(v_part, greatest(0, v_repaid - v_before)));
      end if;
      v_before := v_before + v_part;
    end loop;
    return least(v_current, v_left)::integer;
  end if;

  if p_plan = 'emi' and v_n > 0 and coalesce(p_emi, 0) > 0 then
    v_bal := p_principal;
    for i in 0 .. v_n - 1 loop
      exit when v_bal <= 0;
      v_int  := round(v_bal::numeric * coalesce(p_rate, 0) / 1200)::integer;
      v_part := case when i = v_n - 1 then v_bal else least(v_bal, greatest(0, p_emi - v_int)) end;
      if (p_due_on + make_interval(months => i))::date <= v_cutoff then
        v_current := v_current + (v_part - least(v_part, greatest(0, v_repaid - v_before)));
      end if;
      v_before := v_before + v_part;
      v_bal    := v_bal - v_part;
    end loop;
    return least(v_current, v_left)::integer;
  end if;

  -- One date for everything (one_shot): due by the cut-off (or overdue) → all of it is current.
  return case when p_due_on <= v_cutoff then v_left else 0 end::integer;
end;
$$;

revoke all on function public.loan_given_current_principal(integer, text, date, integer, integer, numeric, bigint, boolean, date) from public, anon;
grant execute on function public.loan_given_current_principal(integer, text, date, integer, integer, numeric, bigint, boolean, date) to authenticated, service_role;

comment on function public.loan_given_current_principal(integer, text, date, integer, integer, numeric, bigint, boolean, date) is
  'R-2674: the part of one loan given''s unpaid principal that falls due on or before p_as_of + 12 months (schedule), or the owner''s choice when the loan has no due date. Pure arithmetic — no table is read.';


-- ── Per loan (Loans given page): owner / accountant only ────────────────────────────────────
create or replace function public.loans_given_current_parts(p_as_of date default null)
returns table (loan_id uuid, principal_left integer, current_part integer, basis text)
language sql
stable
security definer
set search_path = public
as $$
  -- R-2674
  select l.id,
         greatest(0, l.principal - coalesce(r.repaid, 0))::integer,
         public.loan_given_current_principal(l.principal, l.repayment_plan, l.due_on, l.instalments, l.emi_amount,
                                             l.interest_rate, coalesce(r.repaid, 0), l.due_within_12m,
                                             coalesce(p_as_of, public.ist_today())),
         case when l.due_on is not null then 'schedule'
              when l.due_within_12m is null then 'undecided'
              else 'choice' end
    from public.loans_given l
    left join lateral (select sum(p.principal_part) as repaid
                         from public.loan_repayments p
                        where p.loan_id = l.id and p.tenant_id = l.tenant_id) r on true
   where l.tenant_id = public.current_tenant_id()
     and public.current_tenant_id() is not null
     and public.current_user_has_role('owner', 'accountant');
$$;

revoke all on function public.loans_given_current_parts(date) from public, anon;
grant execute on function public.loans_given_current_parts(date) to authenticated, service_role;

comment on function public.loans_given_current_parts(date) is
  'R-2674: each of the caller''s loans given with the principal still owed, the part of it that is a current asset on the date (default today, IST) and why (schedule / choice / undecided). Owner / accountant only.';


-- ── Balance Sheet: the current parts, totals only (no names) ────────────────────────────────
create or replace function public.loans_current_split(p_as_of date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_as_of    date := coalesce(p_as_of, public.ist_today());
  v_given    bigint;
  v_given_c  bigint;
  v_undec_n  integer;
  v_undec    bigint;
  v_staff    bigint;
  v_staff_c  bigint;
begin
  -- R-2674: the same gate as loans_given_asset() — the manager's sheet gets totals, never names.
  if v_tenant is null or not public.current_user_has_role('owner', 'manager', 'accountant') then
    return jsonb_build_object('as_of', v_as_of, 'loans_given_current', 0, 'employee_loans_current', 0,
                              'loans_given_undecided', 0, 'loans_given_undecided_amount', 0);
  end if;

  -- The Balance Sheet's own totals: Loans given = loans_given_asset() itself (same role gate as
  -- this function); staff = report_balance_sheet().employee_loans' formula (that RPC is the whole
  -- sheet — too heavy to call here; r2674 test F holds the two equal).
  v_given := public.loans_given_asset();
  v_staff := greatest(0,
      (select coalesce(sum(l.principal), 0) from public.employee_loans l where l.tenant_id = v_tenant)
    - (select coalesce(sum(r.amount), 0) from public.employee_loan_repayments r where r.tenant_id = v_tenant));

  select coalesce(sum(public.loan_given_current_principal(l.principal, l.repayment_plan, l.due_on, l.instalments,
                        l.emi_amount, l.interest_rate, coalesce(r.repaid, 0), l.due_within_12m, v_as_of)), 0),
         count(*) filter (where l.due_on is null and l.due_within_12m is null and l.principal > coalesce(r.repaid, 0)),
         coalesce(sum(greatest(0, l.principal - coalesce(r.repaid, 0)))
                    filter (where l.due_on is null and l.due_within_12m is null), 0)
    into v_given_c, v_undec_n, v_undec
    from public.loans_given l
    left join lateral (select sum(p.principal_part) as repaid
                         from public.loan_repayments p
                        where p.loan_id = l.id and p.tenant_id = l.tenant_id) r on true
   where l.tenant_id = v_tenant;

  select coalesce(sum(greatest(0, l.principal - coalesce(r.repaid, 0))), 0)
    into v_staff_c
    from public.employee_loans l
    left join lateral (select sum(p.amount) as repaid
                         from public.employee_loan_repayments p
                        where p.loan_id = l.id and p.tenant_id = l.tenant_id) r on true
   where l.tenant_id = v_tenant
     and (l.kind is distinct from 'loan' or coalesce(l.due_within_12m, true));

  return jsonb_build_object(
    'as_of', v_as_of,
    'loans_given_current',          least(v_given_c, v_given),
    'employee_loans_current',       least(v_staff_c, v_staff),
    'loans_given_undecided',        v_undec_n,
    'loans_given_undecided_amount', least(v_undec, v_given - least(v_given_c, v_given)));
end;
$$;

revoke all on function public.loans_current_split(date) from public, anon;
grant execute on function public.loans_current_split(date) to authenticated, service_role;

comment on function public.loans_current_split(date) is
  'R-2674: the CURRENT part (due back within 12 months of the date, default today IST) of the Balance Sheet''s "Loans given" and "Employee loans" totals, plus how many loans given have no due date and no answer yet. p_as_of moves only the 12-month cut-off — the loans and repayments counted are the books as they stand, like loans_given_asset(). Totals only — owner / manager / accountant; anyone else gets zeros.';


-- ── A staff loan that stops being a LOAN forgets its answer; the answer is owner / accountant only ──
-- Only kind 'loan' can be non-current. If its type is edited to a salary / expense advance the
-- answer is cleared, so it cannot come back unseen when the type is edited to 'loan' again.
-- employee_loans can be updated directly by a manager (its update policy), so the owner / accountant
-- rule of set_loan_due_within_12m is held here too: an app user of another role cannot change the
-- answer by a direct table write. (loans_given has no direct write for app users at all.)
create or replace function public.tg_r2674_staff_loan_kind_clears_choice()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- R-2674
  if new.due_within_12m is distinct from old.due_within_12m
     and coalesce(public.current_request_role(), '') in ('anon', 'authenticated')
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can choose where a loan shows on the Balance Sheet — ask your owner to do it.'
      using errcode = '42501';
  end if;
  if new.kind is distinct from old.kind and new.kind is distinct from 'loan' then
    new.due_within_12m := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_r2674_staff_loan_kind_clears_choice on public.employee_loans;
create trigger trg_r2674_staff_loan_kind_clears_choice
  before update on public.employee_loans
  for each row execute function public.tg_r2674_staff_loan_kind_clears_choice();


-- ── The choice: "Due back within 12 months?" ────────────────────────────────────────────────
create or replace function public.set_loan_due_within_12m(p_kind text, p_loan_id uuid, p_due_within boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_given  public.loans_given;
  v_staff  public.employee_loans;
  v_old    boolean;
  v_name   text;
begin
  -- R-2674
  if v_tenant is null then raise exception 'No company context — sign in again.' using errcode = '28000'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can choose where a loan shows on the Balance Sheet — ask your owner to do it.'
      using errcode = '42501';
  end if;

  if p_kind = 'loan_given' then
    select * into v_given from public.loans_given where id = p_loan_id and tenant_id = v_tenant for update;
    if not found then raise exception 'Loan not found in your company.'; end if;
    if v_given.due_on is not null then
      raise exception 'This loan has a due date — the Balance Sheet follows it (the part due in the next 12 months is current).';
    end if;
    v_old := v_given.due_within_12m;
    v_name := v_given.borrower_name;
    if v_old is not distinct from p_due_within then return false; end if;
    update public.loans_given set due_within_12m = p_due_within, updated_at = now() where id = p_loan_id;
  elsif p_kind = 'employee_loan' then
    select * into v_staff from public.employee_loans where id = p_loan_id and tenant_id = v_tenant for update;
    if not found then raise exception 'Loan not found in your company.'; end if;
    if v_staff.kind is distinct from 'loan' then
      raise exception 'A salary or expense advance is always shown under Current assets — only a staff loan can be marked as due after 12 months.';
    end if;
    v_old := v_staff.due_within_12m;
    v_name := v_staff.employee_name;
    if v_old is not distinct from p_due_within then return false; end if;
    update public.employee_loans set due_within_12m = p_due_within, updated_at = now() where id = p_loan_id;
  else
    raise exception 'Pick a loan given or a staff loan.';
  end if;

  -- The label carries no borrower name for a loan given: the activity log is open to roles that
  -- may not open Loans given (the manager gets totals, never names). Staff names are theirs to read.
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'loan.due_within_12m_set', p_kind, p_loan_id::text,
          case when p_kind = 'employee_loan' then 'Staff loan to ' || v_name else 'Loan given' end || ': due back within 12 months = '
            || case when p_due_within is null then 'not answered' when p_due_within then 'yes (current asset)' else 'no (non-current asset)' end,
          jsonb_build_object('due_within_12m', jsonb_build_object('old', v_old, 'new', p_due_within)));
  return true;
end;
$$;

revoke all on function public.set_loan_due_within_12m(text, uuid, boolean) from public, anon;
grant execute on function public.set_loan_due_within_12m(text, uuid, boolean) to authenticated, service_role;

comment on function public.set_loan_due_within_12m(text, uuid, boolean) is
  'R-2674: owner / accountant answer "Due back within 12 months?" on a loan given with no due date (p_kind loan_given) or a staff loan (employee_loan). Presentation only — no amount or date changes. Returns false when nothing changed.';

commit;
