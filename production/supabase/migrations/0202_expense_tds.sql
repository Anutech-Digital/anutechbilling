-- 0202 — TDS deducted on expenses (for GSTR... no: for TDS return 26Q).
--
-- Lets the company record the TDS it DEDUCTS when paying vendors / rent /
-- professional fees / contractors (sections 194C/194J/194I/194H/194A). This is
-- the deductor side that feeds the quarterly 26Q return. Optional per expense.
-- (Salary TDS lives on salary_payments.tds → 24Q; this is the non-salary side.)

alter table public.expenses
  add column if not exists tds_section text,
  add column if not exists tds_amount  integer not null default 0;

comment on column public.expenses.tds_section is 'TDS section for 26Q — 194C/194J/194I/194H/194A/etc. Null = no TDS deducted.';
comment on column public.expenses.tds_amount  is 'TDS deducted (₹) on this payment — deductor side, feeds 26Q.';
