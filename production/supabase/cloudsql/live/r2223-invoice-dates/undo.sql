-- R-2223 UNDO — puts back every date the repair changed, from its undo record
-- (public.r2223_invoice_date_repair). Only rows that still hold the repaired date are touched,
-- so an invoice changed again by hand afterwards is left alone. One transaction.
-- Run: run.sh <staging|live> undo
begin;
set local app.invoice_amend_reason = 'R-2223 undo: back to the dates before the R-2223 repair';

update public.vendor_bills vb
   set bill_date = u.partner_old_bill_date,
       due_date  = case when vb.due_date = u.new_due_date then u.partner_old_due_date else vb.due_date end
  from public.r2223_invoice_date_repair u
 where vb.id = u.partner_bill_id
   and vb.bill_date = u.new_invoice_date;

update public.invoices i
   set invoice_date = u.old_invoice_date,
       due_date     = u.old_due_date,
       paid_date    = u.old_paid_date
  from public.r2223_invoice_date_repair u
 where i.id = u.invoice_id
   and i.tenant_id = u.tenant_id
   and i.invoice_date = u.new_invoice_date;

insert into public.activity_log (tenant_id, user_id, actor_label, action, entity, entity_id, label, changes)
select u.tenant_id, null, 'R-2223 data repair', 'update', 'invoices', u.invoice_id,
       left('R-2223 undo: invoice date ' || to_char(u.new_invoice_date, 'DD Mon YYYY') || ' → '
            || to_char(u.old_invoice_date, 'DD Mon YYYY'), 120),
       jsonb_build_object('invoice_date', jsonb_build_object('old', u.new_invoice_date, 'new', u.old_invoice_date),
                          'reason', 'R-2223 undo')
  from public.r2223_invoice_date_repair u
  join public.invoices i on i.id = u.invoice_id and i.invoice_date = u.old_invoice_date;

drop table public.r2223_invoice_date_repair;
commit;
