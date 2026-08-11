-- 0223 — add roles for the fuller org hierarchy.
--
-- The user_role enum had: owner, sales, accountant, support, sales_senior.
-- The app already uses 'manager' (nav + ROLE_HOME) but it was missing from the
-- enum, so a Manager could never actually be assigned. Add it, plus the two new
-- specialist roles from the role-hierarchy plan:
--   • billing  — Billing / Accounts (money-in-books: invoices, payments,
--                subscriptions, purchases, GST, payroll run).
--   • delivery — Projects / Delivery (custom-software project execution).

alter type public.user_role add value if not exists 'manager';
alter type public.user_role add value if not exists 'billing';
alter type public.user_role add value if not exists 'delivery';
