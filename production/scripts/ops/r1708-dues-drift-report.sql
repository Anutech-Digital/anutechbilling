-- R-1708: subscriptions whose stored balance (subscriptions.outstanding_amount) disagrees with
-- what their own quote should carry. READ-ONLY REPORT. It changes nothing: whether and how to
-- correct a stored balance is Pardeep's decision (CLAUDE.md: data repairs stay with the owner).
-- The manager runs it on staging (as the migration login), e.g. through
-- `gcloud sql export csv --query` like r909-schema-fingerprint.sql.
--
-- R-2154 (31 Oct 2026): ONE row per QUOTE, through public.subscription_dues_drift() (migration
-- 20261031023525 — the one rule, also used by r1823-repair-reports.sql §7):
--   stored_outstanding    the quote's subscriptions' balances SUMMED (the balance rides on the
--                         first subscription — record_payment / activate_quote_on_credit / R-2092);
--   expected_outstanding  'split_parts_due' for a quote billed in parts with no whole-term invoice:
--                         the parts whose date has come − receipts (split_outstanding_for,
--                         R-527/R-2044 — exactly what sync_split_outstanding stores);
--                         'quote_open_balance' otherwise (invoiced: its open invoices — then the
--                         invoice is the claim and the screens ignore the subscription balance,
--                         R-1708; not invoiced: amount − receipts).
-- Left out: quotes with a written-off subscription, quotes whose subscriptions are all cancelled.
-- Before R-2154 each subscription was compared with the whole quote's open balance, so a quote
-- with two subscriptions came out twice and a split-billed quote's future parts looked owed
-- (staging 31 Oct: 12 rows, −₹22,52,838).
select d.tenant_id, d.quote_id, d.customer_name, d.subscriptions, d.subscription_ids,
       d.subscription_status, d.external_source, d.first_start, d.billing_cycle, d.invoice_on_receipt,
       d.quote_amount, d.received, d.quote_invoiced,
       d.stored_outstanding, d.expected_outstanding, d.quote_open_balance, d.difference, d.expected_from
  from public.subscription_dues_drift() d
 order by d.tenant_id, abs(d.difference) desc, d.quote_id;
