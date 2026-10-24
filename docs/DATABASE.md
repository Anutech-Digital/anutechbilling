# ResellerOS database map

A map of the Postgres schema for a new session: which tables exist, how the money tables connect,
which rules guard them, and how to change the schema safely. Written 19 Oct 2026 (R-1665) from
[`production/supabase/baseline.sql`](../production/supabase/baseline.sql) plus the 307 timestamped files in
[`production/supabase/migrations/`](../production/supabase/migrations/) (newest: `20261019013050_r1006_export_log.sql`).

Counts and lists here are a snapshot. **Code is truth** ([AGENTS.md §12](../AGENTS.md)): before you
rely on a column, read the newest migration that touches it (`grep -l <table> production/supabase/migrations/*.sql`).

Related: [ARCHITECTURE.md](ARCHITECTURE.md) (the whole system), [API.md](API.md) (routes),
[ADR 0001](adr/0001-database-on-cloud-sql.md) (Cloud SQL), [ADR 0003](adr/0003-books-lock.md) (books lock).

---

## 1. Where the database is

- **Live:** Cloud SQL `resellersos-db` (PostgreSQL 17, `asia-southeast1`). **Staging:** Cloud SQL
  `resellersos-staging-db`, a wiped clone of live (`production/docs/STAGING.md`). Agents never read or
  write either one; the manager runs the deploy-db scripts (section 7).
- The app reaches it two ways (ADR 0001, `production/db/ops/README.md`):
  - the **Supabase data plane** (PostgREST + GoTrue + Storage on a VM) through `supabase-js`; or
  - the **in-process data gateway** (`src/server/postgrest/`, Prisma + `pg` as role `app_runtime`) when
    `DATA_GATEWAY=1`. Each transaction sets `app.user_id` / `app.tenant_id`
    (`src/server/db/index.ts`, `src/server/db/gateway.ts`), so the same RLS policies apply.
- **Locally:** `npm run setup` / `npm run db:local` builds a database from `baseline.sql` + migrations
  (`production/README.md`). Never build one from `supabase/migrations-archive/`.

Everything lives in schema `public` (plus `auth` / `storage` from the Supabase platform, and a
`backup` schema for snapshots).

---

## 2. Table groups

About 92 tables come from `baseline.sql` and about 105 more from migrations (about 197 in all;
no table has been dropped since the baseline). Every tenant table has `tenant_id`.

### Platform and access
| Table | Purpose |
|---|---|
| `tenants` | One row per reseller company: legal identity, GSTIN, `doc_code`, `books_locked_until`, settings. |
| `users` | A staff login inside one tenant: `tenant_id`, `role`, `is_active`. RLS reads the tenant from here. |
| `team_invites`, `join_requests`, `tenant_domains` | Inviting staff; a signup from a verified company email domain waits in `join_requests` for the owner. |
| `tenant_secrets` | Per-tenant integration secrets (Razorpay, WhatsApp). Server-only. |
| `api_keys` | Hashed keys for the public `/api/v1` API, with scopes. |
| `user_google_tokens` | A user's Google OAuth tokens (secret columns, section 5). |
| `email_verifications`, `employee_pin_attempts`, `expense_claim_pin_attempts`, `presence_code_attempts` | Sign-up and PIN/code verification and their rate limits. |
| `activity_log` | Audit trail of row changes and actions. |
| `export_log` | Every data export (R-1006, newest migration). |
| `demo_tenants`, `demo_data_switch` | "Try the demo" workspace; `demo_data_switch` allows demo invoices on staging/local only. |
| `schema_one_off_fixes` | Marker rows for one-off data repairs that must not run twice. |

### Sales and CRM (leads)
| Table | Purpose |
|---|---|
| `leads`, `lead_activities` | The sales pipeline and its timeline (calls, notes, stage moves). |
| `contacts`, `customer_contacts`, `contact_greeting_log`, `google_contact_links` | People, their link to customers, greetings sent, Google Contacts sync. |
| `inbound_emails` | Emails read from the sales inbox (Gmail cron / inbound webhook) and turned into leads. |
| `indiamart_lead_imports`, `indiamart_sync_state` | IndiaMART lead pull. |
| `lead_finder_profiles`, `lead_finder_runs`, `lead_finder_candidates` | AI Lead Finder. |
| `ai_sales_conversations`, `ai_sales_loops`, `ai_telecall_logs`, `ai_draft_feedback`, `ai_action_log`, `ai_autonomy` | AI sales agent: conversations, follow-up loops, calls, and the autonomy switches + log. |
| `assessments`, `assessment_attempts` | Customer/lead assessments behind a token link. |

### Billing and subscriptions (Abhishek's area, AGENTS.md §13)
| Table | Purpose |
|---|---|
| `customers`, `customer_groups`, `customer_number_seq`, `customer_users` | Billed customers, parent-account groups, customer numbers, customer logins (portal-era). |
| `items`, `packages`, `package_items` | The catalogue (`msrp`, `wholesale` in whole rupees) and bundles. |
| `quotes`, `quote_send_log`, `quote_views`, `quote_signatures` | Quotes, when they were sent, viewed and signed. |
| `subscriptions`, `subscription_billings`, `contract_amendments` | What the customer has; instalment ("split") billing rows; append-only log of term changes. |
| `seat_requests`, `seat_increase_claims` | Customer seat requests; idempotency for "add seats". |
| `invoices`, `credit_notes`, `debit_notes`, `cancelled_vouchers` | GST documents. A deleted payment's voucher number stays in `cancelled_vouchers` so the series never has a gap. |
| `payments`, `customer_credits`, `payment_mandates`, `payment_followups` | Money received, advance/overpayment credit, UPI/e-NACH mandates, collection follow-ups. |
| `invoice_dunning_log`, `invoice_write_off_drafts`, `late_charge_bills`, `late_fee_audit`, `late_fee_overrides` | Chasing overdue invoices, write-offs, late fees. |
| `renewal_email_log` | Renewal reminders sent. |
| `document_series` | Per-tenant, per-FY document counters used by `next_document_number()`. |
| `coupons`, `coupon_redemptions`, `site_promos` | Discounts on the shop and buy pages. |
| `project_sales`, `project_milestones`, `project_payments`, `project_tasks`, `project_labour` | One-off project sales and their billing. |

### Online orders, hosting and domains
| Table | Purpose |
|---|---|
| `provisioning_requests` | Queue of paid hosting/domain jobs the DMS crons work through. Its "facts" are immutable once written. |
| `provisioning_tasks` | Manual setup tasks after a sale. |
| `customer_domains` | Domains tied to a customer. |

### Accounting and compliance (Pardeep's area)
| Table | Purpose |
|---|---|
| `bank_accounts`, `bank_transactions`, `txn_category_rules`, `bank_aa_connections` | Company bank accounts, statement lines and their reconciliation, auto-category rules, Account Aggregator links. |
| `expenses`, `vendors`, `vendor_bills`, `purchase_orders`, `po_bill_allocations`, `inbound_purchases` | Spend side: expenses, vendors, bills, POs, purchases parsed from emails. |
| `payment_runs`, `payment_run_items` | Batches of vendor payments (draft → approved → paid). The app never moves money. |
| `tds_receivable`, `tax_payments`, `statutory_dues_payments`, `compliance_log`, `compliance_reminder_log` | TDS deducted by customers, tax and statutory payments, filing log and reminders. |
| `prepaid_advances`, `fixed_assets`, `balance_sheet_items`, `opening_balances`, `month_close_checks` | Prepaids, assets and depreciation, manual balance-sheet lines, opening capital, month-close checklist. |
| `business_loans`, `business_loan_payments`, `emi_purchases`, `emi_payments`, `loans_given`, `loan_repayments` | Loans taken and given, EMIs. |
| `referral_partners`, `referral_agreements`, `referral_commissions` | Partner commissions. |
| `mrr_snapshots` | Monthly MRR per customer (cron). |
| `personal_accounts`, `personal_holdings`, `personal_transactions`, `personal_vault_pin` | The owner's own money, kept apart from company books on purpose. |

There is **no journal table**. The ledger, P&L, Balance Sheet, Trial Balance and Day Book are
derived from the source tables by SQL functions (`report_pnl`, `report_balance_sheet`, …, see
`20261007290000_tb_customer_balances.sql`) and by `production/src/lib/accounting/` (e.g. `ledger.ts`).

### HR, payroll, attendance
| Table | Purpose |
|---|---|
| `employees`, `employee_documents`, `employee_assets` | Staff records (`employees.pin_hash` is secret). |
| `salary_payments`, `reimbursements`, `expense_claims`, `employee_loans`, `employee_loan_repayments` | Payroll and money to/from staff. |
| `attendance`, `attendance_settings`, `attendance_corrections`, `attendance_devices`, `attendance_webauthn_challenges`, `attendance_reminder_log`, `leave_entries`, `holidays` | Punch-in/out, office settings (secret seed and device key), device login, leave. |
| `academy_*` (8 tables) | Apprentice Academy: programs, modules, tasks, submissions, evaluations, skills. |

### Support, tasks, vault, documents
| Table | Purpose |
|---|---|
| `support_tickets`, `support_ticket_notes`, `support_ticket_ratings`, `support_ticket_time_logs`, `support_canned_responses`, `support_call_requests`, `support_plans`, `support_sync_outbox`, `ai_support_conversations` | Helpdesk. |
| `tasks`, `task_comments`, `task_collaborators`, `task_kudos` | Internal tasks. |
| `vault_passwords`, `vault_access_log`, `access_credentials` | Encrypted customer console logins (ciphertext columns server-only) and who opened them; a register of which credentials exist (never values). |
| `documents` | Uploaded files (Storage objects). |

### Marketing and messaging
| Table | Purpose |
|---|---|
| `campaigns`, `campaign_templates`, `campaign_sends`, `marketing_campaigns`, `marketing_tools`, `tracking_links` | Email campaigns, marketing tool state, UTM links. |
| `ad_accounts`, `ad_spend_daily`, `ad_sync_runs` | Google/Meta Ads spend (`ad_accounts.access_token` is secret). |
| `gbp_locations`, `gbp_metrics_daily`, `gbp_reviews`, `gbp_sync_runs`, `review_requests` | Google Business Profile. |
| `whatsapp_messages`, `whatsapp_templates`, `whatsapp_broadcasts`, `whatsapp_opt_outs`, `whatsapp_reminder_*` (3) | WhatsApp Cloud API messages, templates, reminders. |
| `email_log`, `customer_email_sends`, `email_suppressions` | Outgoing email log and bounce/unsubscribe list. |
| `notifications`, `push_subscriptions` | In-app and web-push notifications. |

### Product quality and internal tools
`feedback`, `feedback_votes`, `feedback_screenshots` (Report-a-bug), `ux_events`, `ux_insights`,
`ux_analysis_runs`, `ui_page_scores`, `page_test_runs` (UX/UI agents), `automation_jobs` (per-tenant
on/off/dry-run switch and last result of each cron job).

---

## 3. Key relationships (the money spine)

```
tenants ─┬─ users (staff, role)
         ├─ leads ──(quotes.lead_id)──┐
         └─ customers ─┬─ quotes ─────┴─┬─ subscriptions (quote_id, renewal_quote_id)
                       │                ├─ payments (quote_id, customer_id)
                       │                └─ invoices (quote_id) ── credit_notes / debit_notes (invoice_id)
                       ├─ customer_credits
                       └─ project_sales ── project_milestones ── project_payments
```

Foreign keys behind it (from `baseline.sql`): `quotes.customer_id`, `quotes.lead_id`,
`quotes.invoice_id`; `subscriptions.customer_id`, `.quote_id`, `.renewal_quote_id`;
`invoices.customer_id`, `.quote_id`; `payments.customer_id`, `.quote_id`, `.bank_account_id`;
`credit_notes.invoice_id`, `debit_notes.invoice_id`; `subscription_billings` (migrations) links an
instalment to its subscription and invoice.

Flow: lead → quote → `accept_quote` → payment via `record_payment` (converts the lead to a
customer, creates/rolls forward the subscription, credits overpayment — all in one transaction) →
`generate_invoice` (GST split frozen at issue) → renewal quote → `record_payment` again
([production/CLAUDE.md §17b](../production/CLAUDE.md)). Instalment billing: `raise_subscription_billing`.
Refunds: `refund_payment`. Bank matching: `reconcile_bank_txn`.

`items.id` is a bare primary key, so a plain FK to it could point at another tenant's row; tables
that reference items use a composite FK on `(tenant_id, id)` (AGENTS.md §4, migration `0248`).

---

## 4. Money rules

- **Whole rupees, integers.** Every money column is rupees, never paise. `rupee(490644)` →
  `₹4,90,644`. Paise appear only inside a calculation to round once. — [AGENTS.md §1](../AGENTS.md),
  [production/CLAUDE.md §13](../production/CLAUDE.md).
- **GST:** SaaS rate 18% (CGST 9% + SGST 9% intra-state, IGST 18% inter-state), HSN 998313 by
  default — [production/CLAUDE.md §13](../production/CLAUDE.md). The place-of-supply state comes from the
  customer's GSTIN/state (`20261007200000_invoice_state_from_gstin.sql`).
- **Document numbers** only from `next_document_number(doc_type)`: per tenant, per Indian FY, no
  gaps, inside the same transaction as the insert. Never in JS. — [production/CLAUDE.md §17a](../production/CLAUDE.md), [AGENTS.md §5](../AGENTS.md).
- **Multi-row money writes are one SECURITY DEFINER function**, never chained client calls —
  [production/CLAUDE.md §17b](../production/CLAUDE.md).
- **Tenant guards in those functions fail closed** (a NULL `current_tenant_id()` is refused unless
  the caller is trusted) — [production/CLAUDE.md §17c](../production/CLAUDE.md), test `supabase/tests/tenant_guard_fail_closed.test.sql`.
- **Issued invoices are immutable.** Triggers `trg_invoices_freeze_issued`
  (`20260823090000_freeze_issued_invoice_particulars.sql`, updated `20261001170000_invoice_party_snapshot.sql`),
  `trg_invoices_block_delete_issued` (`20260930171000`) and `trg_invoice_fx_freeze` (`20261007251000`).
  Correct one with a credit/debit note. Test: `supabase/tests/issued_invoice_is_immutable.test.sql`.
- **Books lock.** `tenants.books_locked_until`; trigger `trg_books_lock` (`tg_books_locked`) on every
  money table blocks insert/update/delete dated on or before it, for `anon`/`authenticated` callers
  (also through RPCs). A new money table must be added to the trigger list. —
  [ADR 0003](adr/0003-books-lock.md), migrations `20260927120000_books_lock.sql`, `20261018195438_r1584_books_lock_more_tables.sql`.
- **A failure is never turned into a plausible number** — [AGENTS.md §2](../AGENTS.md).

---

## 5. Tenancy, RLS and grants

- Every tenant table has `tenant_id uuid not null` and RLS on. Policies use
  `public.current_tenant_id()` — never inline `(select tenant_id from users …)`. — [AGENTS.md §4](../AGENTS.md),
  [production/CLAUDE.md §4](../production/CLAUDE.md).
- **`service_role` has no BYPASSRLS on Cloud SQL**, so every table needs a permissive
  `to service_role using (true)` policy, or crons and webhooks lose access (ADR 0001;
  `production/supabase/cloudsql/10-service-role-policy-functions.sql`; test `src/lib/security/service-role-policies.test.ts`).
- **Grants follow the policies.** [`cloudsql/09-grant-what-policies-allow.sql`](../production/supabase/cloudsql/09-grant-what-policies-allow.sql)
  grants `authenticated`/`anon` exactly the commands their policies cover. It is re-run on every
  deploy-db step. A table with no grant is unreadable however correct its policies are.
- **Secret columns (R-833, R-840).** Never readable by a browser role:
  `attendance_settings.presence_secret`, `.ingest_key`, `employees.pin_hash`,
  `ad_accounts.access_token`, `user_google_tokens.access_token/refresh_token/sync_token`,
  `email_verifications.token_hash`, `vault_passwords.*_ciphertext`. Their tables get column grants,
  never table-level SELECT. A new secret column goes in `secret_cols` in file 09 **and** in
  `SECRET_COLUMNS` in `src/lib/security/secret-columns.test.ts`.
- **Column-granted tables (R-1559, R-1622).** `payment_followups` has table-level SELECT/DELETE but
  INSERT/UPDATE only on a column list (`created_by`, `created_at`, `tenant_id`, `customer_id` are not
  writable). Listed in `colgrant_tables` in file 09. Tests: `supabase/tests/secret_columns_hidden.test.sql`,
  `r840_vault_ciphertext_hidden.test.sql`, `r1559_followup_columns_login_grants.test.sql`.
- Function grants: Cloud SQL gives no PUBLIC EXECUTE (`src/lib/security/invoker-function-grants.test.ts`);
  SECURITY DEFINER hardening is checked by `src/lib/security/definer-hardening-holds.test.ts`.
- Check grants with `pg_class.relacl` / `pg_proc.proacl`, not `information_schema` (AGENTS.md §5).

---

## 6. Changing the schema

1. **Never change a database without a migration file in git** (AGENTS.md §5).
2. Create it: `cd production && npm run migration:new -- <name>` → `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`
   (`scripts/new-migration.mjs`). The timestamp must be newer than every migration on every remote
   branch (root `CLAUDE.md`), then run `node scripts/migration-order-check.mjs --base origin/main`
   (also in CI): it fails on a bad name, a duplicate version, an edited/renamed shipped migration, or
   a file older than the base's newest.
3. **Add the deploy headers** in the leading comment block (the template does not):
   ```sql
   -- deploy-peek: exists(select 1 from pg_proc where proname='my_fn' and pronamespace='public'::regnamespace)
   -- deploy-key: myfn          (optional)
   -- deploy-user: postgres     (optional; default resellersos_migration)
   ```
   `deploy-peek` is a SQL boolean that is true once the file is applied. Use `to_regclass` /
   `to_regprocedure` / catalog queries; never `::regclass` (it throws before the object exists).
4. Write for Cloud SQL: no `extensions.` schema, never reference `auth.users`; write `auth.uid()` /
   `auth.role()` — the staging deploy script rewrites them ([production/CLAUDE.md §17c](../production/CLAUDE.md)).
   New table: `tenant_id`, RLS, policies on `current_tenant_id()`, the service_role policy, and the
   books-lock trigger if it holds money.
5. Regenerate DB types in the same commit: `node scripts/check-db-types.mjs --write` (needs the local
   stack; `production/README.md`).
6. Add the migration to the day's deploy-db scripts: `node scripts/ops/gen-deploy-db.mjs --date <day>`
   (`--check` to verify). It rewrites only the `MIGS=(…)` block of
   `supabase/cloudsql/staging/deploy-db-<day>.sh` and `supabase/cloudsql/live/deploy-db-<day>.sh`.
   Those scripts back up (live), peek, apply the missing files, re-run grants 09 + 10, reload the
   PostgREST schema and peek again. **The manager runs them, not an agent.**

Notes:
- `production/prisma/` holds the generated `schema.prisma` and the data-gateway migrations
  (`prisma/migrations/*/migration.sql`). The `staging` branch moves applied migrations there, and the
  deploy-db scripts look in both places (R-545). `production/db/ops/README.md` says
  `supabase/migrations/` is frozen; on `manager-pardeep` new files are still added there (19 Oct 2026),
  so follow what the branch you are on does and ask the manager if unsure.
- Applying DDL by hand: small batches, never a verification `SELECT` in the same run (AGENTS.md §5).

---

## 7. SQL tests

- 227 files in [`production/supabase/tests/`](../production/supabase/tests/). Each is wrapped in
  `begin; … rollback;` and fails with `raise exception`.
- Run: `cd production && npm run test:sql:local` (local docker Supabase) or
  `npm run test:sql:local -- <name-filter>`. `scripts/test-sql.mjs` refuses any file without
  `rollback` or with `commit`, and runs a canary that must fail first.
- The default `npm run test:sql` uses the Supabase CLI `--linked` project, which is no longer
  production since the Cloud SQL move (ADR 0001) — know which database you reached.
- CI: `.github/workflows/sql-tests.yml` rebuilds a local database and runs the suite.
- Proving a DDL fix: pipe `begin; <migration without begin/commit> <test> rollback;` into the local
  database; mutation-check by putting the old body back — it must go red (production/CLAUDE.md §17c,
  AGENTS.md L24).
- Writing a test: own your fixtures (AGENTS.md L11), read ids before `set role authenticated` (L14),
  and give a zero-row isolation assertion a precondition that something could leak (L7).
