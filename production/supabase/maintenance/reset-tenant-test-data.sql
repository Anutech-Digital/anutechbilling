-- ═══════════════════════════════════════════════════════════════════════════
--  RESET TENANT DATA FOR TESTING  ·  Anutech Digital
--  tenant_id = fbb976f1-9090-4f10-9726-0901bd144e42
--  Written 13 Aug 2026 · reviewed against measured production row counts
-- ═══════════════════════════════════════════════════════════════════════════
--
--  READ THIS BEFORE RUNNING ANYTHING.
--
--  ─── HOW TO RUN (CLAUDE.md §25.6 — learned the slow way) ──────────────────
--  Run ONE BATCH AT A TIME. Do not paste this whole file.
--  The Supabase SQL editor runs a pasted script as ONE transaction, so if any
--  later statement fails, EVERYTHING rolls back — including the deletes that
--  succeeded — and the screen shows an error nobody connects to "nothing
--  happened".
--
--  BATCH 6 (verification) MUST be a SEPARATE run. Run inside the same
--  transaction it would read uncommitted state and report success for work
--  that is about to disappear.
--
--  ─── BATCH 0 IS NOT OPTIONAL ──────────────────────────────────────────────
--  This project is on the Supabase free plan: no automatic backups, no PITR
--  (docs/BACKUP.md). Nothing here is recoverable without a dump. And because
--  the plan is to re-enter the data by hand, the dump is also the REFERENCE
--  SHEET you will re-type from — real bank narrations, salary figures and
--  expense notes that cannot be reconstructed from memory.
--
--      cd "C:/dev/ResellerOSv3 - Copy/production"
--      node scripts/backup-tenant-data.mjs "C:/Users/mso50/ResellerOS-backups/2026-08-13"
--
--  Then open manifest.json and confirm the row counts. Do not continue until
--  you have.  (scripts/backup-db.mjs goes through the Supabase MCP server,
--  which returned Unauthorized on 13 Aug 2026 — use the script above instead.)
--
--  ─── WHAT IS DUMMY AND WHAT IS NOT (measured, not assumed) ────────────────
--  DUMMY — the sales spine. GSTINs are keyboard mash ("098ETKG;E0[R9TIP",
--  "[409IKG4P9GIERWG9"), emails are "rohit@1234gmail.com", one customer is
--  literally "ROHINI TEST HOUSE", and 46 of 53 invoices were created in the
--  two days before this file was written.
--
--  REAL — the accounting, bank and payroll side. bank_transactions carry
--  genuine HDFC statement narrations ("50100784857182-TPT-EMP MAY SALARY-
--  HITESH BABU"), expenses include a real Amazon order number, salary_payments
--  cover 2026-04 and 2026-05 for staff who are also real users of this tenant,
--  and balance_sheet_items holds Owner's capital ₹60,000 plus real loan entries.
--  28 of 39 bank lines are RECONCILED — a person did that matching by hand.
--
--  Batches 3 and 4 delete that REAL data. They are separated out for exactly
--  that reason. Payroll records also carry statutory weight (TDS on salary,
--  Form 16, EPFO). Skip those two batches unless you genuinely intend it.
--
--  ─── NEVER DELETED BY THIS FILE ───────────────────────────────────────────
--  tenants · users · api_keys · tenant_secrets · user_google_tokens ·
--  team_invites · bank_accounts · vendors · items · support_plans ·
--  holidays · attendance_settings · documents
--
--  Those are identity, credentials and catalog — not "entries". Deleting
--  `users` would lock 8 real logins out; deleting `documents` would orphan the
--  GST PDF and company logo already in Supabase Storage (the storage objects
--  are NOT removed by deleting the row, and vice versa).
--
--  ─── OTHER TENANTS ────────────────────────────────────────────────────────
--  Every statement is scoped by tenant_id. The other four tenants
--  (Democo, Gammaco, Demo Co, Anutech) are untouched.
--
--  ─── TIMING ───────────────────────────────────────────────────────────────
--  Six Cloud Scheduler jobs hit this database. The earliest is
--  attendance-retention at 02:00 IST, then renewals at 09:00 IST. Running
--  outside those minutes avoids a cron reading half-deleted state.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
--  BATCH 1 · SALES SPINE  (all dummy — this is the batch you actually want)
--  Children first, so foreign keys never block and no orphans survive.
--
--  Row counts as measured 13 Aug 2026: 52 payments · 53 invoices ·
--  54 subscriptions · 52 quotes · 62 leads · 51 customers · 57 contacts ·
--  61 purchase orders. THOSE NUMBERS GO STALE THE MOMENT ANYONE ADDS A ROW.
--  The authority is manifest.json from the Batch 0 backup you just took —
--  compare against that, not against this comment. The DELETEs themselves are
--  count-independent (scoped by tenant_id), so a changed count does not make
--  them wrong; it only means this comment is out of date.
-- ───────────────────────────────────────────────────────────────────────────
begin;

delete from public.tds_receivable    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.prepaid_advances  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customer_credits  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.credit_notes      where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.debit_notes       where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.payments          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.invoices          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.subscriptions     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.quote_send_log    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.quotes            where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.renewal_email_log where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

-- Purchase side: allocations link POs to bills, so they go first.
delete from public.po_bill_allocations where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.vendor_bills        where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.inbound_purchases   where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.purchase_orders     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

-- CRM. lead_activities before leads; customers before customer_groups
-- (customers carry the group reference, not the other way round).
delete from public.lead_activities   where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.leads             where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.contact_greeting_log where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.google_contact_links where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.contacts          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customer_domains  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customer_users    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customers         where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.customer_groups   where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

commit;


-- ───────────────────────────────────────────────────────────────────────────
--  BATCH 2 · PROJECTS · SUPPORT · TASKS  (test data)
--  As measured 13 Aug 2026: 38 project_tasks · 12 support_tickets · 10 tasks ·
--  9 inbound_emails. Same caveat as Batch 1 — verify against manifest.json.
-- ───────────────────────────────────────────────────────────────────────────
begin;

delete from public.project_tasks      where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.project_milestones where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.project_labour     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.project_payments   where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.project_sales      where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.support_sync_outbox where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.support_tickets     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.assessment_attempts where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.assessments         where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

delete from public.tasks              where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.inbound_emails     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.whatsapp_messages  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.campaign_sends     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.campaigns          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

commit;


-- ───────────────────────────────────────────────────────────────────────────
--  ⚠ BATCH 3 · ACCOUNTING & BANK  —  THIS DATA IS REAL
--
--  bank_transactions holds 39 imported HDFC statement lines, 28 of them
--  hand-reconciled. expenses holds 34 real entries including a real Amazon
--  order number and ₹1,10,000 of salary. balance_sheet_items holds Owner's
--  capital ₹60,000 and two real loan entries.
--
--  Re-entering these means re-importing the bank statement AND redoing 28
--  manual matches. bank_accounts (HDFC + Petty Cash) is NOT deleted, but its
--  computed balance will read zero until transactions are re-imported.
--
--  SKIP THIS BATCH unless you are certain.
-- ───────────────────────────────────────────────────────────────────────────
begin;

delete from public.bank_transactions       where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.expenses                where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.expense_claims          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.balance_sheet_items     where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.statutory_dues_payments where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.business_loan_payments  where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.business_loans          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.emi_payments            where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.emi_purchases           where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

commit;


-- ───────────────────────────────────────────────────────────────────────────
--  ⚠ BATCH 4 · HR & PAYROLL  —  THIS DATA IS REAL AND STATUTORY
--
--  22 salary payments covering 2026-04 and 2026-05, for staff who are also
--  real users of this tenant (ABHISHEK, RANJEET RAJ, HITESH BABU, PAWAN).
--  Payroll records back TDS-on-salary deposits, Form 16 issuance and EPFO
--  filings. Re-typing them from memory risks wrong figures on a statutory
--  return. `employees` (the 10 staff master records) is deleted LAST and only
--  if you uncomment it — attendance and salary reference it.
--
--  SKIP THIS BATCH unless you are certain.
-- ───────────────────────────────────────────────────────────────────────────
begin;

delete from public.employee_loan_repayments where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.employee_loans           where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.reimbursements           where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.leave_entries            where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.attendance               where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.salary_payments          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.employee_documents       where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

-- Staff master records. Uncomment ONLY if you are re-creating all 10 employees.
-- delete from public.employees             where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

commit;


-- ───────────────────────────────────────────────────────────────────────────
--  BATCH 5 · DOCUMENT COUNTERS + AUDIT TRAIL
--
--  Counters are RESET, not deleted, so next_document_number() keeps its row
--  lock and per-fiscal-year behaviour intact (CLAUDE.md §17a). After this the
--  next invoice is INV-2026-27-0001 again.
--
--  Current values for this tenant: invoice 68 · quote 82 · receipt_voucher 70
--  · purchase_order 85 · customer_number_seq 86. Resetting these is only safe
--  because the documents they numbered were dummy — no real customer holds a
--  copy of INV-2026-27-0012.
-- ───────────────────────────────────────────────────────────────────────────
begin;

update public.document_series
   set last_number = 0, updated_at = now()
 where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

update public.customer_number_seq
   set last_number = 0
 where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

-- 634 rows. This is the audit trail of the dummy data — nothing above it
-- survives, so keeping it would only produce activity entries pointing at
-- records that no longer exist.
delete from public.activity_log            where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.compliance_log          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
delete from public.compliance_reminder_log where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

commit;


-- ═══════════════════════════════════════════════════════════════════════════
--  BATCH 6 · VERIFY  —  RUN THIS IN A SEPARATE EDITOR RUN
--
--  Run inside the same transaction as the deletes, this would read uncommitted
--  state and report success for work that is about to roll back. That mistake
--  cost five attempts on an earlier migration. Separate run, always.
--
--  Every `remaining` must be 0 for the batches you ran.
--  `kept` must still show your logins, catalog and credentials.
-- ═══════════════════════════════════════════════════════════════════════════
/*
select 'customers'     as t, count(*) as remaining from public.customers        where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'leads',         count(*) from public.leads                    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'quotes',        count(*) from public.quotes                   where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'invoices',      count(*) from public.invoices                 where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'payments',      count(*) from public.payments                 where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'subscriptions', count(*) from public.subscriptions            where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'contacts',      count(*) from public.contacts                 where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'purchase_ord',  count(*) from public.purchase_orders          where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'activity_log',  count(*) from public.activity_log             where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select '-- KEPT --',    null
union all select 'users (keep)',  count(*) from public.users                    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'items (keep)',  count(*) from public.items                    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'bank_acc(keep)',count(*) from public.bank_accounts            where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'secrets (keep)',count(*) from public.tenant_secrets           where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select '-- COUNTERS --', null
union all select 'doc_series max', max(last_number) from public.document_series where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select '-- OTHER TENANTS (must be unchanged) --', null
union all select 'other customers', count(*) from public.customers             where tenant_id <> 'fbb976f1-9090-4f10-9726-0901bd144e42'
union all select 'other invoices',  count(*) from public.invoices              where tenant_id <> 'fbb976f1-9090-4f10-9726-0901bd144e42';
*/
