-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.subscription_dues_drift()') and prosrc like '%R-2154%')
-- deploy-key: r2154subscriptionduesdrift
-- 20261031023525_r2154_subscription_dues_drift.sql
--
-- R-2154 (31 Oct 2026, R-1823 repair report §7 on staging): the R-1708 dues-drift check listed 12
-- subscriptions of one company, −₹22,52,838 in all, every one on a quote with no invoice. Two of
-- its causes were the CHECK, not the data:
--   1. Unlike things compared. It put EACH subscription's stored balance
--      (subscriptions.outstanding_amount) next to the WHOLE quote's open balance. A quote's
--      balance rides on its FIRST subscription only (record_payment, activate_quote_on_credit,
--      sync_split_outstanding — R-2092), so a quote with two subscriptions came out twice: the
--      second one always "differs" by the full balance (THE PROWRITE ₹5,82,188 on both rows,
--      MOTION PHILM on both).
--   2. The whole contract counted for a quote billed in parts. quote_open_balance is
--      quotes.amount − receipts — the whole year. A quote billed monthly / quarterly / half-yearly
--      owes only the parts whose date has come; that is what the app stores
--      (split_outstanding_for, R-527 + R-2044: from the first part with its own payment request,
--      the part is owed on that request, not on the subscription). MOTION PHILM stored ₹60 =
--      Q1 ₹95,993 − ₹95,933 received — correct; the report said ₹2,88,039.
--
-- WHAT THIS ADDS
--   public.subscription_dues_drift() — ONE row per QUOTE whose subscriptions' stored balances,
--   SUMMED, differ by ₹1 or more from what the app itself says that quote should carry:
--     · split-billed, no whole-term invoice → split_outstanding_for(quote, first subscription's
--       start) — the same call and the same term start sync_split_outstanding uses;
--     · otherwise                           → quote_open_balance(quote) (an invoiced quote: its
--       open invoices; not invoiced: amount − receipts).
--   Left out: a quote with a written-off subscription (the write-off is the decision on that
--   claim) and a quote whose subscriptions are ALL cancelled (cancel clears the due — R-1711; an
--   open invoice there is §1's business). Every row says which rule gave the expected figure and
--   carries what is needed to explain it (cycle, invoice_on_receipt, amount, receipts, the
--   subscriptions' ids / statuses / sources).
--   READ-ONLY. It changes nothing; correcting a stored balance is Pardeep's decision.
--   SECURITY INVOKER: it sees what the caller sees. Execute for service_role only (the report is
--   run by the manager as the migration login, which owns the functions it calls).
--
-- Used by scripts/ops/r1708-dues-drift-report.sql and scripts/ops/r1823-repair-reports.sql §7.
-- Test: supabase/tests/r2154_dues_drift_per_quote.test.sql

begin;

create or replace function public.subscription_dues_drift()
returns table(
  tenant_id            uuid,
  quote_id             text,
  customer_name        text,
  subscriptions        integer,
  subscription_ids     uuid[],
  subscription_status  text[],
  external_source      text[],
  first_start          date,
  billing_cycle        text,
  invoice_on_receipt   boolean,
  quote_amount         integer,
  received             integer,
  quote_invoiced       boolean,
  stored_outstanding   integer,
  expected_outstanding integer,
  quote_open_balance   integer,
  difference           integer,
  expected_from        text
)
language sql
stable
security invoker
set search_path = public
as $$
  /* R-2154: per QUOTE (subscriptions summed) against what the app stores for that quote —
     the due parts for a quote billed in parts, quote_open_balance otherwise. */
  with per_quote as (
    select s.tenant_id, s.quote_id,
           count(*)::int                                                         as n,
           array_agg(s.id order by s.created_at, s.id)                           as ids,
           array_agg(s.status::text order by s.created_at, s.id)                 as statuses,
           array_agg(coalesce(s.external_source, '-') order by s.created_at, s.id) as sources,
           (array_agg(s.start_date order by s.created_at, s.id))[1]              as first_start,
           sum(coalesce(s.outstanding_amount, 0))::int                           as stored,
           bool_or(s.written_off_at is not null)                                 as any_written_off,
           bool_and(s.status::text = 'cancelled')                                as all_cancelled,
           min(s.customer_name)                                                  as customer_name
      from public.subscriptions s
     where s.quote_id is not null
     group by s.tenant_id, s.quote_id
  ), expected as (
    select pq.*, q.billing_cycle::text as cycle, q.invoice_on_receipt as on_receipt,
           coalesce(q.amount, 0)::int as amount,
           (select coalesce(sum(p.amount), 0)::int from public.payments p
             where p.tenant_id = pq.tenant_id and p.quote_id = pq.quote_id and p.status = 'received') as received,
           exists (select 1 from public.invoices i where i.quote_id = pq.quote_id)                    as invoiced,
           public.split_outstanding_for(pq.quote_id, pq.first_start)                                  as split_owed,
           public.quote_open_balance(pq.quote_id)                                                     as open_bal
      from per_quote pq
      join public.quotes q on q.id = pq.quote_id and q.tenant_id = pq.tenant_id
     where not pq.any_written_off
       and not pq.all_cancelled
  )
  select e.tenant_id, e.quote_id, e.customer_name, e.n, e.ids, e.statuses, e.sources, e.first_start,
         e.cycle, e.on_receipt, e.amount, e.received, e.invoiced,
         e.stored,
         coalesce(e.split_owed, e.open_bal, 0),
         e.open_bal,
         e.stored - coalesce(e.split_owed, e.open_bal, 0),
         case when e.split_owed is not null then 'split_parts_due' else 'quote_open_balance' end
    from expected e
   where abs(e.stored - coalesce(e.split_owed, e.open_bal, 0)) >= 1
   order by e.tenant_id, abs(e.stored - coalesce(e.split_owed, e.open_bal, 0)) desc, e.quote_id;
$$;

comment on function public.subscription_dues_drift() is
  'R-2154 (R-1708 check, R-1823 §7): one row per quote whose subscriptions'' stored balances, summed, differ by ₹1+ from what the app stores for that quote — split_outstanding_for (parts due) for a quote billed in parts, quote_open_balance otherwise. Read-only report; service_role only.';

revoke all on function public.subscription_dues_drift() from public, anon, authenticated;
grant execute on function public.subscription_dues_drift() to service_role;

commit;
