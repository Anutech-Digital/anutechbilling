-- R-2223 (31 Oct 2026) — THE RULE: which invoices the repair moves, and to which date.
-- One pure SELECT (no semicolon: run.sh and the SQL test wrap it). It changes nothing.
--
-- Before R-2095 (commit 67d9d3dd4, migration 20261030054246_r2095_invoice_date_receipt.sql)
-- generate_invoice dated every invoice ist_today() — the SAVE day (20261027110130 line 205–217),
-- so an invoice raised on 30 Oct for money received on 20 Apr says 30 Oct. R-2095 dates it
--   invoice_date_for_receipt(tenant, max(IST day of payments.received_at)
--                                     over the quote's payments with status 'received'),
-- i.e. the LATEST receipt that existed when the invoice was raised, clamped to "not after today"
-- and "not inside locked books". This SELECT applies that same rule to the old invoices:
--
--   its receipt = the latest IST receipt day among the quote's 'received' payments — exactly
--                 R-2095's expression (and the 31 Oct audit's). Staging has 2 invoices
--                 (INV-A378-27-0089, INV-A378-27-0090) where Generate invoice was pressed ~40 s
--                 BEFORE the bank receipt of 30 Sep / 3 Oct was recorded: the money was in the
--                 bank first, so they move too (column recorded_after_invoice shows them). If
--                 any receipt of the quote is on/after the invoice date, the latest receipt is
--                 not earlier and the invoice is left alone (issued before it was paid = right).
--   candidate   = a generate_invoice invoice (quote_id set; not a subscription part, not a
--                 project milestone, not opening/imported, not void) that is dated its own
--                 save day (invoice_date = IST day of created_at — the pre-fix signature; an
--                 invoice R-2095 dated right, e.g. INV-A378-27-0354 dated its first receipt
--                 29 Jul, is not dated its save day) and whose receipt is EARLIER than that.
--   new date    = the receipt day; new due = new date + the same terms it had
--                 (old due − old date, normally the quote's 30 days); paid_date moves with it
--                 only when it was written as the save day too (generate_invoice set both).
--
-- action: repair            — will be moved;
--         skip_books_locked — the new date is on/before the tenant's books lock (CLAUDE.md: a
--                             locked month is never written into) — owner unlocks or leaves it;
--         skip_fy_change    — the receipt is in an earlier financial year than the invoice
--                             number (the number's FY would be wrong) — needs CN + re-issue;
--         skip_irn          — an e-invoice IRN exists (the IRP holds the old date) — CN route;
--         skip_partner_locked — the partner's mirrored purchase bill sits in locked books.
select i.tenant_id,
       t.name                                   as tenant_name,
       i.id                                     as invoice_no,
       i.customer_name,
       i.status::text                           as status,
       coalesce(i.taxable_value, 0)             as taxable,
       coalesce(i.tax_amount, 0)                as gst,
       i.amount,
       i.created_at,
       i.invoice_date                           as old_invoice_date,
       x.rcv                                    as new_invoice_date,
       i.due_date                               as old_due_date,
       x.rcv + (i.due_date - i.invoice_date)    as new_due_date,
       i.paid_date                              as old_paid_date,
       case when i.paid_date = i.invoice_date then x.rcv else i.paid_date end as new_paid_date,
       date_trunc('month', i.invoice_date) <> date_trunc('month', x.rcv)      as month_changed,
       x.rv                                     as receipt_rv,
       x.pay_id                                 as receipt_payment_id,
       x.pay_created > i.created_at             as recorded_after_invoice,
       vb.id                                    as partner_bill_id,
       vb.tenant_id                             as partner_tenant_id,
       vb.bill_date                             as partner_old_bill_date,
       vb.due_date                              as partner_old_due_date,
       case
         when t.books_locked_until is not null and x.rcv <= t.books_locked_until then 'skip_books_locked'
         when extract(year from x.rcv - interval '3 months')
              <> extract(year from i.invoice_date - interval '3 months')           then 'skip_fy_change'
         when nullif(btrim(coalesce(i.gst_irn, '')), '') is not null               then 'skip_irn'
         when vb.id is not null and pt.books_locked_until is not null
              and least(vb.bill_date, x.rcv) <= pt.books_locked_until              then 'skip_partner_locked'
         else 'repair'
       end                                      as action
  from public.invoices i
  join public.tenants t on t.id = i.tenant_id
  cross join lateral (
    select (p.received_at at time zone 'Asia/Kolkata')::date as rcv,
           p.receipt_voucher_no as rv, p.id as pay_id, p.created_at as pay_created
      from public.payments p
     where p.quote_id = i.quote_id and p.tenant_id = i.tenant_id
       and p.status = 'received'
     order by p.received_at desc, p.created_at desc
     limit 1
  ) x
  left join public.vendor_bills vb
         on vb.source_tenant_invoice_id = i.id and vb.bill_date = i.invoice_date
  left join public.tenants pt on pt.id = vb.tenant_id
 where i.quote_id is not null
   and coalesce(i.document_kind, 'tax_invoice') in ('tax_invoice', 'bill_of_supply')
   and i.opening_balance is null
   and i.import_batch_id is null
   and i.status::text <> 'void'
   and not exists (select 1 from public.subscription_billings b where b.invoice_id = i.id)
   and not exists (select 1 from public.project_milestones m where m.invoice_id = i.id)
   and i.invoice_date = (i.created_at at time zone 'Asia/Kolkata')::date
   and x.rcv < i.invoice_date
