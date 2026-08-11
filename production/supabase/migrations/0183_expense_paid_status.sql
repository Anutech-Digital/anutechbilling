-- 0183 — Expense paid/unpaid (accounts-payable lite)
--
-- Until now an expense implied "already paid" (payment_method was always set).
-- Resellers often buy on CREDIT: the bill arrives, money goes out later. We
-- track that with a `paid` flag + an optional `due_date` (when it's owed) and
-- `paid_date` (when it was actually settled).
--
-- Money rules (enforced in the app):
--   • P&L is ACCRUAL — an expense hits the P&L on expense_date whether paid or
--     not. So these columns do NOT change any P&L total.
--   • CASH/BANK only moves when paid = true. An unpaid expense never creates a
--     petty-cash debit and is never offered as a bank-reconcile candidate.
--
-- Existing rows were all recorded as already-paid → default paid = true and we
-- stamp paid_date = expense_date so "paid on" has a sensible value.

alter table public.expenses
  add column if not exists paid      boolean not null default true,
  add column if not exists paid_date date,
  add column if not exists due_date  date;

update public.expenses
   set paid_date = expense_date
 where paid is true
   and paid_date is null;

comment on column public.expenses.paid      is 'true = money already went out; false = payable (bill received, settle later)';
comment on column public.expenses.paid_date is 'date the expense was actually settled (null while unpaid)';
comment on column public.expenses.due_date  is 'date the payable is owed (optional; only meaningful while unpaid)';

-- Speed up the "what do I still owe?" rollup.
create index if not exists expenses_tenant_unpaid_idx
  on public.expenses (tenant_id)
  where paid = false;
