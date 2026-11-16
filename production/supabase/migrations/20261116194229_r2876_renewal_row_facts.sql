-- deploy-peek: to_regprocedure('public.renewal_row_facts(uuid[],text[])') is not null
-- deploy-key: r2876renewalrowfacts
-- 20261116194229_r2876_renewal_row_facts.sql
--
-- R-2876 (16 Nov 2026): the Renewals page's Status / Last bill waited for FOUR trips in a row after the table showed
-- (R-2861 measured it: quotes + billing parts, then part proformas + invoices, then quote lines + credit / debit notes,
-- then Last paid's payments). Each trip only asks for rows named by the trip before, so the browser cannot ask sooner.
-- This function reads the same rows in ONE trip: given the listed subscription ids (and the quote ids those
-- subscriptions point at) it returns every row those reads can ask for.
--
-- READ-ONLY. SECURITY INVOKER — it runs as the signed-in caller, so every table's RLS decides what comes back, exactly
-- as for the browser's own reads (another company's ids return nothing; a role that may not read invoices or payments
-- gets none). It returns ROWS only: no totals, no amounts worked out here — the page's own rules (renewals/last-docs.ts,
-- last-paid.ts) still do all of that, on the same rows as before (renewals/row-facts-data.ts answers the old reads from
-- this answer; a read it cannot answer fully falls back to the old way).
--
-- What comes back (each list in `order by id`, the order the browser's reads used):
--   quotes         linked to the subscriptions (renewal / add-seats link, the ids in p_quote_ids, a together-quote link,
--                  or the proforma of one of their billing parts) → main = true; plus the quote an invoice below came
--                  from (only its lines are needed, for the period words) → main = false
--   billings       subscription_billings of the subscriptions
--   links          renewal_quote_subscriptions of the subscriptions (released ones too — the page leaves them out)
--   invoices       named by a billing part or a main quote (invoice_id), or raised from a main quote / a p_quote_ids quote
--   credit_notes, debit_notes   of those invoices (id, invoice_id, amount — rows, not totals)
--   subscriptions  made from a main quote / a p_quote_ids quote (id, quote_id — "covers N subscriptions")
--   payments       status 'received', on a main quote / a p_quote_ids quote or on one of those invoices
--   invoice_ids    every invoice id named by a billing part or a main quote, readable or not (so the page knows which
--                  ids this answer covers)
-- No prices, quotes, invoices or payments change. Tests: supabase/tests/r2876_renewal_row_facts.test.sql,
-- src/app/(app)/renewals/row-facts-r2876.test.ts.

begin;

create or replace function public.renewal_row_facts(p_sub_ids uuid[], p_quote_ids text[] default '{}')
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with
  subs as materialized (
    select distinct x as id from unnest(coalesce(p_sub_ids, '{}'::uuid[])) as x where x is not null
  ),
  asked_quotes as materialized (
    select distinct x as id from unnest(coalesce(p_quote_ids, '{}'::text[])) as x where x is not null
  ),
  links as materialized (
    select l.id, l.quote_id, l.subscription_id, l.renewal_term_date, l.subtotal, l.renewed_at, l.released_at
      from public.renewal_quote_subscriptions l
     where l.subscription_id in (select id from subs)
  ),
  billings as materialized (
    select b.id, b.subscription_id, b.invoice_id, b.term_start, b.period_index, b.due_on, b.period_start, b.period_end, b.taxable_amount
      from public.subscription_billings b
     where b.subscription_id in (select id from subs)
  ),
  main_ids as materialized (
    select q.id from public.quotes q where q.renewal_subscription_id in (select id from subs)
    union
    select q.id from public.quotes q where q.add_seats_subscription_id in (select id from subs)
    union
    select q.id from public.quotes q where q.id in (select id from asked_quotes)
    union
    select q.id from public.quotes q where q.id in (select quote_id from links)
    union
    select q.id from public.quotes q where q.subscription_billing_id in (select id from billings)
  ),
  main_invoice_ids as materialized (
    select b.invoice_id as id from billings b where b.invoice_id is not null
    union
    select q.invoice_id from public.quotes q where q.id in (select id from main_ids) and q.invoice_id is not null
  ),
  quote_keys as materialized (
    select id from main_ids
    union
    select id from asked_quotes
  ),
  inv as materialized (
    select i.id, i.quote_id, i.invoice_date, i.status, i.amount, i.paid_amount, i.currency, i.created_at, i.due_date,
           i.net_payable, i.adjusted_advances, i.written_off_at, i.fx_rate
      from public.invoices i
     where i.id in (select id from main_invoice_ids)
    union
    select i.id, i.quote_id, i.invoice_date, i.status, i.amount, i.paid_amount, i.currency, i.created_at, i.due_date,
           i.net_payable, i.adjusted_advances, i.written_off_at, i.fx_rate
      from public.invoices i
     where i.quote_id in (select id from quote_keys)
  ),
  invoice_keys as materialized (
    select id from main_invoice_ids
    union
    select id from inv
  ),
  all_quote_ids as materialized (
    select id, true as main from main_ids
    union all
    select i.quote_id, false from inv i
     where i.quote_id is not null and i.quote_id not in (select id from main_ids)
     group by i.quote_id
  )
  select jsonb_build_object(
    'quotes', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.id) from (
        select q.id, q.status, q.payment_status, q.created_at, q.created_date, q.expires_date, q.invoice_id,
               q.renewal_subscription_id, q.add_seats_subscription_id, q.subscription_billing_id, q.superseded_by,
               q.revision_of, q.amount, q.currency, q.exchange_rate, q.line_items, q.is_renewal, q.is_extension,
               q.is_add_seats, q.is_one_off, q.extension_months, q.renewal_term_date, a.main
          from public.quotes q join all_quote_ids a on a.id = q.id
      ) r), '[]'::jsonb),
    'billings', coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from billings b), '[]'::jsonb),
    'links', coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from links l), '[]'::jsonb),
    'invoices', coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from inv i), '[]'::jsonb),
    'credit_notes', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.id) from (
        select n.id, n.invoice_id, n.amount from public.credit_notes n where n.invoice_id in (select id from invoice_keys)
      ) r), '[]'::jsonb),
    'debit_notes', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.id) from (
        select n.id, n.invoice_id, n.amount from public.debit_notes n where n.invoice_id in (select id from invoice_keys)
      ) r), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.id) from (
        select s.id, s.quote_id from public.subscriptions s where s.quote_id in (select id from quote_keys)
      ) r), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.id) from (
        select p.id, p.amount, p.method, p.status, p.received_at, p.refunded_at, p.quote_id, p.invoice_id, p.receipt_voucher_no, p.reference
          from public.payments p
         where p.status = 'received' and p.quote_id in (select id from quote_keys)
        union
        select p.id, p.amount, p.method, p.status, p.received_at, p.refunded_at, p.quote_id, p.invoice_id, p.receipt_voucher_no, p.reference
          from public.payments p
         where p.status = 'received' and p.invoice_id in (select id from invoice_keys)
      ) r), '[]'::jsonb),
    'invoice_ids', coalesce((select jsonb_agg(m.id order by m.id) from main_invoice_ids m), '[]'::jsonb)
  );
$$;

revoke all on function public.renewal_row_facts(uuid[], text[]) from public;
revoke all on function public.renewal_row_facts(uuid[], text[]) from anon;
grant execute on function public.renewal_row_facts(uuid[], text[]) to authenticated;

comment on function public.renewal_row_facts(uuid[], text[]) is
  'R-2876: the rows behind the Renewals page''s Status / Last bill for the listed subscriptions, in one read — linked quotes, billing parts, together-quote links, invoices, credit / debit notes, sibling subscriptions and received payments. READ-ONLY, SECURITY INVOKER: RLS decides every row; rows only, no totals. The page (renewals/row-facts-data.ts) answers its old reads from this and falls back to them when this function is missing.';

commit;
