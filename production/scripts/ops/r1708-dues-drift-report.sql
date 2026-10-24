-- R-1708: subscriptions whose stored balance (subscriptions.outstanding_amount) disagrees with
-- what their own quote still has open (quote_open_balance — credit notes and refunds counted).
-- READ-ONLY REPORT. It changes nothing: whether and how to correct a stored balance is
-- Pardeep's decision (CLAUDE.md: data repairs stay with the owner). The manager runs it on
-- staging, e.g. through `gcloud sql export csv --query` like r909-schema-fingerprint.sql.
--
-- Columns: tenant, subscription, customer, its quote, stored balance, quote's open balance,
-- the difference (stored − open), and whether an invoice already exists for the quote (then the
-- invoice is the claim and the screens ignore the subscription balance — R-1708 rule).
select s.tenant_id,
       s.id                                  as subscription_id,
       s.customer_name,
       s.quote_id,
       round(coalesce(s.outstanding_amount, 0)::numeric, 2)                         as stored_outstanding,
       round(public.quote_open_balance(s.quote_id)::numeric, 2)                     as quote_open_balance,
       round((coalesce(s.outstanding_amount, 0) - public.quote_open_balance(s.quote_id))::numeric, 2) as difference,
       exists (select 1 from public.invoices i where i.quote_id = s.quote_id)        as quote_invoiced
  from public.subscriptions s
 where s.quote_id is not null
   and s.written_off_at is null
   and abs(coalesce(s.outstanding_amount, 0) - public.quote_open_balance(s.quote_id)) >= 1
 order by s.tenant_id, abs(coalesce(s.outstanding_amount, 0) - public.quote_open_balance(s.quote_id)) desc;
