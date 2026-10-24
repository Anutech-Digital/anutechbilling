-- R-1561 repair — instalment invoices raised with the money already received subtracted TWICE.
--
-- DRY-RUN BY DEFAULT. Run as is: it lists every affected invoice (id, old due, new due)
-- and ROLLS BACK — nothing changes.
--     psql ... -f supabase/maintenance/r1561-instalment-due-repair.sql
-- Apply ONLY after Pardeep's yes on card R-1561 (manager's deploy step, after the
-- 20261018030414_r1561_instalment_due_once migration is on that database):
--     psql ... -v apply=1 -f supabase/maintenance/r1561-instalment-due-repair.sql
--
-- WHAT WAS STORED WRONG
--   raise_subscription_billing wrote net_payable = greatest(0, amount − credit) AND
--   paid_amount = credit. Readers compute due = net_payable − paid_amount, so the credit
--   came off twice. The fix (migration above) writes net_payable = amount; this brings the
--   rows already raised to the same convention:  net_payable := amount.
--
-- WHICH ROWS (all three must hold — anything else is listed for a human, never changed)
--   · the invoice is an instalment invoice (subscription_billings.invoice_id points at it);
--   · paid_amount > 0 and net_payable = greatest(0, amount − paid_amount), i.e. exactly the
--     shape the old insert wrote — a credit/debit note since then would have moved
--     net_payable, and such a row is reported under "manual check" instead;
--   · status is not 'void'.
--   A 'paid' row is fixed too (its due stays 0 — status 'paid' short-circuits every
--   reader), so every instalment invoice ends on one convention.
--
-- Only net_payable changes. amount, paid_amount, status, paid_date, GST fields untouched.

\set ON_ERROR_STOP on

begin;

create temp table r1561_rows on commit drop as
select i.id, i.tenant_id, i.customer_name, i.status::text as status, i.amount,
       i.net_payable, i.paid_amount,
       case when i.status::text in ('paid', 'void') then 0
            else greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0)) end as old_due,
       case when i.status::text in ('paid', 'void') then 0
            else greatest(0, i.amount - coalesce(i.paid_amount, 0)) end as new_due,
       (i.net_payable = greatest(0, i.amount - i.paid_amount)) as exact_old_shape
  from public.invoices i
  join public.subscription_billings b on b.invoice_id = i.id
 where i.status::text <> 'void'
   and coalesce(i.paid_amount, 0) > 0
   and i.net_payable is not null
   and i.net_payable < i.amount;

\echo '== R-1561: instalment invoices to fix (net_payable -> amount) =='
select id, tenant_id, customer_name, status, amount, net_payable as old_net_payable,
       paid_amount, old_due, new_due, new_due - old_due as more_to_collect
  from r1561_rows where exact_old_shape
 order by tenant_id, id;

select count(*) as invoices_to_fix,
       count(*) filter (where new_due <> old_due) as with_due_change,
       coalesce(sum(new_due - old_due), 0) as total_more_to_collect
  from r1561_rows where exact_old_shape;

\echo '== Manual check (net_payable moved since issue, e.g. a credit note) — NOT changed =='
select id, tenant_id, customer_name, status, amount, net_payable, paid_amount, old_due
  from r1561_rows where not exact_old_shape
 order by tenant_id, id;

\if :{?apply}
  update public.invoices i
     set net_payable = i.amount,
         updated_at  = now()
    from r1561_rows r
   where r.id = i.id and r.exact_old_shape;
  \echo '== APPLIED — committing =='
  commit;
\else
  \echo '== DRY RUN — nothing changed (pass -v apply=1 to apply) =='
  rollback;
\endif
