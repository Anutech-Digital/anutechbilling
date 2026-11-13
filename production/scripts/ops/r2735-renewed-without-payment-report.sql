-- R-2735 — READ-ONLY report: subscriptions billed in parts whose renewal_date was moved to a new term although
-- that term's first part is NOT paid. 13 Nov 2026.
--
-- WHY: until R-2735, "Bill next part" (Renewals) and the renewals cron rolled a split-billed subscription's
-- renewal_date a whole term on, and set renewal_state 'renewed', the moment the new term's first part was
-- BILLED — its proforma unpaid. Pardeep (13 Nov): "jab tak payment na aaye renew to karna hi nahi". From
-- R-2735 on, only the payment moves it (roll_paid_renewal_terms). Rows moved BEFORE are left as they are;
-- this report lists them so the owner can decide each repair (move the date back / leave it).
--
-- WHAT IT IS: it changes NOTHING. The whole file runs inside `begin; set transaction read only; … rollback;`.
-- No email or phone column is selected. Whether to repair any row is Pardeep's decision.
--
-- RULE: an active / paused subscription billed monthly / quarterly / half-yearly (more than one part a term),
-- not billed elsewhere (Zoho, R-1763) for the term, whose CURRENT term (the newest laid term that starts on
-- or before renewal_date) is a RENEWAL term (not its first, sold term), and whose first part in that term
-- has no PAID tax invoice. Also listed: a renewal_date more than one term past the newest laid term (rolled
-- with no part laid at all).
--
-- SECTIONS
--   0. Login check (tenants_visible must equal the number of companies).
--   1. COUNT per company.
--   2. ROWS: one per subscription, with why (proforma unpaid / invoice unpaid / not billed / no part laid).
--   3. MOVES (R-2749): every automatic move of renewal_date by a renewal part since R-2735 — 'forward' when the
--      part was paid, 'back' when that payment was undone (full credit note / un-reconcile), 'held' when it was
--      undone but the date was left (sub not active, quote linked, seat cut scheduled — owner decides) — newest first.
--
-- R-2749 (14 Nov 2026) fixes: monthly flex subscriptions (1-month term billed monthly, every month a term) are
-- included; the CURRENT term is the newest laid term that starts BEFORE renewal_date (on an anniversary-shaped
-- date the term starting ON renewal_date is the next one, billed ahead), and a first part whose renews_from
-- equals renewal_date (billed, waiting for its payment, correctly not renewed) is never listed.
--
-- WHO RUNS IT: the manager or Pardeep. Claude does not run it on staging or live.
-- HOW (same instances as production/supabase/cloudsql/{staging,live}/deploy-db-*.sh):
--   cd C:/Users/mso50/new-reselleros/production
--   STAGING: gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   then:  \o r2735-staging.txt
--          \i scripts/ops/r2735-renewed-without-payment-report.sql
--          \o
--   Local Docker (proves it runs):
--     docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 < scripts/ops/r2735-renewed-without-payment-report.sql

begin;
set transaction read only;

\pset footer on
\pset null '·'

\echo
\echo '=== 0. Login check: tenants_visible should equal the number of companies ==='
select current_user                                                     as login,
       (select r.rolbypassrls from pg_roles r where r.rolname = current_user) as bypasses_row_security,
       (select count(*) from public.tenants)                             as tenants_visible,
       now() at time zone 'Asia/Kolkata'                                 as run_at_ist;

\echo
\echo '=== 1+2. Renewed (renewal_date moved) without the new term''s first part paid; rows_in_company = count per company ==='
with split as (
  select s.id, s.tenant_id, s.customer_name, s.plan, s.billing_cycle::text as cycle,
         greatest(1, coalesce(s.term_months, 12)) as term_months, s.start_date, s.renewal_date,
         s.renewal_state::text as renewal_state, s.status::text as status, s.billed_externally_until,
         case s.billing_cycle::text when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6 end as cycle_months
    from public.subscriptions s
   where s.status::text in ('active', 'paused')
     and s.renewal_date is not null
     and s.billing_cycle::text in ('monthly', 'quarterly', 'half_yearly')
), terms as (
  select sp.*,
         /* R-2749: strictly before renewal_date — see the header */
         (select max(b.term_start) from public.subscription_billings b
           where b.subscription_id = sp.id and b.tenant_id = sp.tenant_id and b.term_start < sp.renewal_date) as cur_term,
         (select min(b.term_start) from public.subscription_billings b
           where b.subscription_id = sp.id and b.tenant_id = sp.tenant_id) as first_term
    from split sp
   where sp.cycle_months <= sp.term_months   -- R-2749: '=' keeps monthly flex (each month is a term)
), firstpart as (
  select t.*,
         b.id as part_id, b.period_index, b.period_start, b.invoice_id, b.renews_from,
         i.status::text as invoice_status,
         rq.id as request_id, rq.status::text as request_status, rq.amount as request_amount,
         (select coalesce(sum(p.amount), 0) from public.payments p
           where p.quote_id = rq.id and p.status = 'received') as request_received,
         /* the term that renewal_date closes starts about one term before it; the newest laid term is older
            than that by more than a few days → the date was rolled with no part laid */
         (t.cur_term < (t.renewal_date - make_interval(months => t.term_months))::date - 3) as no_part_laid
    from terms t
    left join lateral (
      select b2.* from public.subscription_billings b2
       where b2.subscription_id = t.id and b2.tenant_id = t.tenant_id and b2.term_start = t.cur_term
       order by b2.period_index limit 1) b on true
    left join public.invoices i on i.id = b.invoice_id and i.tenant_id = t.tenant_id
    left join lateral (
      select q.id, q.status, q.amount from public.quotes q
       where q.subscription_billing_id = b.id and q.tenant_id = t.tenant_id and q.cancelled_at is null
       order by q.created_at desc limit 1) rq on true
   where t.cur_term is not null
), off as (
  select f.*,
         case when f.no_part_laid then 'no part laid for the current term'
              when f.invoice_id is not null then 'tax invoice not paid'
              when f.request_id is not null then 'proforma not paid'
              else 'first part not billed' end as why
    from firstpart f
   where (f.no_part_laid or (f.cur_term > f.first_term and coalesce(f.invoice_status, '') <> 'paid'))
     /* R-2749: a part that renews FROM the current renewal_date is waiting for its payment — not renewed */
     and f.renews_from is distinct from f.renewal_date
     and (f.billed_externally_until is null
          or f.billed_externally_until < greatest(f.cur_term, (f.renewal_date - make_interval(months => f.term_months))::date))
)
select o.tenant_id, count(*) over (partition by o.tenant_id) as rows_in_company,
       o.id as subscription_id, o.customer_name, o.plan, o.cycle, o.term_months, o.status,
       o.start_date, o.renewal_date, o.renewal_state, o.cur_term as current_term_laid_from,
       o.period_index as first_part, o.period_start as first_part_starts,
       o.request_id as proforma, o.request_status as proforma_status, o.request_amount as proforma_amount,
       o.request_received as proforma_received, o.invoice_id, o.invoice_status, o.why
  from off o
 order by o.tenant_id, o.renewal_date, o.id;

\echo
\echo '=== 3. Moves of renewal_date by a renewal part (R-2749): forward = part paid, back = payment undone, held = undone but date left (owner decides) ==='
select m.tenant_id, m.subscription_id, s.customer_name, s.plan, m.direction, m.from_date, m.to_date,
       m.invoice_id, m.why, m.created_at at time zone 'Asia/Kolkata' as moved_at_ist,
       s.renewal_date as renewal_date_now, s.renewal_state::text as renewal_state_now
  from public.subscription_renewal_moves m
  join public.subscriptions s on s.id = m.subscription_id and s.tenant_id = m.tenant_id
 order by m.tenant_id, m.created_at desc, m.id desc;

rollback;
