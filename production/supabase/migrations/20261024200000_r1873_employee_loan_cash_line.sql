-- deploy-peek: exists(select 1 from pg_attribute where attrelid = to_regclass('public.employee_loans') and attname = 'bank_txn_id' and not attisdropped) and exists(select 1 from pg_proc where oid = to_regprocedure('public.delete_employee_loan(uuid)') and prosrc like '%R-1873%') and exists(select 1 from pg_trigger where tgname = 'trg_employee_loan_line_guard') and to_regprocedure('public.remove_employee_loan_ghost_pair(uuid,uuid)') is not null
-- deploy-key: r1873loancashline
-- 20261024200000_r1873_employee_loan_cash_line.sql
--
-- R-1873 (Pardeep on staging, 24 Oct 2026, a test company): gave a ₹2,000 loan/advance to
-- Prashant from Petty Cash twice, deleted one. Billing → Payments Made still listed TWO
-- "−₹2,000 · Loan/advance to Prashant" rows while Banking → Petty Cash showed −₹2,000.
--
-- ROOT CAUSE
--   delete_employee_loan never removed the cash line that disburse_employee_loan wrote. It added
--   a SECOND line instead — a "Correction: reversed loan/advance to …" CREDIT dated today. The
--   cash balance nets out (−2,000 −2,000 +2,000), but Payments Made lists money-out (debit)
--   lines, so both debits stayed on it. edit_employee_loan did the same (reverse + re-post).
--   The loan row also never recorded WHICH line was its cash leg, so nothing could tie the two.
--
-- THE FIX — one fact
--   • employee_loans.bank_txn_id = the loan's cash line (same shape as loans_given.bank_txn_id).
--   • disburse_employee_loan writes the line first and stores its id on the loan.
--   • delete_employee_loan deletes the loan AND its line in one transaction — no correction
--     lines. If the line was re-booked on the Banking page as something else, the delete is
--     refused with the next step (un-reconcile it there first).
--     A loan made before this migration has no bank_txn_id: its line is found the way it was
--     written (same company, account, date, amount, "Loan/advance to <name>" / "Expense advance
--     to <name>", still booked as manual, not claimed by another loan). If it cannot be found
--     (already moved, or edited the old way), the old correction credit is kept so the cash
--     balance stays right.
--   • edit_employee_loan changes the linked line in place (amount, account, date, name).
--   • trg_employee_loan_line_guard: a line that is some loan's cash leg cannot be deleted, or have
--     its amount/account changed, except through these RPCs (which update the loan first).
--   Payments Made and the Petty Cash balance read the line; the loans register and the Balance
--   Sheet read the loan; with the link and the guard there is one money fact for both.
--
-- STORED DATA IS NOT CHANGED. Old orphans (a debit left behind next to its correction credit)
-- are listed by scripts/ops/r1873-loan-cash-orphans.sql — Pardeep decides what to do with them.
--
-- Roles (unchanged): give/edit = owner, manager, accountant; delete = owner, accountant.
-- §17c: trusted = service_role or a direct DB session; a caller with no company is refused.

alter table public.employee_loans
  add column if not exists bank_txn_id uuid references public.bank_transactions(id) on delete set null;

create unique index if not exists employee_loans_bank_txn_uidx
  on public.employee_loans (bank_txn_id) where bank_txn_id is not null;

comment on column public.employee_loans.bank_txn_id is
  'R-1873: the cash/bank line this loan or advance was paid out by. Deleted with the loan; guarded by trg_employee_loan_line_guard.';

-- ── give ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public.disburse_employee_loan(p_employee_name text, p_principal integer, p_disbursed_on date, p_bank_account_id uuid, p_kind text default 'loan'::text, p_notes text default null::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_loan    uuid;
  v_txn     uuid;
  v_kind    text := coalesce(nullif(trim(p_kind), ''), 'loan');
begin
  /* R-1873: the cash line's id is stored on the loan (bank_txn_id). R-885 role gate kept. */
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can give an employee loan or advance' using errcode = '42501';
  end if;
  if v_tenant is null then
    raise exception 'No company selected — sign in again, then give the loan.' using errcode = '28000';
  end if;
  if p_principal is null or p_principal <= 0 then
    raise exception 'Amount must be positive';
  end if;
  if trim(coalesce(p_employee_name, '')) = '' then
    raise exception 'Employee name is required';
  end if;
  if v_kind not in ('loan', 'salary_advance', 'expense_advance') then
    raise exception 'Invalid kind';
  end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant;
  if not found then raise exception 'Source account not found — pick a bank or cash account of this company.'; end if;

  insert into public.bank_transactions
    (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
  values
    (v_tenant, p_bank_account_id, p_disbursed_on,
     case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || trim(p_employee_name),
     p_principal, 0, 'manual', 'manual', 'manual')
  returning id into v_txn;

  insert into public.employee_loans
    (tenant_id, employee_name, principal, disbursed_on, bank_account_id, kind, notes, created_by, bank_txn_id)
  values
    (v_tenant, trim(p_employee_name), p_principal, p_disbursed_on, p_bank_account_id, v_kind,
     nullif(trim(coalesce(p_notes, '')), ''), auth.uid(), v_txn)
  returning id into v_loan;

  return v_loan;
end;
$function$;

-- The cash line of a loan made before R-1873 (no bank_txn_id): found the way it was written.
create or replace function public.employee_loan_legacy_line(p_loan_id uuid)
 returns uuid
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  /* R-1873: internal helper — called only from the loan RPCs below (no grant to authenticated). */
  select t.id
    from public.employee_loans l
    join public.bank_transactions t
      on t.tenant_id = l.tenant_id
     and t.bank_account_id = l.bank_account_id
     and t.txn_date = l.disbursed_on
     and t.debit = l.principal
     and t.source = 'manual'
     and t.matched_to_type = 'manual'
     and t.matched_to_id is null
     and t.description in ('Loan/advance to ' || l.employee_name, 'Expense advance to ' || l.employee_name)
   where l.id = p_loan_id
     and l.bank_txn_id is null
     and not exists (select 1 from public.employee_loans o where o.bank_txn_id = t.id)
   order by abs(extract(epoch from (t.created_at - l.created_at))), t.id
   limit 1;
$function$;
revoke all on function public.employee_loan_legacy_line(uuid) from public;
revoke all on function public.employee_loan_legacy_line(uuid) from authenticated;

-- ── delete ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.delete_employee_loan(p_loan_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_loan    public.employee_loans;
  v_line    public.bank_transactions;
  v_acct    text;
  v_paid    integer;
begin
  /* R-1873: deletes the loan AND its cash line together (no "Correction" credit), so Payments
     Made, the account balance, the loans register and the Balance Sheet all lose it at once.
     R-885 role gate (delete group: owner, accountant) kept; §17c fail-closed. */
  if not v_trusted and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete an employee loan' using errcode = '42501';
  end if;
  if v_tenant is null and not v_trusted then
    raise exception 'No company selected — sign in again, then delete the loan.' using errcode = '28000';
  end if;

  select * into v_loan from public.employee_loans
   where id = p_loan_id and (tenant_id = v_tenant or (v_tenant is null and v_trusted))
   for update;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements - reverse those first before deleting.';
  end if;

  if v_loan.bank_txn_id is not null then
    select * into v_line from public.bank_transactions where id = v_loan.bank_txn_id for update;
  elsif v_loan.bank_account_id is not null then
    select * into v_line from public.bank_transactions
     where id = public.employee_loan_legacy_line(p_loan_id) for update;
  end if;

  if v_line.id is not null
     and (v_line.matched_to_type is distinct from 'manual' and v_line.matched_to_type is not null
          or v_line.matched_to_id is not null) then
    select name into v_acct from public.bank_accounts where id = v_line.bank_account_id;
    raise exception 'This loan''s cash line (% · % · ₹%) is now booked as "%" on the Banking page, so deleting the loan would change that booking too.',
      coalesce(v_acct, 'account'), to_char(v_line.txn_date, 'DD Mon YYYY'), v_line.debit, v_line.matched_to_type
      using hint = '/accounting/banking/' || v_line.bank_account_id || '?focus=' || v_line.id,
            detail = 'Open the line in Banking, un-reconcile it, then delete the loan again.';
  end if;

  delete from public.employee_loans where id = p_loan_id;

  if v_line.id is not null then
    delete from public.bank_transactions where id = v_line.id;
  elsif v_loan.bank_account_id is not null then
    -- A loan from before R-1873 whose line can no longer be found: keep the old correction
    -- credit so the account balance still comes back right.
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_loan.tenant_id, v_loan.bank_account_id, public.ist_today(),
       'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
  end if;
end;
$function$;

-- ── edit ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public.edit_employee_loan(p_loan_id uuid, p_employee_name text, p_principal integer, p_disbursed_on date, p_bank_account_id uuid, p_kind text, p_notes text default null::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_loan    public.employee_loans;
  v_line    public.bank_transactions;
  v_txn     uuid;
  v_paid    integer;
  v_kind    text := coalesce(nullif(trim(p_kind), ''), 'loan');
  v_name    text := trim(coalesce(p_employee_name, ''));
  v_desc    text;
  v_money   boolean;
begin
  /* R-1873: the linked cash line is changed in place (amount, account, date, name) — no
     reverse-and-repost pair. R-885 role gate kept; §17c fail-closed. */
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can change an employee loan' using errcode = '42501';
  end if;
  if v_tenant is null and not v_trusted then
    raise exception 'No company selected — sign in again, then change the loan.' using errcode = '28000';
  end if;
  if p_principal is null or p_principal <= 0 then raise exception 'Amount must be positive'; end if;
  if v_name = '' then raise exception 'Employee name is required'; end if;
  if v_kind not in ('loan', 'salary_advance', 'expense_advance') then raise exception 'Invalid kind'; end if;

  select * into v_loan from public.employee_loans
   where id = p_loan_id and (tenant_id = v_tenant or (v_tenant is null and v_trusted))
   for update;
  if not found then raise exception 'Loan not found'; end if;

  select coalesce(sum(amount), 0) into v_paid from public.employee_loan_repayments where loan_id = p_loan_id;
  if v_paid > 0 then
    raise exception 'This loan already has repayments/settlements - reverse those first before editing.';
  end if;

  perform 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_loan.tenant_id;
  if not found then raise exception 'Source account not found — pick a bank or cash account of this company.'; end if;

  v_desc  := case v_kind when 'expense_advance' then 'Expense advance to ' else 'Loan/advance to ' end || v_name;
  v_money := p_principal <> v_loan.principal
             or p_bank_account_id is distinct from v_loan.bank_account_id
             or p_disbursed_on <> v_loan.disbursed_on;

  if v_loan.bank_txn_id is not null then
    select * into v_line from public.bank_transactions where id = v_loan.bank_txn_id for update;
  elsif v_loan.bank_account_id is not null then
    select * into v_line from public.bank_transactions
     where id = public.employee_loan_legacy_line(p_loan_id) for update;
  end if;

  if v_money and v_line.id is not null
     and (v_line.matched_to_type is distinct from 'manual' and v_line.matched_to_type is not null
          or v_line.matched_to_id is not null) then
    raise exception 'This loan''s cash line is now booked as "%" on the Banking page, so its amount, account or date cannot change here.', v_line.matched_to_type
      using hint = '/accounting/banking/' || v_line.bank_account_id || '?focus=' || v_line.id,
            detail = 'Open the line in Banking, un-reconcile it, then edit the loan again.';
  end if;

  if v_line.id is null and v_money then
    -- No line to change (a loan from before R-1873 whose line cannot be found): the old way —
    -- put the old amount back, then pay out the new one. The new line is linked.
    if v_loan.bank_account_id is not null then
      insert into public.bank_transactions
        (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
      values
        (v_loan.tenant_id, v_loan.bank_account_id, public.ist_today(),
         'Correction: reversed loan/advance to ' || v_loan.employee_name, 0, v_loan.principal, 'manual', 'manual', 'manual');
    end if;
    insert into public.bank_transactions
      (tenant_id, bank_account_id, txn_date, description, debit, credit, source, matched_to_type, match_confidence)
    values
      (v_loan.tenant_id, p_bank_account_id, p_disbursed_on, v_desc, p_principal, 0, 'manual', 'manual', 'manual')
    returning id into v_txn;
  else
    v_txn := v_line.id;
  end if;

  -- The loan first, then its line: the line guard checks the line against the loan.
  update public.employee_loans
     set employee_name   = v_name,
         principal       = p_principal,
         disbursed_on    = p_disbursed_on,
         bank_account_id = p_bank_account_id,
         kind            = v_kind,
         notes           = nullif(trim(coalesce(p_notes, '')), ''),
         bank_txn_id     = v_txn,
         updated_at      = now()
   where id = p_loan_id;

  if v_line.id is not null then
    update public.bank_transactions
       set bank_account_id = p_bank_account_id,
           txn_date        = p_disbursed_on,
           debit           = p_principal,
           description     = case when v_line.matched_to_type = 'manual' then v_desc else description end,
           updated_at      = now()
     where id = v_line.id;
  end if;
end;
$function$;

-- ── guard: a loan's cash line changes only together with the loan ────────────────────────────
create or replace function public.tg_employee_loan_line_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_loan public.employee_loans;
begin
  /* R-1873: one money fact. A line that is a loan's cash leg cannot be deleted, or have its
     amount/account changed, on its own — that would leave the loan and the line disagreeing. */
  select * into v_loan from public.employee_loans where bank_txn_id = old.id;
  if not found then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This line is the payout of the % to % (₹%), so it cannot be deleted on its own.',
      case v_loan.kind when 'salary_advance' then 'salary advance' when 'expense_advance' then 'expense advance' else 'loan' end,
      v_loan.employee_name, v_loan.principal
      using errcode = '23503', hint = '/accounting/loans',
            detail = 'Delete the loan on Accounting → Loans — its line goes with it.';
  end if;
  if new.debit <> v_loan.principal or new.credit <> 0 or new.bank_account_id is distinct from v_loan.bank_account_id then
    raise exception 'This line is the payout of the loan to % (₹%), so its amount or account changes only with the loan.',
      v_loan.employee_name, v_loan.principal
      using errcode = '23514', hint = '/accounting/loans',
            detail = 'Edit the loan on Accounting → Loans — its line changes with it.';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_employee_loan_line_guard on public.bank_transactions;
create trigger trg_employee_loan_line_guard
  before delete or update of debit, credit, bank_account_id on public.bank_transactions
  for each row execute function public.tg_employee_loan_line_guard();

-- ── old orphans: a payout left behind next to its correction credit ─────────────────────────
-- Stored data is NOT changed by this migration. These two functions let the OWNER see and remove
-- such a pair himself (Pardeep's staging test data, 24 Oct): the payout debit and its correction
-- credit are deleted together, so the account balance does not move — only the ghost row in
-- Payments Made goes. A pair is offered only when nothing else depends on it: both lines still
-- plain manual lines (not reconciled / re-booked), the payout is no loan's linked line, and the
-- person still has at least as many payouts left as loans that need one.
create or replace function public.employee_loan_ghost_pairs()
 returns table(payout_id uuid, correction_id uuid, bank_account_id uuid, account_name text,
               person text, amount integer, payout_date date, correction_date date)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
begin
  /* R-1873: owner only (it offers a delete). §17c: no company → nothing. */
  if not v_trusted and not public.current_user_has_role('owner') then
    raise exception 'Only the owner can see payout lines left behind by deleted loans' using errcode = '42501';
  end if;
  if v_tenant is null then return; end if;

  return query
  with p as (
    select t.id, t.bank_account_id, t.txn_date, t.debit as amount,
           regexp_replace(regexp_replace(t.description, '^(Loan/advance|Expense advance) to ', ''), ' \(edited\)$', '') as person,
           row_number() over (partition by t.bank_account_id, t.debit,
                              regexp_replace(regexp_replace(t.description, '^(Loan/advance|Expense advance) to ', ''), ' \(edited\)$', '')
                              order by t.txn_date, t.created_at, t.id) as rn
      from public.bank_transactions t
     where t.tenant_id = v_tenant and t.debit > 0 and t.source = 'manual'
       and t.matched_to_type = 'manual' and t.matched_to_id is null
       and (t.description like 'Loan/advance to %' or t.description like 'Expense advance to %')
       and not exists (select 1 from public.employee_loans l where l.bank_txn_id = t.id)
  ), c as (
    select t.id, t.bank_account_id, t.txn_date, t.credit as amount,
           regexp_replace(t.description, '^Correction: reversed loan/advance to ', '') as person,
           row_number() over (partition by t.bank_account_id, t.credit,
                              regexp_replace(t.description, '^Correction: reversed loan/advance to ', '')
                              order by t.txn_date, t.created_at, t.id) as rn
      from public.bank_transactions t
     where t.tenant_id = v_tenant and t.credit > 0 and t.source = 'manual'
       and t.matched_to_type = 'manual' and t.matched_to_id is null
       and t.description like 'Correction: reversed loan/advance to %'
  ), pc as (
    select p.bank_account_id, p.amount, p.person, count(*) as n from p group by 1, 2, 3
  ), legacy as (   -- old loans (no link) that still need one of these payouts
    select l.bank_account_id, l.principal as amount, l.employee_name as person, count(*) as n
      from public.employee_loans l
     where l.tenant_id = v_tenant and l.bank_txn_id is null and l.bank_account_id is not null
     group by 1, 2, 3
  )
  select p.id, c.id, p.bank_account_id, ba.name, p.person, p.amount, p.txn_date, c.txn_date
    from p
    join c  on c.bank_account_id = p.bank_account_id and c.amount = p.amount and c.person = p.person and c.rn = p.rn
    join pc on pc.bank_account_id = p.bank_account_id and pc.amount = p.amount and pc.person = p.person
    left join legacy lg on lg.bank_account_id = p.bank_account_id and lg.amount = p.amount and lg.person = p.person
    left join public.bank_accounts ba on ba.id = p.bank_account_id
   where p.rn <= pc.n - coalesce(lg.n, 0)
   order by p.txn_date, p.person;
end;
$function$;

create or replace function public.remove_employee_loan_ghost_pair(p_payout_id uuid, p_correction_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean := coalesce(auth.role(), '') = 'service_role'
                       or (auth.role() is null
                           and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_n       integer;
begin
  /* R-1873: owner only; §17c fail-closed; only a pair employee_loan_ghost_pairs() offers. */
  if not v_trusted and not public.current_user_has_role('owner') then
    raise exception 'Only the owner can remove a payout line left behind by a deleted loan' using errcode = '42501';
  end if;
  if v_tenant is null then
    raise exception 'No company selected — sign in again, then remove the line.' using errcode = '28000';
  end if;
  perform 1 from public.bank_transactions
   where id in (p_payout_id, p_correction_id) and tenant_id = v_tenant for update;
  if not exists (select 1 from public.employee_loan_ghost_pairs() g
                  where g.payout_id = p_payout_id and g.correction_id = p_correction_id) then
    raise exception 'These two lines are no longer a left-over pair (one was reconciled, re-booked, removed, or a loan still needs the payout), so nothing was removed.'
      using hint = '/accounting/loans',
            detail = 'Reload Accounting → Loans to see what is left; a reconciled line is un-reconciled on Banking first.';
  end if;
  delete from public.bank_transactions where id in (p_payout_id, p_correction_id) and tenant_id = v_tenant;
  get diagnostics v_n = row_count;
  if v_n <> 2 then raise exception 'Removed % of 2 lines — nothing was saved. Reload and try again.', v_n; end if;
end;
$function$;

revoke all on function public.employee_loan_ghost_pairs() from public;
revoke all on function public.remove_employee_loan_ghost_pair(uuid, uuid) from public;
grant execute on function public.employee_loan_ghost_pairs() to authenticated;
grant execute on function public.remove_employee_loan_ghost_pair(uuid, uuid) to authenticated;

grant execute on function public.disburse_employee_loan(text, integer, date, uuid, text, text) to authenticated;
grant execute on function public.delete_employee_loan(uuid) to authenticated;
grant execute on function public.edit_employee_loan(uuid, text, integer, date, uuid, text, text) to authenticated;
