-- R-2223 (31 Oct 2026): proves the invoice-date repair in supabase/cloudsql/live/r2223-invoice-dates
-- on the LOCAL DB, in ONE transaction that is rolled back. The blocks between ">>> rows.sql" and
-- "<<< rows.sql" (and apply-body.sql) are exact copies of those files —
-- tests/r2223-invoice-date-repair-files.test.ts fails if they drift.
--
-- Invoices raised before R-2095 were dated the day they were SAVED. Scenarios (tenant R223):
--   X  cross-month: receipt 20 Apr 2026, invoice saved + dated 30 Oct    -> 20 Apr, due 20 May, paid 20 Apr
--   S  same month, wrong day: receipt 13 Oct, invoice saved + dated 30 Oct -> 13 Oct, due 12 Nov (paid stays 13 Oct)
--   M  multi-part (SILCARB shape): dated its 1st receipt 29 Jul, 2nd receipt 31 Jul, saved 31 Oct -> untouched
--   P  invoiced before it was paid: dated + saved 29 Oct, receipt 30 Oct     -> untouched
--   L  books locked to 30 Jun (tenant R22L): receipt 10 May, dated 30 Oct    -> skip_books_locked, untouched
--   D  dated BY HAND 15 Oct (not its save day 30 Oct), receipt 10 Oct      -> untouched (the person chose it)
-- RED before the repair (the rule still finds X and S), GREEN after, and a second run finds nothing.

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000222301','R2223 Date Co','r2223d@example.in','07','R223'),
  ('dddddddd-0000-0000-0000-000000222302','R2223 Lock Co','r2223l@example.in','07','R22L');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000222301','dddddddd-0000-0000-0000-000000222301','Acme R2223','07','acme2223.in'),
  ('cccccccc-0000-0000-0000-000000222302','dddddddd-0000-0000-0000-000000222302','Lock R2223','07','lock2223.in');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status) values
  ('TESTQ-R2223-X','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223',11800,10000,18,'accepted'),
  ('TESTQ-R2223-S','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223', 5900, 5000,18,'accepted'),
  ('TESTQ-R2223-M','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223', 2360, 2000,18,'accepted'),
  ('TESTQ-R2223-P','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223', 1180, 1000,18,'accepted'),
  ('TESTQ-R2223-D','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223', 1180, 1000,18,'accepted'),
  ('TESTQ-R2223-L','dddddddd-0000-0000-0000-000000222302','cccccccc-0000-0000-0000-000000222302','Lock R2223', 1180, 1000,18,'accepted');
insert into public.payments (tenant_id, quote_id, customer_id, amount, method, status, received_at, created_at, receipt_voucher_no) values
  ('dddddddd-0000-0000-0000-000000222301','TESTQ-R2223-X','cccccccc-0000-0000-0000-000000222301',11800,'bank_transfer','received','2026-04-20 00:00+00','2026-10-30 03:30+00','RV-R223-X'),
  ('dddddddd-0000-0000-0000-000000222301','TESTQ-R2223-S','cccccccc-0000-0000-0000-000000222301', 5900,'bank_transfer','received','2026-10-13 00:00+00','2026-10-30 03:40+00','RV-R223-S'),
  ('dddddddd-0000-0000-0000-000000222301','TESTQ-R2223-M','cccccccc-0000-0000-0000-000000222301', 2000,'bank_transfer','received','2026-07-29 00:00+00','2026-10-31 04:18+00','RV-R223-M1'),
  ('dddddddd-0000-0000-0000-000000222301','TESTQ-R2223-M','cccccccc-0000-0000-0000-000000222301',  360,'bank_transfer','received','2026-07-31 00:00+00','2026-10-31 04:19+00','RV-R223-M2'),
  ('dddddddd-0000-0000-0000-000000222301','TESTQ-R2223-P','cccccccc-0000-0000-0000-000000222301', 1180,'bank_transfer','received','2026-10-30 00:00+00','2026-10-30 05:00+00','RV-R223-P'),
  ('dddddddd-0000-0000-0000-000000222301','TESTQ-R2223-D','cccccccc-0000-0000-0000-000000222301', 1180,'bank_transfer','received','2026-10-10 00:00+00','2026-10-30 04:10+00','RV-R223-D'),
  ('dddddddd-0000-0000-0000-000000222302','TESTQ-R2223-L','cccccccc-0000-0000-0000-000000222302', 1180,'bank_transfer','received','2026-05-10 00:00+00','2026-10-30 03:50+00','RV-R22L-L');
-- What generate_invoice wrote before R-2095: invoice_date = due_date - 30 = paid_date = the IST save day.
insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, amount, taxable_value, tax_amount, tax_rate,
                             inter_state, status, invoice_date, due_date, paid_date, created_at, document_kind) values
  ('INV-R223-X','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223','TESTQ-R2223-X',11800,10000,1800,18,false,'paid','2026-10-30','2026-11-29','2026-10-30','2026-10-30 03:30+00','tax_invoice'),
  ('INV-R223-S','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223','TESTQ-R2223-S', 5900, 5000, 900,18,false,'paid','2026-10-30','2026-11-29','2026-10-13','2026-10-30 03:40+00','tax_invoice'),
  ('INV-R223-M','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223','TESTQ-R2223-M', 2360, 2000, 360,18,false,'paid','2026-07-29','2026-08-28','2026-07-29','2026-10-31 04:18+00','tax_invoice'),
  ('INV-R223-P','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223','TESTQ-R2223-P', 1180, 1000, 180,18,false,'paid','2026-10-29','2026-11-28','2026-10-30','2026-10-29 04:00+00','tax_invoice'),
  ('INV-R223-D','dddddddd-0000-0000-0000-000000222301','cccccccc-0000-0000-0000-000000222301','Acme R2223','TESTQ-R2223-D', 1180, 1000, 180,18,false,'paid','2026-10-15','2026-11-14','2026-10-15','2026-10-30 04:10+00','tax_invoice'),
  ('INV-R22L-L','dddddddd-0000-0000-0000-000000222302','cccccccc-0000-0000-0000-000000222302','Lock R2223','TESTQ-R2223-L', 1180, 1000, 180,18,false,'paid','2026-10-30','2026-11-29','2026-10-30','2026-10-30 03:50+00','tax_invoice');
update public.tenants set books_locked_until = '2026-06-30' where id = 'dddddddd-0000-0000-0000-000000222302';

create temp view r2223_live as
-- >>> rows.sql
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
-- <<< rows.sql
;

-- RED: before the repair the rule finds X and S (and L, which it must skip) in these tenants.
do $$
declare v text;
begin
  select string_agg(invoice_no || ':' || action || ':' || new_invoice_date, ',' order by invoice_no) into v
    from r2223_live where tenant_id in ('dddddddd-0000-0000-0000-000000222301','dddddddd-0000-0000-0000-000000222302');
  if v is distinct from 'INV-R223-S:repair:2026-10-13,INV-R223-X:repair:2026-04-20,INV-R22L-L:skip_books_locked:2026-05-10' then
    raise exception 'R-2223 RED FAIL: the rule should find exactly X, S (repair) and L (locked) before the repair, found %', v;
  end if;
end $$;

create temp table r2223_rows on commit drop as select * from r2223_live;
-- >>> apply-body.sql
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
-- <<< apply-body.sql

-- GREEN: X and S moved with their due/paid dates; M, P, D, L untouched; one log line each; undo record.
do $$
declare v text; n int;
begin
  select string_agg(id || '=' || invoice_date || '/' || due_date || '/' || coalesce(paid_date::text, '-'), ',' order by id) into v
    from public.invoices where id in ('INV-R223-X','INV-R223-S','INV-R223-M','INV-R223-P','INV-R223-D','INV-R22L-L');
  if v is distinct from 'INV-R223-D=2026-10-15/2026-11-14/2026-10-15,INV-R223-M=2026-07-29/2026-08-28/2026-07-29,INV-R223-P=2026-10-29/2026-11-28/2026-10-30,'
                     || 'INV-R223-S=2026-10-13/2026-11-12/2026-10-13,INV-R223-X=2026-04-20/2026-05-20/2026-04-20,'
                     || 'INV-R22L-L=2026-10-30/2026-11-29/2026-10-30' then
    raise exception 'R-2223 GREEN FAIL: dates after the repair: %', v;
  end if;

  select count(*) into n from public.activity_log
   where entity = 'invoices' and entity_id in ('INV-R223-X','INV-R223-S')
     and label in ('R-2223 repair: invoice date 30 Oct 2026 → 20 Apr 2026, receipt RV-R223-X',
                   'R-2223 repair: invoice date 30 Oct 2026 → 13 Oct 2026, receipt RV-R223-S');
  if n <> 2 then raise exception 'R-2223 GREEN FAIL: % activity-log lines for X and S (want 2)', n; end if;
  select count(*) into n from public.activity_log where entity_id in ('INV-R223-M','INV-R223-P','INV-R223-D','INV-R22L-L');
  if n <> 0 then raise exception 'R-2223 GREEN FAIL: % activity-log lines for untouched invoices', n; end if;

  select count(*) into n from public.r2223_invoice_date_repair
   where invoice_id in ('INV-R223-X','INV-R223-S') and old_invoice_date = '2026-10-30';
  if n <> 2 then raise exception 'R-2223 GREEN FAIL: undo record has % of X, S (want 2)', n; end if;

  -- Re-run: the rule finds nothing left to move (idempotent); L still waits for the owner.
  select count(*) into n from r2223_live where action = 'repair';
  if n <> 0 then raise exception 'R-2223 GREEN FAIL: % invoices still to move after the repair', n; end if;
end $$;

select 'R-2223 invoice-date repair: RED before, GREEN after, re-run finds nothing — ALL PASS' as result;

rollback;
