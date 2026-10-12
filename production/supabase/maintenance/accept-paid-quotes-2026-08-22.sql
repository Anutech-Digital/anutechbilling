-- Bring two pre-existing quotes in line with the rule applied in
-- 20260821210000_accept_quote_on_first_payment.sql.
--
-- WHY A SCRIPT AND NOT THE MIGRATION
--   A change to record_payment cannot reach rows that were written before it existed.
--   These two took money under the old rule, so their workflow status never caught up:
--
--     Q-3BBD-2026-27-0001  Demo Co  Rs 54,938  payment_status=invoiced status=sent
--     Q-ADPL-2026-27-0024  ANUTECH (delhom)    Rs 20,000  payment_status=partial  status=sent
--
--   The first is the one that matters: a GST tax invoice has been issued against a quote
--   the app still describes as merely "sent". Under CGST that invoice is a real document;
--   the quote behind it is not "awaiting the customer's decision".
--
-- WHY THIS IS SAFE TO RUN, checked against the live triggers before writing it
--   quotes carries four triggers. Two are irrelevant (updated_at, and log_row_change,
--   which is an audit log and SHOULD record this). The other two were read in full:
--
--   * handle_quote_status_change sets payment_status := 'awaiting' when a quote becomes
--     accepted -- but only `if new.payment_status = 'none'`. Both rows are 'partial' and
--     'invoiced', so the money column is not touched. This is the trigger that would have
--     been the real hazard: silently rewriting payment_status on a paid quote.
--
--   * raise_provisioning_on_payment inserts a provisioning task, but only on a TRANSITION
--     of payment_status into received/invoiced. This statement does not write
--     payment_status at all, so old = new and the guard is false. No duplicate task.
--
-- WHAT THIS TOUCHES: quotes.status, on two ids, and nothing else. No money column, no
-- payment row, no subscription, no invoice.
--
-- GUARDED, so a second run or a changed row is a no-op rather than a wrong write: the
-- WHERE clause re-states the state each row must still be in. If somebody has since
-- accepted or rejected them by hand, zero rows update and that is the correct outcome.

update public.quotes
   set status = 'accepted'::public.quote_status
 where id in ('Q-3BBD-2026-27-0001', 'Q-ADPL-2026-27-0024')
   and status in ('draft', 'sent', 'viewed')
   and payment_status in ('partial', 'received', 'invoiced')
returning id, status::text as new_status, payment_status::text as payment_status,
          amount, payment_amount;
