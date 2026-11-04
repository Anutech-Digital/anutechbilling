-- R-2223 (31 Oct 2026) — THE REPAIR. Runs inside run.sh's transaction, right after
--   create temp view r2223_live as <rows.sql>;
--   create temp table r2223_rows on commit drop as select * from r2223_live;
-- One transaction: any error (including the verification at the end) and NOTHING is saved.
-- Re-runnable: after a run the rule finds no invoice to move, so a second run changes nothing.
--
-- What moves, per invoice the rule marks 'repair' (only those — skip_* rows are left alone):
--   invoices.invoice_date  old save day      -> its receipt's IST day
--   invoices.due_date      old date + terms  -> new date + the same terms
--   invoices.paid_date     only where it was written as the save day -> the receipt day
--   vendor_bills (a partner's mirrored purchase bill, source_tenant_invoice_id) bill_date /
--                          due_date that still equal the invoice's old dates (0 on staging)
--   activity_log           one row per invoice, "R-2223 repair: invoice date … → …, receipt RV-…"
--   r2223_invoice_date_repair  undo record: every old and new value (undo.sql reads it)
-- Everything else that shows an invoice's date (P&L, P&L by month, day book, party ledger /
-- customer statement, balance sheet, GSTR-1 / sales register, receivables ageing, overdue
-- badge, PDF) reads invoices.invoice_date / due_date live, so it follows by itself.
--
-- Guards it passes, and how:
--   trg_invoices_freeze_issued / trg_invoice_fx_freeze — the repo's own escape hatch for a
--     reviewed maintenance script: `set local app.invoice_amend_reason` (transaction-scoped,
--     the reason is logged as a NOTICE beside every change). No app path sets it.
--   trg_books_lock — does not fire for a direct DB session (no request role); the rule itself
--     refuses any date on/before books_locked_until (action skip_books_locked), so a locked
--     month is still never written into.

set local app.invoice_amend_reason = 'R-2223 repair (Pardeep, option a): invoice raised before R-2095 was dated its save day; moved to its receipt date';

create table if not exists public.r2223_invoice_date_repair (
  invoice_id            text primary key,
  tenant_id             uuid not null,
  receipt_rv            text,
  receipt_payment_id    uuid,
  old_invoice_date      date not null,
  new_invoice_date      date not null,
  old_due_date          date,
  new_due_date          date,
  old_paid_date         date,
  new_paid_date         date,
  month_changed         boolean not null,
  partner_bill_id       text,
  partner_old_bill_date date,
  partner_old_due_date  date,
  repaired_at           timestamptz not null default now()
);
alter table public.r2223_invoice_date_repair enable row level security;
revoke all on public.r2223_invoice_date_repair from anon, authenticated;

insert into public.r2223_invoice_date_repair (
  invoice_id, tenant_id, receipt_rv, receipt_payment_id, old_invoice_date, new_invoice_date,
  old_due_date, new_due_date, old_paid_date, new_paid_date, month_changed,
  partner_bill_id, partner_old_bill_date, partner_old_due_date)
select r.invoice_no, r.tenant_id, r.receipt_rv, r.receipt_payment_id, r.old_invoice_date, r.new_invoice_date,
       r.old_due_date, r.new_due_date, r.old_paid_date, r.new_paid_date, r.month_changed,
       r.partner_bill_id, r.partner_old_bill_date, r.partner_old_due_date
  from r2223_rows r
 where r.action = 'repair'
on conflict (invoice_id) do nothing;

update public.vendor_bills vb
   set bill_date = r.new_invoice_date,
       due_date  = case when vb.due_date = r.old_due_date then r.new_due_date else vb.due_date end
  from r2223_rows r
 where r.action = 'repair'
   and vb.id = r.partner_bill_id
   and vb.bill_date = r.old_invoice_date;

update public.invoices i
   set invoice_date = r.new_invoice_date,
       due_date     = r.new_due_date,
       paid_date    = r.new_paid_date
  from r2223_rows r
 where r.action = 'repair'
   and i.id = r.invoice_no
   and i.tenant_id = r.tenant_id
   and i.invoice_date = r.old_invoice_date;

insert into public.activity_log (tenant_id, user_id, actor_label, action, entity, entity_id, label, changes)
select r.tenant_id, null, 'R-2223 data repair', 'update', 'invoices', r.invoice_no,
       left('R-2223 repair: invoice date ' || to_char(r.old_invoice_date, 'DD Mon YYYY') || ' → '
            || to_char(r.new_invoice_date, 'DD Mon YYYY') || ', receipt '
            || coalesce(r.receipt_rv, r.receipt_payment_id::text), 120),
       jsonb_strip_nulls(jsonb_build_object(
         'invoice_date', jsonb_build_object('old', r.old_invoice_date, 'new', r.new_invoice_date),
         'due_date',     jsonb_build_object('old', r.old_due_date,     'new', r.new_due_date),
         'paid_date',    case when r.new_paid_date is distinct from r.old_paid_date
                              then jsonb_build_object('old', r.old_paid_date, 'new', r.new_paid_date) end,
         'partner_bill', r.partner_bill_id,
         'reason',       'R-2223: raised before R-2095 and dated its save day; dated its receipt instead (Pardeep, option a)'))
  from r2223_rows r
 where r.action = 'repair';

-- Verification: every invoice marked 'repair' now holds its new dates, and the rule finds
-- nothing left to move. Anything else -> exception -> the whole transaction is undone.
do $verify$
declare
  v_moved   int;
  v_wrong   int;
  v_left    int;
  v_logged  int;
  v_cross   int;
  v_skipped int;
begin
  select count(*) into v_moved from r2223_rows where action = 'repair';
  select count(*) into v_cross from r2223_rows where action = 'repair' and month_changed;
  select count(*) into v_skipped from r2223_rows where action <> 'repair';
  select count(*) into v_wrong
    from r2223_rows r join public.invoices i on i.id = r.invoice_no
   where r.action = 'repair'
     and (i.invoice_date <> r.new_invoice_date
          or i.due_date  is distinct from r.new_due_date
          or i.paid_date is distinct from r.new_paid_date);
  select count(*) into v_left from r2223_live where action = 'repair';
  select count(*) into v_logged
    from public.activity_log a join r2223_rows r on r.invoice_no = a.entity_id and r.tenant_id = a.tenant_id
   where r.action = 'repair' and a.entity = 'invoices' and a.actor_label = 'R-2223 data repair'
     and a.created_at = now();
  if v_wrong > 0 or v_left > 0 or v_logged <> v_moved then
    raise exception 'R-2223 VERIFY FAILED — nothing saved: % not moved, % still to move, % of % logged',
      v_wrong, v_left, v_logged, v_moved;
  end if;
  raise notice 'R-2223 DONE: % invoices moved to their receipt date (% into an earlier month), % skipped',
    v_moved, v_cross, v_skipped;
end
$verify$;
