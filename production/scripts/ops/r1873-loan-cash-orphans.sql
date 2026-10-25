-- R-1873: loans / advances whose cash line and register row disagree — the "ghost row" Pardeep
-- saw on staging (24 Oct 2026, a test company: two "Loan/advance to Prashant −₹2,000" rows
-- in Payments Made, one loan in the register, Petty Cash −₹2,000).
--
-- READ-ONLY REPORT. It changes nothing: whether and how to clean an orphan is Pardeep's decision
-- (data repairs stay with the owner). The manager runs it on staging (then live, if Pardeep
-- asks), e.g. `gcloud sql export csv --query` like r909-schema-fingerprint.sql, and Pardeep decides.
--
-- How the orphans were made: before R-1873, deleting (or editing the amount/account of) an
-- employee loan did not remove its payout line — it added a "Correction: reversed loan/advance
-- to <name>" CREDIT dated that day. The balance nets out, but Payments Made lists the payout
-- (debit) and not the credit, so it shows a payment that no loan backs.
--
-- One row per company · account · person where they disagree:
--   payout_*      = "Loan/advance to <name>" / "Expense advance to <name>" debit lines (Payments Made rows)
--   correction_*  = "Correction: reversed loan/advance to <name>" credit lines
--   register_*    = employee_loans rows for that person paid from that account (Loans register / Balance Sheet)
--   ghost_rows    = payout rows Payments Made shows with no loan behind them
--   cash_vs_register = (payouts − corrections) − register: ≠ 0 means the cash side and the register disagree in money
--   *_ids         = the exact lines / loans, to look at on Banking → the account (?focus=<line id>)
-- Second part: loans given to outside parties (loans_given) with no cash line, and "Loan given:"
-- lines that no loan points to.
-- A row that is a reconciled/re-booked line (matched_to_type other than 'manual') is shown with
-- rebooked_lines > 0 — leave those to the accountant.

with payout as (
  select t.tenant_id, t.bank_account_id,
         regexp_replace(regexp_replace(t.description, '^(Loan/advance|Expense advance) to ', ''), ' \(edited\)$', '') as person,
         t.id, t.debit as amount, t.matched_to_type
    from public.bank_transactions t
   where t.debit > 0
     and t.source = 'manual'
     and (t.description like 'Loan/advance to %' or t.description like 'Expense advance to %')
),
correction as (
  select t.tenant_id, t.bank_account_id,
         regexp_replace(t.description, '^Correction: reversed loan/advance to ', '') as person,
         t.id, t.credit as amount
    from public.bank_transactions t
   where t.credit > 0
     and t.source = 'manual'
     and t.description like 'Correction: reversed loan/advance to %'
),
register as (
  select l.tenant_id, l.bank_account_id, l.employee_name as person, l.id, l.principal as amount
    from public.employee_loans l
   where l.bank_account_id is not null
),
keys as (
  select tenant_id, bank_account_id, person from payout
  union select tenant_id, bank_account_id, person from correction
  union select tenant_id, bank_account_id, person from register
),
emp as (
  select k.tenant_id, k.bank_account_id, k.person,
         (select count(*)               from payout p     where (p.tenant_id, p.bank_account_id, p.person) = (k.tenant_id, k.bank_account_id, k.person)) as payout_rows,
         (select coalesce(sum(amount),0) from payout p    where (p.tenant_id, p.bank_account_id, p.person) = (k.tenant_id, k.bank_account_id, k.person)) as payout_total,
         (select count(*) filter (where p.matched_to_type is distinct from 'manual')
                                         from payout p     where (p.tenant_id, p.bank_account_id, p.person) = (k.tenant_id, k.bank_account_id, k.person)) as rebooked_lines,
         (select count(*)               from correction c where (c.tenant_id, c.bank_account_id, c.person) = (k.tenant_id, k.bank_account_id, k.person)) as correction_rows,
         (select coalesce(sum(amount),0) from correction c where (c.tenant_id, c.bank_account_id, c.person) = (k.tenant_id, k.bank_account_id, k.person)) as correction_total,
         (select count(*)               from register r   where (r.tenant_id, r.bank_account_id, r.person) = (k.tenant_id, k.bank_account_id, k.person)) as register_rows,
         (select coalesce(sum(amount),0) from register r  where (r.tenant_id, r.bank_account_id, r.person) = (k.tenant_id, k.bank_account_id, k.person)) as register_total,
         (select string_agg(p.id::text, ' ' order by p.id) from payout p     where (p.tenant_id, p.bank_account_id, p.person) = (k.tenant_id, k.bank_account_id, k.person)) as payout_line_ids,
         (select string_agg(c.id::text, ' ' order by c.id) from correction c where (c.tenant_id, c.bank_account_id, c.person) = (k.tenant_id, k.bank_account_id, k.person)) as correction_line_ids,
         (select string_agg(r.id::text, ' ' order by r.id) from register r   where (r.tenant_id, r.bank_account_id, r.person) = (k.tenant_id, k.bank_account_id, k.person)) as loan_ids
    from keys k
)
select te.name                                   as company,
       e.tenant_id,
       'employee loan / advance'                 as kind,
       ba.name                                   as account,
       e.person,
       e.payout_rows, e.payout_total,
       e.correction_rows, e.correction_total,
       e.register_rows, e.register_total,
       greatest(e.payout_rows - e.register_rows, 0)                        as ghost_rows,
       (e.payout_total - e.correction_total) - e.register_total            as cash_vs_register,
       e.rebooked_lines,
       e.payout_line_ids, e.correction_line_ids, e.loan_ids
  from emp e
  join public.tenants te on te.id = e.tenant_id
  left join public.bank_accounts ba on ba.id = e.bank_account_id
 where e.payout_rows <> e.register_rows
    or e.correction_rows > 0
    or (e.payout_total - e.correction_total) <> e.register_total

union all

-- loans given to outside parties: a loan whose cash line is gone / never written
select te.name, g.tenant_id, 'loan given — no cash line', ba.name, g.borrower_name,
       0, 0, 0, 0, 1, g.principal, 0, -g.principal, 0,
       null, null, g.id::text
  from public.loans_given g
  join public.tenants te on te.id = g.tenant_id
  left join public.bank_accounts ba on ba.id = g.paid_from_account_id
 where g.paid_from_account_id is not null
   and (g.bank_txn_id is null or not exists (select 1 from public.bank_transactions t where t.id = g.bank_txn_id))

union all

-- a "Loan given:" payout line that no loan points to (Payments Made shows it, no register row)
select te.name, t.tenant_id, 'loan given — line with no loan', ba.name,
       regexp_replace(t.description, '^Loan given: ', ''),
       1, t.debit, 0, 0, 0, 0, 1, t.debit, (t.matched_to_type is distinct from 'manual')::int,
       t.id::text, null, null
  from public.bank_transactions t
  join public.tenants te on te.id = t.tenant_id
  left join public.bank_accounts ba on ba.id = t.bank_account_id
 where t.debit > 0 and t.source = 'manual' and t.description like 'Loan given: %'
   and not exists (select 1 from public.loans_given g where g.bank_txn_id = t.id)

order by 1, 3, 4, 5;
