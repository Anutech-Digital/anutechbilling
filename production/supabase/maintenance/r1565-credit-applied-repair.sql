-- R-1565 repair — mark the advance credit inside payments recorded BEFORE migration
-- 20261018044814_r1565_credit_applied_not_cash. DRY RUN BY DEFAULT.
--
-- Before that migration record_desk_payment (and, earlier, the record-payment sheet) saved
-- amount = cash + credit and wrote the credit part only into notes, as
-- "Advance credit applied ₹N". Those rows still read credit_applied = 0, so Collected,
-- GSTR-1 11A, Day Book, Tally and bank matching keep counting that credit as new money.
--
-- This finds them by that note and sets credit_applied = least(N, amount). amount is never
-- changed, so no invoice / quote balance moves.
--
--   DRY RUN (default — lists every row and the totals, then ROLLS BACK):
--     psql "<db>" -v ON_ERROR_STOP=1 -f supabase/maintenance/r1565-credit-applied-repair.sql
--   APPLY (only after the owner has read the dry run):
--     psql "<db>" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/maintenance/r1565-credit-applied-repair.sql
--
-- Needs the migration first (payments.credit_applied). Safe to run twice: rows already
-- marked (credit_applied > 0) are skipped. Writes nothing else.
--
-- Note: any GSTR-1 already FILED for a month with such a row reported that credit in 11A a
-- second time; this repair changes what the app shows for that month now, not the filed
-- return — the CA decides whether to adjust it in a later return.

\if :{?apply}
\else
  \set apply 0
\endif

begin;

create temp table r1565_fix on commit drop as
select p.id, p.tenant_id, t.name as company, p.quote_id, p.customer_id, p.amount,
       (p.received_at at time zone 'Asia/Kolkata')::date as received_on,
       least(p.amount, (regexp_match(p.notes, 'Advance credit applied ₹([0-9]+)'))[1]::int) as credit
  from public.payments p
  join public.tenants t on t.id = p.tenant_id
 where p.credit_applied = 0
   and p.notes ~ 'Advance credit applied ₹[0-9]+';

-- Every row it would change.
select company, quote_id, received_on, amount, credit as credit_applied, amount - credit as cash_received, id
  from r1565_fix
 order by company, received_on, quote_id;

-- Per company and month: how much "Collected" / 11A falls by.
select company, to_char(received_on, 'YYYY-MM') as month, count(*) as payments,
       sum(amount) as was_counted, sum(credit) as credit_not_cash, sum(amount - credit) as cash_received
  from r1565_fix
 group by company, to_char(received_on, 'YYYY-MM')
 order by company, month;

update public.payments p
   set credit_applied = f.credit
  from r1565_fix f
 where p.id = f.id and p.credit_applied = 0;

\if :apply
  commit;
  \echo 'R-1565 repair APPLIED.'
\else
  rollback;
  \echo 'R-1565 repair DRY RUN — nothing written. Re-run with -v apply=1 to apply.'
\endif
