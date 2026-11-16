-- deploy-peek: to_regclass('public.quotes_add_seats_subscription_idx') is not null and to_regclass('public.payment_followups_subscription_idx') is not null and to_regclass('public.quotes_renewal_term_date_idx') is not null
-- deploy-key: r2766renewalsreadindexes
-- 20261114062123_r2766_renewals_read_indexes.sql
--
-- R-2766 (14 Nov 2026, R-2742 PERF-3) — the Renewals page froze on staging (13–14 Nov); its batched
-- reads (renewals/last-docs-data.ts, last-paid-data.ts, queue-data.ts) filter on three columns that have
-- NO index. Checked on the local DB before writing this: quotes.renewal_subscription_id
-- (quotes_one_renewal_per_term), quotes.subscription_billing_id (quotes_subscription_billing_once),
-- invoices.quote_id, payments.quote_id / invoice_id, subscriptions.quote_id and
-- subscription_billings.subscription_id are already indexed.
--
-- ─── ADDS (indexes only — no data, no function, no policy changes) ─────────────────────────────────────
--   quotes_add_seats_subscription_idx   quotes (add_seats_subscription_id)  where it is not null
--       The rows' quotes are read with `renewal_subscription_id IN (…) OR add_seats_subscription_id IN (…)`;
--       with only one side indexed the planner cannot BitmapOr the two and reads the whole quotes table.
--   payment_followups_subscription_idx  payment_followups (subscription_id) where it is not null
--       The rows' follow-ups (queue-data.ts useRenewalFollowups: `subscription_id IN (…)`).
--   quotes_renewal_term_date_idx        quotes (tenant_id, renewal_term_date) where it is not null
--       "Renewed this month" (queue-data.ts useRenewalPaymentsForMonth: is_renewal and renewal_term_date
--       between the month's first and last day; RLS adds the tenant).
--
-- Partial (where … is not null): most quotes are not add-seats / renewal quotes and most follow-ups are on
-- invoices, so the indexes stay small. `if not exists` — safe to run again. Plain CREATE INDEX (not
-- CONCURRENTLY: a migration runs inside a transaction); the tables are small (staging: hundreds to a few
-- thousand rows), so the build lock is milliseconds.

create index if not exists quotes_add_seats_subscription_idx
  on public.quotes (add_seats_subscription_id)
  where add_seats_subscription_id is not null;

create index if not exists payment_followups_subscription_idx
  on public.payment_followups (subscription_id)
  where subscription_id is not null;

create index if not exists quotes_renewal_term_date_idx
  on public.quotes (tenant_id, renewal_term_date)
  where renewal_term_date is not null;
