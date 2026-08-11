-- 0203 — Source bank account on an expense.
--
-- When an expense is paid by bank transfer / UPI / card / cheque, record WHICH
-- bank account the money left from (the owner asked: "bank transfer me bank ka
-- naam aana chahiye"). This is a reference + reconcile hint — the actual debit
-- still comes from the imported bank statement line (so no double-count). Cash
-- payments keep using the petty-cash flow instead.

alter table public.expenses
  add column if not exists bank_account_id uuid references public.bank_accounts(id) on delete set null;

comment on column public.expenses.bank_account_id is 'Source bank account the money was paid FROM (bank/UPI/card/cheque). Reference + reconcile hint; the actual debit comes from the imported statement line.';
