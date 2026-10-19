# ResellerOS V3 — Project Knowledge Base

> ## ⚠️ STALE — this document's audit stopped at migration `0050`
>
> **Do not quote counts, module lists, or bug status from this file without checking the code first.**
>
> | | This doc says | Reality (verified 2026-08-12) |
> |---|---|---|
> | Migrations | 27 files (`0001`–`0017`, `0040`–`0050`) | **196 files, `0001` → `0225`** |
> | Scope | "17 shipped modules" | ~10 further domains shipped since: payroll (PF/ESI/salary register), attendance (biometric/face/selfie/geofence), project sales, compliance calendar (GST/ROC/IT), assessments + proctoring, documents vault, referral commissions, credit/debit notes, business loans + EMI, vendors master, customer credits, backups/restore points, public `/api/v1` + API keys, vendor portal |
>
> **Claims in here that are now WRONG — these are the ones that will actually mislead you:**
> - **§5.1 "Known caveats: (1) No idempotency — the biggest spine risk"** → **FIXED** in `0051` (partial unique index `payments_idempotency_uq` + RPC early-guard). Reads like an open P0; it is not.
> - **§14 "⚠️ LIVE SCHEMA DRIFT … Action item: generate a catch-up migration"** → **DONE** in `0146_capture_schema_drift_critical.sql`.
> - **§5.8 "`generate_invoice` is a client-side multi-step engine … verify in code"** → it is now an atomic `SECURITY DEFINER` RPC (`0058`).
> - **§14 "Audit logs (`audit_log` table planned)"** → shipped as `0222_activity_log.sql`.
> - The §5.1 / §5.2 / §5.8 RPC inventory is missing everything from `0051` onward, including `record_payment_with_tds` (`0150`), `create_direct_invoice` (`0158`), `issue_credit_note` / `issue_debit_note` (`0154`/`0155`), and the deny-by-default EXECUTE lockdown (`0145`).
>
> **Spot-checked and still accurate:** `refund_payment` RPC is still not built · portal invoice PDF is still a 503 stub (`api/portal/invoice/[id]/pdf/route.ts:27`) · the rupee-vs-paise unit ambiguity (§4, §14) is still unresolved.
>
> **What to trust instead:**
> - **Money-spine bug status** → `docs/MONEY-FLOW-TEST-MATRIX.md` §2.1 (revised 2026-06-01, verified against live DB).
> - **Live status / current work** → the team board (https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n, collection `cards`) — see root `CLAUDE.md`. `TASKS.md` stopped being updated on 8 Sep 2026 and is stamped stale (R-1609).
> - **Schema truth** → `production/supabase/migrations/` itself, and the live DB. Nothing else.
>
> Sections 1–3 (product vision, architecture pattern, the multi-tenancy model) and 11–13 (pricing models, design tokens, infra) have aged well and are still the best orientation in the repo. Sections 4–8 and 14–15 (data model, RPC inventory, module status, file index) are the stale ones.
>
> *Boundary of this warning: I verified the counts, the four wrong claims, and the three still-accurate ones directly. I did **not** re-audit migrations `0051`–`0225`, so treat any other detail below as unconfirmed rather than correct.*
>
> ---
>
> The definitive engineering reference for ResellerOS V3, synthesized from 12 deep-research reports covering schema, RPCs, query layer, UI, infra, and product docs. Inline file paths are cited throughout. Where a report did not examine something, it is marked **"not examined"**. Several documented internal inconsistencies are preserved honestly rather than smoothed over.
>
> Repository root: `C:\dev\ResellerOSv3` · App lives under `C:\dev\ResellerOSv3\production\` · Migrations under `production/supabase/migrations/`.

---

## 1. Overview & Product Vision

**What:** ResellerOS is a **multi-tenant operating system for Indian cloud resellers** selling Google Workspace, Microsoft 365, and Zoho. It replaces the 5–7 disconnected tools a reseller juggles today (CRM spreadsheet, Tally, Zoho Books, WhatsApp, Gmail, bank-statement paperwork, Razorpay dashboard, GST return prep) with one cohesive layer.

**The operating loop (core flow):** Lead inbound → Qualify → GST-compliant Quote → Send (email/WhatsApp/PDF) → Accept (with/without payment) → Customer auto-created + Subscription seeded → Invoice (CGST §31) → Razorpay collect → Receipt voucher → Renewal cadence → Auto-suspend with grace → Bank reconciliation → Accounting/GST prep → TDS receivable cycle → Form 26AS reconcile.

**Who for (personas / RBAC via `users.role`):**
- **Owner** (Pardeep @ Client A) — full access, billing, partner channel.
- **Sales rep** — owned leads/deals/quotes; read-only customers; no delete, no CSV import, no campaigns.
- **Support/Ops** — customers + subscriptions + invoices.
- **Accountant/Finance** — invoices, payments, TDS, banking, GST reports.
- **Customer portal user** (the reseller's own customers) — magic-link login, own data only.

Note: code-level `user_role` enum is `owner | sales | accountant | support` (migration `0001`), while `lib/nav.ts` uses `owner | manager | sales` for navigation gating. These two role vocabularies are not perfectly unified.

**Business model:** SaaS subscription (Model B below). Currently **0 paying tenants**; target 10 in 90 days, 100 in 12 months. North-star = paying tenants × average MRR. Beta is free for the first 10 resellers OR until 2026-09-01; beta tenants get grandfathered 50% off for 12 months.

**Owner / live tenants:** Owner is **Client A** (Pardeep, `Pardeep@example.test`), distributor tier, dogfooding. Second live tenant **Anutech Digital**, reseller tier (partner). `BUY_PAGE_TENANT_ID` defaults to `8ff50dbf-e17e-4210-a580-0df7b1a6f71b` (Client A) across all public APIs — the storefront is single-tenant for v1.

**V3 vs V2:** V3 diverged substantially from the archived V2 plan (`docs/archive/LEADOS-RESELLER-CRM-V2-PRD.md`): renamed LeadOS V2 → ResellerOS; single-product → GW+M365+Zoho; single-agency → multi-tenant RLS; Firestore/Firebase → Supabase Postgres + Cloud Run; Algolia → Postgres queries; 6 modules → 17 shipped modules; added customer portal, public buy pages, partner channel, banking. Current state: the code and the team board. `RESELLEROS-PRD-V3.md` and `PROJECT_TRACKER.md` (both 2026-05-29) are history only — stamped STALE on 19 Oct 2026 (R-1609).

---

## 2. Tech Stack & Architecture

- **Framework:** Next.js 14 App Router (`output: "standalone"`, `reactStrictMode`, `experimental.typedRoutes`, `instrumentationHook: true`) — `production/next.config.mjs`.
- **DB / Auth / Storage:** Supabase Postgres (project ref `ontpnqjoysjgrlsukecm`), with Row-Level Security + `SECURITY DEFINER` RPCs for cross-table atomic writes. Auth = Supabase Auth (email/password + Google OAuth for resellers; magic-link OTP for customer portal).
- **Client data layer:** TanStack Query throughout `production/src/lib/queries/` (22 modules). Root query keys are entity names; mutations invalidate roots + cross-entity keys.
- **Styling:** Tailwind with HSL design tokens (warm "paper/ink" palette, amber accent). `sonner` toasts. shadcn/ui primitives.
- **Server actions / APIs:** Next.js route handlers under `production/src/app/api/` + cron handlers.
- **Money flow spine:** the `record_payment()` Postgres RPC (see §5) collapses ~7–9 client mutations into one atomic transaction.
- **Two Supabase client flavors** (`production/src/lib/supabase/`): `client.ts` (browser), `server.ts` (RSC/route/action, also exports `createAdminClient()` = service-role), `middleware.ts` (`updateSession()`).

**Architecture pattern:**
1. **Reads** rely entirely on Postgres RLS — query code carries NO `.eq("tenant_id", …)`.
2. **Writes** derive `tenant_id` in JS via `auth.getUser()` → `select tenant_id from users where id = auth.uid()` (inlined in most query modules; `items.ts` factors a `currentTenantId()` helper). Server components/actions can use `lib/tenant.ts` (`getCurrentUser()`/`getCurrentTenantId()`, `import "server-only"`), but client query modules re-implement the lookup.
3. **Multi-row atomicity** (payments, invoice generation, document numbering, coupon redemption, partner sync, site promos) goes through `SECURITY DEFINER` RPCs.

---

## 3. Multi-Tenancy & Security Model

**Isolation key — `public.current_tenant_id()`** (`SECURITY DEFINER`): `SELECT tenant_id FROM users WHERE id = auth.uid()`. RLS is enabled on **every** table.

**Standard 4-policy CRUD shape** (applied to `customers`, `items`, `leads`, `quotes`, `subscriptions`, `tasks`, and the accounting/banking tables):
- `*_select` (SELECT, authenticated): `USING tenant_id = current_tenant_id()`
- `*_insert` (INSERT): `WITH CHECK tenant_id = current_tenant_id()`
- `*_update` (UPDATE): `USING + WITH CHECK tenant_id = current_tenant_id()`
- `*_delete` (DELETE): `USING tenant_id = current_tenant_id()`

**Deviations:**
- `tenants`: SELECT only where `id = current_tenant_id()`; UPDATE additionally requires `role = 'owner'` (`tenants_self_update`). No authenticated INSERT/DELETE (tenant created by service role at signup).
- `users`: `users_tenant_read` (see teammates), `users_self_update` (`id = auth.uid()`), `users_owner_manage` (FOR ALL, owner-only).
- `invoices`: select/insert/update only — **no DELETE policy** (legal records; void, never delete).
- `payments`: select/insert/update only — **no DELETE** (financial records; refund via status). Adds `payments_service_role_all`. Migration `0003` hardened these from `{public}` to `{authenticated}` and replaced `auth.role()` with `TO service_role`.
- `document_series`: SELECT only for authenticated; counters mutate **only** via the SECURITY DEFINER RPC. Plus `document_series_service_role`.
- Cron/webhook tables (`renewal_email_log`, `quote_send_log`) add `TO service_role` ALL policies.
- `bank_aa_connections` (0050) uses an inline subquery `tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid())` rather than the `current_tenant_id()` helper — a minor inconsistency vs the other banking tables.

**Customer-side RLS (portal — migration 0016):** `public.current_customer_id()` (`SECURITY DEFINER`) returns the `customer_id` for `auth_user_id = auth.uid()`. Customer-side SELECT policies are retrofitted onto `customers`, `quotes`, `invoices`, `payments`, `subscriptions`, `tenants`, and two-sided onto `support_tickets`.

**Service-role mode:** `record_payment` and webhooks detect `auth.role() = 'service_role'`, skip the tenant lookup, and derive tenant from the data (the quote). The cross-tenant guard is gated on `not v_is_service_role` (service role already bypasses RLS).

**There is no DB-level signup trigger** — the `public.users` row is created by the application signup flow.

**Known multi-tenant verification gap:** Playwright cross-tenant isolation tests (TC-1008/1009) are blocked on service-role key rotation (per `docs/TEST-PLAN.md`).

---

## 4. Complete Data Model (by domain, with all status enums)

Money: migration `0001` headers say **integer rupees** ("NOT paise"); some later comments and `CLAUDE.md` say paise; accounting tables clearly store **whole rupees**. The column type everywhere is `integer`. **The canonical internal unit (₹ vs paise) is genuinely ambiguous in the source** — see §14.

### 4.1 Postgres ENUM types (all values, declared order)

| Enum | Values | Defined in |
|---|---|---|
| `user_role` | `owner`, `sales`, `accountant`, `support` | 0001 |
| `vendor` | `google`, `microsoft`, `zoho`, `other` | 0001 |
| `lead_stage` | `new`, `contact`, `demo`, `trial`, `quote`, `won`, `lost` | 0001 |
| `quote_status` | `draft`, `sent`, `viewed`, `accepted`, `rejected`, `expired` | 0001 |
| `invoice_status` | `draft`, `pending`, `paid`, `overdue`, `void` | 0001 |
| `sub_status` | `active`, `paused`, `expired`, `cancelled` | 0001 |
| `payment_status` | `none`, `awaiting`, `partial`, `received`, `invoiced` | 0003 |
| `task_status` | `pending`, `done`, `snoozed`, `cancelled` | 0007 |
| `task_kind` | `call`, `email`, `meeting`, `followup`, `custom` | 0007 |
| `renewal_state` | `pending`, `notice_sent`, `reminder_1`, `reminder_2`, `reminder_3`, `reminder_4`, `final_sent`, `grace_period`, `renewed`, `suspended` | 0008 |

**CHECK-constraint value sets (not Postgres enums):**
- `items.kind` ∈ {`main`, `addon`}
- `payments.method` ∈ {`upi`, `razorpay`, `bank_transfer`, `cheque`, `cash`, `other`}; `payments.status` ∈ {`received`, `refunded`}
- `document_series.doc_type` ∈ {`invoice`, `receipt_voucher`, `refund_voucher`, `credit_note`, `debit_note`, `quote`} (plus `purchase_order` and `campaign` used at runtime by later code)
- `quote_send_log.status` ∈ {`sent`, `stubbed`, `failed`}; `renewal_email_log.status` ∈ {`sent`, `stubbed`, `failed`, `skipped`}
- `tenants.tier` ∈ {`distributor`, `reseller`} (0040)
- `leads.priority` ∈ {`low`, `medium`, `high`} (0046)
- `bank_accounts.account_type` ∈ {`current`, `savings`, `overdraft`, `fixed_deposit`, `other`}
- `bank_transactions.source` ∈ {`manual`, `csv_upload`, `api_fetch`}; `.matched_to_type` ∈ {`payment`, `expense`, `vendor_bill`, `transfer`, `manual`}; `.match_confidence` ∈ {`exact`, `high`, `low`, `manual`}
- `bank_aa_connections.provider` ∈ {`setu`, `finvu`, `onemoney`}; `.status` ∈ {`initiated`, `pending_approval`, `active`, `expired`, `revoked`, `rejected`, `error`}
- `LineCommitment` (TS enum, `database.types.ts`): `monthly`, `annual_monthly`, `annual_quarterly`, `annual_half_yearly`, `annual_yearly`
- App-layer free-text statuses: `tds_receivable.status` defaults `pending_cert` → lifecycle `pending_cert → cert_received → verified_26as → claimed` (+ `disputed`, `written_off`); `support_tickets.status` defaults `open`; `vendor_bills.status` defaults `unpaid`.

### 4.2 Core tenancy & identity (migration 0001, 0040)
- **`tenants`** — root. `id uuid PK`, `name`, `gstin`, `state`, `state_code`, `address`, `email NOT NULL`, `phone`, timestamps. Added later: `grace_period_days smallint DEFAULT 0` CHECK 0–30 (0008); `parent_tenant_id uuid → tenants` (0040); `tier text DEFAULT 'reseller'` (0040). Constraint `tenants_no_self_parent`. View `v_tenant_with_parent` (0040).
- **`users`** — extends `auth.users`. `id uuid PK → auth.users CASCADE`, `tenant_id`, `email`, `full_name`, `initials`, `role user_role DEFAULT sales`, `color DEFAULT 'ink'`, `avatar_url`, `is_active`, `created_at`. Added: `can_view_deals boolean DEFAULT false` (0045).

### 4.3 Sales / CRM
- **`customers`** (0001) — `id uuid PK`, tenant, `name`, `domain`, `gstin`, `state/state_code`, `health smallint DEFAULT 70` CHECK 0–100, contact fields, `account_manager_id → users SET NULL`, `since date`, `notes`. Added: `tan`, `tds_default_section DEFAULT '194J'`, `tds_default_rate_pct DEFAULT 10.00` (0014); `linked_tenant_id uuid → tenants` (0043, for cross-tenant mirror).
- **`leads`** (0001) — `id text PK` (e.g. `L1`, `L-MPI2HG3A`), tenant, `company NOT NULL`, contact fields, `plan`, `seats`, `value`, `stage lead_stage DEFAULT new`, `owner_id → users SET NULL`, `source`, `notes`. Added: `follow_up_date`, `priority text DEFAULT 'medium'`, `gstin` (0046). Trial fields referenced by code (`trial_started_at`, `trial_expires_at`, `trial_converted_at`, `trial_expired_at`) exist in prod but are **not created by any committed migration — schema drift, see §14**.
- **`tasks`** (0007) — `id uuid PK`, tenant, `owner_id`, `title`, `notes`, `kind task_kind DEFAULT followup`, `due_at timestamptz` (UTC, rendered IST), `reminder_minutes_before DEFAULT 60`, `status task_status DEFAULT pending`, polymorphic links (`lead_id`/`quote_id`/`customer_id`/`subscription_id`) with constraint `tasks_one_link_only` (≤1 non-null), `completed_at`/`completed_by` (trigger-stamped), `snooze_count`. Trigger `handle_task_completion()` stamps/clears completion on done.

### 4.4 Catalog
- **`items`** (0001, 0003, 0041) — `id text PK`, tenant, `name`, `vendor`, `hsn DEFAULT '998313'`, `msrp integer`, `wholesale integer`, `margin_pct smallint GENERATED ALWAYS AS ((msrp-wholesale)*100/msrp) STORED`, `is_active`, `kind text DEFAULT 'main'`, `prices jsonb` (per-commitment `{monthly, annual}` each `{msrp, wholesale}`). Partner fields (0041): `is_partner_visible boolean DEFAULT false`, `partner_price integer`, `synced_from_partner_id text`. Constraints `items_partner_price_nonneg`, `items_partner_visible_needs_price`.

### 4.5 Quote → Invoice → Payment → Subscription
- **`quotes`** (0001, 0003, 0011) — `id text PK` (e.g. `Q-2026-0042`), tenant, `customer_id → customers SET NULL`, `customer_name`, `lead_id → leads SET NULL`, `plan`, `seats`, `amount` (annual total ₹), `status quote_status DEFAULT draft`, `owner_id`, `created_date`, `expires_date`, `pdf_url`. 0003 added: `line_items jsonb` (`{id,item_id?,name,qty,rate,cost,commitment}`), `subtotal`, `total_cost`, `discount_pct`, `tax_rate DEFAULT 18`, `notes`, `payment_status payment_status DEFAULT none`, `payment_amount/method/reference/received_at/notes`, `invoice_id text → invoices SET NULL`. 0011 added: `is_renewal boolean DEFAULT false`. Runtime-used columns `domain`, `extension_months`, `is_extension` exist in prod but are **not created by any committed migration — schema drift, see §14**.
- **`invoices`** (0001, 0005) — `id text PK` (e.g. `INV-2026-0089`), tenant, `customer_id SET NULL`, `customer_name`, `amount NOT NULL`, `status invoice_status DEFAULT pending`, `invoice_date`, `due_date`, `paid_date`, `overdue_days`, `razorpay_id`, `gst_irn`, `pdf_url`. 0005 added (CGST Rule 53): `adjusted_advances jsonb DEFAULT '[]'` (frozen `{payment_id,voucher_no,amount,received_at,method}`), `net_payable integer` (= amount − Σ advances, floor 0; CHECK 0 ≤ net_payable ≤ amount), `first_advance_at timestamptz` (30-day GST clock), `quote_id text → quotes SET NULL`. **No DELETE policy.**
- **`payments`** (0003) — `id uuid PK`, tenant, `quote_id text → quotes CASCADE NOT NULL`, `customer_id SET NULL`, `amount integer CHECK > 0`, `method` (6-value check), `reference`, `notes`, `status text DEFAULT 'received'` CHECK ∈ {received,refunded}, `received_at`, `refunded_at`, `refund_reason`, `recorded_by → users SET NULL`, `receipt_voucher_no text` (GST advance RV, unique partial index per tenant). **No DELETE policy.** Append-mostly (no `updated_at` trigger).
- **`subscriptions`** (0001, 0003, 0008, 0017) — `id uuid PK`, tenant, `customer_id`, `customer_name`, `domain`, `plan NOT NULL`, `vendor`, `seats NOT NULL`, `used DEFAULT 0`, `mrr NOT NULL`, `start_date`, `renewal_date`, `status sub_status DEFAULT active`, `is_urgent`. 0003 added: `outstanding_amount integer DEFAULT 0 CHECK >= 0`, `write_off_reason`, `written_off_at`, `last_reminder_at`. 0008 added (renewals): `renewal_state renewal_state DEFAULT pending`, `reminder_count`, `last_reminder_sent_at_v2`, `renewal_quote_id text → quotes SET NULL`, `suspended_at`. 0017 added: `auto_renew boolean DEFAULT true`.

### 4.6 Document numbering
- **`document_series`** (0004) — composite PK `(tenant_id, doc_type, fiscal_year)`, `prefix`, `last_number integer DEFAULT 0 CHECK >= 0`, timestamps. Mutated only via RPC. `fiscal_year` like `'FY2526'`.

### 4.7 Comms / audit
- **`quote_send_log`** (0009) — quote-email audit. `recipient_email`, `cc_emails text[]`, `subject`, `status` (sent/stubbed/failed), `provider_id` (Resend ID), `error_message`, `sent_by`, `sent_at`.
- **`renewal_email_log`** (0008) — append-only renewal-email audit + daily idempotency. `subscription_id`, `cadence_step renewal_state`, `recipient_email`, `subject`, `status` (sent/stubbed/failed/skipped), `provider_id`, `error_message`, `sent_at`.

### 4.8 Accounting / tax (money-out + receivables)
- **`vendor_bills`** (0013) — `id text PK`, tenant, `vendor_name`, `vendor_gstin`, `bill_no`, `bill_date`, `due_date`, `category text DEFAULT 'COGS-Other'`, `line_items jsonb`, `subtotal`, `cgst/sgst/igst`, `total NOT NULL`, `status DEFAULT 'unpaid'`, `paid_amount`, `notes`, `attachment_url`. Added: `source_tenant_invoice_id text` (0043, cross-tenant mirror idempotency).
- **`expenses`** (0013) — `id text PK`, tenant, `category NOT NULL`, `vendor_name`, `expense_date`, `amount`, `gst_paid`, `payment_method`, `description`, `attachment_url`.
- **`tds_receivable`** (0014) — `id text PK`, tenant, `invoice_id/payment_id/customer_id`, `customer_name`, `customer_tan`, `section`, `rate_pct numeric(5,2)`, `gross_amount`, `tds_amount`, `net_paid`, `fiscal_year`, `payment_received_date`, `status DEFAULT 'pending_cert'`, `form_16a_url`, `form_16a_received_date`, `appears_in_26as bool`, `appears_in_26as_date`, `claimed_in_itr bool`, `claimed_in_itr_date`, `notes`. Storage bucket `tds-certificates` (0015, private, 10MB, PDF/JPEG/PNG, tenant-prefixed RLS).

### 4.9 Banking + Account Aggregator
- **`bank_accounts`** (0048) — uuid PK, tenant, `name`, `bank_name`, `account_number_last4` (last-4 only), `ifsc`, `account_type DEFAULT 'current'`, `opening_balance`, `opening_balance_date`, `is_active`, `notes`.
- **`bank_transactions`** (0048) — uuid PK, tenant, `bank_account_id CASCADE`, `txn_date`, `description`, `debit`/`credit` (constraint `debit_xor_credit` — exactly one > 0), `balance_after`, `reference`, `source DEFAULT 'manual'`, reconciliation fields (`matched_to_type`, `matched_to_id text` holds UUID or text id, `matched_at`, `matched_by → auth.users`, `match_confidence`), `imported_at`.
- **`bank_aa_connections`** (0050) — uuid PK, one per Setu/Finvu/OneMoney consent. `provider DEFAULT 'setu'`, `vua NOT NULL`, `consent_handle_id`, `consent_id`, `linked_account_ref`, `status DEFAULT 'initiated'`, `status_reason`, `consent_expires_at`, `fetch_window_from/to`, `last_fetch_*`, `next_fetch_after`, `consent_payload jsonb`, `notes`. Constraint: `unique (bank_account_id, status) DEFERRABLE` (one active per account).

### 4.10 Customer portal
- **`customer_users`** (0016) — uuid PK, tenant, `customer_id CASCADE`, `auth_user_id → auth.users UNIQUE`, `email`, `role DEFAULT 'admin'`, `last_login_at`.
- **`support_tickets`** (0017) — `id text PK`, tenant, `customer_id SET NULL`, `customer_name`, `raised_by_email`, `raised_by_user`, `category`, `priority DEFAULT 'normal'`, `subject`, `body`, `status DEFAULT 'open'`, `resolved_at/by`, `resolution_note`.

### 4.11 FK graph summary
Everything → `tenants(id)` CASCADE. User-attribution FKs → `users(id)` SET NULL. `subscriptions.customer_id` & `tasks.customer_id` → CASCADE; other `customer_id` → SET NULL. `quotes.invoice_id ↔ invoices.quote_id` bidirectional SET NULL. `payments/quote_send_log/tasks.quote_id` → `quotes` CASCADE.

### 4.12 Triggers
- `handle_updated_at()` — on tenants, customers, leads, quotes, invoices, subscriptions, vendor_bills, expenses, tds_receivable, support_tickets. (Not on payments.)
- `handle_task_completion()` (0007).
- `trg_mirror_invoice_to_child` (0043, AFTER INSERT on invoices — see §5).
- `trg_bank_aa_set_updated` (0050).

---

## 5. The `record_payment()` Spine + All RPCs / Triggers

### 5.1 `public.record_payment()` — the money spine
**Signature (stable across migrations 0006/0010/0012/0047; current = 0047):**
```sql
record_payment(p_quote_id text, p_amount integer, p_method text,
               p_reference text, p_notes text default null) returns jsonb
-- language plpgsql, security definer, set search_path = public
```
Collapses ~7–9 client mutations into ONE atomic transaction across quotes/payments/customers/leads/subscriptions/invoices/purchase_orders. `SELECT … FOR UPDATE` on the quote (and renewal subscription) serializes concurrent calls.

**Authorization (0012+):** `v_is_service_role := auth.role() = 'service_role'`. Non-service callers require `current_tenant_id()` (else raise). Service-role callers (Razorpay webhooks, public buy checkout, cron) skip the tenant lookup and the cross-tenant guard; tenant is derived from the quote. `recorded_by = auth.uid()` (NULL for service role — column is nullable).

**Execution order (0047):**
0. Authorize.
1. Validate: `p_amount > 0`; `p_method` in 6-value whitelist; `p_reference` non-blank.
2. Lock + read quote (incl. `domain`, `extension_months`). Cross-tenant guard for non-service callers.
2b. **Renewal detection (0010):** find subscription with `renewal_quote_id = p_quote_id` and `renewal_state <> 'renewed'`, lock it → `v_is_renewal_quote`.
3. Sum prior received payments → `v_is_first_payment := (prior = 0)`.
4. **Lead → customer conversion** (first payment + lead linked + no customer): insert customer (`health = 85` if this payment fully covers expected else `75`; inherit lead domain), promote lead `stage='won'` (stamp `trial_converted_at` if it was a trial). Premise: "service starts at advance receipt, not full payment."
5. **Issue Receipt Voucher** (only if no existing invoice) via `next_document_number('receipt_voucher', tenant)` — CGST §31(3)(d).
6. Insert payment ledger row (`status='received'`).
7. Recompute totals: `total_received`, `outstanding = max(0, expected − total)`, `payment_status` = `invoiced` (if invoice exists) / `received` (fully paid) / `partial`.
8. **Subscription handling:**
   - **8a** first payment + NOT renewal + annual commitment (`monthly` is flex; anything else with non-null commitment = 1-yr) → insert subscription (`mrr = round(expected/12)`, `renewal_date = +1yr`, vendor inferred from plan-name LIKE).
   - **8b** subsequent payment, existing customer, not renewal → update `outstanding_amount` (**best-effort tech debt:** blanket-updates ALL the customer's subs with outstanding > 0; no `subscription.quote_id` FK).
   - **8c** renewal payment fully covered → roll forward: `renewal_date += extension_months`, update seats/plan/mrr (`mrr = round(expected/extension_months)`), `outstanding=0`, clear `renewal_quote_id`, reset reminders, `status='active'`. `renewal_state` flips to `'renewed'` only for ≥12-month extensions.
   - **8d (0047)** auto-create draft `purchase_orders` for new sub OR rolled renewal; wholesale unit cost from `items` (`prices.annual.wholesale` → `wholesale`) else fallback `expected × 0.83 / (seats×months)` (~17% margin).
9. Update quote: payment fields + `customer_id`; **0047 headline:** flip `status → 'accepted'` on full payment (only from draft/sent/viewed) — fixes the Dashboard "Accepted MTD" KPI for Razorpay-paid quotes. Partial payments don't flip.
10. **Invoice auto-paid check** (since 0006): "received since invoice" = `total_received − Σ(frozen adjusted_advances)`; if ≥ `net_payable` → mark invoice `paid`. Advances are FROZEN per CGST Rule 53.
11. Return consolidated jsonb (18 keys in 0047): payment_id, receipt_voucher_no, customer_id, total_received, expected, outstanding, is_first_payment, is_fully_paid, converted_now, subscription_created, invoice_paid, has_existing_invoice, is_renewal_quote, renewal_rolled_forward, extension_months, domain, po_id, po_created, was_trial.

**Migration evolution:** 0006 introduced it (authenticated-only, 12-key return); 0010 added renewal awareness; 0012 added service-role mode (branched off 0006, dropped renewal keys); 0047 merges everything + adds quote-accepted flip, domain propagation, trial tracking, variable-term renewals, auto-PO.

**Known caveats:** (1) **No idempotency** — calling twice with same reference creates two payment rows; the biggest spine risk now that Razorpay webhooks (which retry) can call it. (2) Outstanding attribution is best-effort. (3) Initial health is a guess. (4) Service-role trust. (5) PO wholesale is an estimate.

### 5.2 Document numbering (migration 0004)
- `indian_fiscal_year(date)` — Apr 1→Mar 31; returns e.g. `FY2526`.
- `default_doc_prefix(doc_type)` — invoice→INV, receipt_voucher→RV, refund_voucher→RFV, credit_note→CN, debit_note→DN, quote→Q.
- `format_document_number(prefix, fy, n)` — `{PREFIX}-20{YY1}-{YY2}-{NNNN}`, width 4 (10,000 docs/FY/tenant), e.g. `INV-2025-26-0001`.
- **`next_document_number(p_doc_type, p_tenant_id default null)`** (SECURITY DEFINER) — atomic UPSERT `ON CONFLICT … DO UPDATE SET last_number = last_number + 1 RETURNING` (row-lock = race-safe). Counters reset each Apr 1 (new fiscal_year = new PK row at 1). The single source of all GST document numbers. **Anti-pattern flagged:** `expenses.ts`, `vendor-bills.ts`, `tds-receivable.ts`, contacts/support-ticket creation generate IDs via `Date.now()`/`Math.random()` instead (acceptable since those aren't GST documents, but violates CLAUDE.md §17 in spirit).
- `set_document_series_start(...)` — owner-only escape hatch for migrating tenants.

### 5.3 Advance adjustment (migration 0005)
- `compute_advance_adjustment(p_quote_id)` (STABLE, SECURITY INVOKER) — aggregates received payments into the frozen `adjusted_advances` jsonb + `total_paid` + `first_at`. Consumed by `useGenerateInvoice`.

### 5.4 Renewal roll-forward
Driven by `is_renewal: true` on a quote → `record_payment` step 8c advances `renewal_date` by `extension_months` (12 renewal, N×12 extension). See §7.

### 5.5 Cross-tenant invoice mirror (migration 0043)
`trg_mirror_invoice_to_child` (AFTER INSERT on invoices) → `tg_mirror_invoice_to_child_vendor_bill()` (SECURITY DEFINER): if the invoiced customer has `linked_tenant_id` that is a declared child (`parent_tenant_id = NEW.tenant_id`), insert a mirrored `vendor_bills` row in the child tenant (`id = 'VB-PARTNER-'||NEW.id`, category `cloud_subscriptions`). GST reverse-derived at fixed 18%: `subtotal = round(amount/1.18)`; inter-state → IGST, else CGST/SGST split (remainder to SGST). Idempotent via unique `(tenant_id, source_tenant_invoice_id)`.

### 5.6 Partner RPCs (0040–0044)
- `get_my_tenant_with_parent()` (SECURITY DEFINER) — safe parent join for the caller's own tenant.
- `get_partner_catalog()` — parent's partner-visible items, with `already_synced` flag.
- `sync_partner_item(p_partner_item_id, p_my_msrp, p_link_existing_id)` (0042 3-arg) — link-existing / idempotent re-sync / clone-new; `wholesale = parent.partner_price`.
- `get_partner_metrics()` — privacy-preserving per-child aggregates (active_subscriptions, total_seats_sold, mrr, invoiced_this_month, paid_this_month, renewals_due_30d, renewal_revenue_30d, last_invoice_date).

### 5.7 Banking RPCs (0048/0049)
- `bank_account_current_balance(uuid)` — `opening_balance + Σ(credit − debit)`.
- `suggest_bank_transaction_matches(uuid)` — credits match `payments`, debits match `expenses` (±₹100, ±7 days). 0049 fixed a runtime bug (referenced nonexistent `p.customer_name`; now uses `c.name` + `receipt_voucher_no`).

### 5.8 Other live RPCs
`accept_quote` (public accept page), `redeem_coupon` (atomic), `create_site_promo` (SECURITY DEFINER), `current_customer_id()` (0016). `refund_payment` RPC is **planned, not built**. `generate_invoice` is described as a client-side multi-step engine in `invoices.ts` (uses `compute_advance_adjustment` + `next_document_number`), though product docs call it an RPC — verify in code.

---

## 6. Core Sales Workflow (lead → deal → quote → invoice → payment → subscription)

The cascade, UI + logic (files under `production/src/app/(app)/…`):

1. **Dashboard** (`dashboard/page.tsx`) — 6 KPIs (MRR, Pipeline, Accepted MTD, Customers, Drafts, Renewals·30d). "Today's Focus" prioritized action rows; Recent Activity; Pipeline-by-Stage bars; right rail (leaderboard, renewals, trials-expiring, follow-ups). `PartnerRenewalAlertCard` for distributors.
2. **Leads & Deals** (`leads/page.tsx`; `/deals` re-exports it, switched by `usePathname`) — `/leads` = raw inbox (null/empty plan), `/deals` = qualified (plan set; sales gated by `can_view_deals`). Kanban (6 drag-drop stages: new/contact/demo/trial/quote/won) vs List (persisted to `localStorage`). Smart Views chip bar, Today Strip, Insight Band. Detail drawer with a single computed "Smart Next-Action CTA", quotes-sent history, follow-up tasks. Many dialogs (AddLead, QuickAdd, StartTrial, Campaign, GoogleImport, ImportCsv, SendWhatsApp), deep-linked via `?action=` / `?lead=`. "Send Quote" deep-links `/quotes/new?leadId=…`.
3. **Quote Builder** (`components/features/quotes/quote-builder.tsx`, route `/quotes/new`) — lead-mode (editable Prospect Details, syncs back to lead) vs customer-mode (existing customer Select or free-text prospect). Prefill from lead via fuzzy catalog match. Billing-cycle picker (5 commitments). Line items: inline Qty/Rate/Cost, per-line discount (0–50%), commit + bill-cycle selectors. **Storage is always ₹/seat/year**; display = annual ÷ invoices-per-year. Live margin. Save allocates ID via `next_document_number(quote)` at save time; manual INSERT-then-UPDATE-on-23505 (deliberate, avoids false RLS failure from supabase-js upsert). Sending from lead-mode graduates lead → stage=`quote`.
4. **Quote detail** (`quotes/[id]/page.tsx`) — orchestrates the money workflow. Status-aware action bar: draft→send; sent/viewed→mark accepted / record payment; accepted+received/partial→**Generate GST Invoice** (`useGenerateInvoice`); invoiced→record balance / view invoice. Dialogs: RecordPayment (amount/method/reference + TDS), QuotePreview, ReceiptVoucher, SendQuote (POST `/api/quotes/[id]/send`), SendWhatsApp. `markAccepted` → POST `/api/quotes/[id]/mark-accepted` → `accept_quote` RPC.
5. **Invoices** (`invoices/page.tsx`) — Pending-generation card buckets paid/partial quotes by aging from first advance (0–15 / 16–30 / 31–60 / 60+; CGST §13(2) + Rule 47 30-day clock). `useGenerateInvoice`: `compute_advance_adjustment` → `next_document_number(invoice)` → `net_payable = max(0, amount − advances)` → status paid if 0 else pending → freeze `adjusted_advances` → flip quote `payment_status='invoiced'` + set `invoice_id` (terminal). Idempotency-guarded.
6. **Payments** (`payments/page.tsx`) — reconciliation over the `payments` table (multiple per quote = installments). Outstanding Receivables card with aging + actions (Pay/Remind/Suspend/Resume/Write-off). `paid_amount` computed from the payments ledger, not stale `quote.payment_amount`.
7. **Customers list + 360** (`customers/page.tsx`, `customers/[id]/page.tsx`) — effective health drops as outstanding ages; 360 tabs (Overview/Subscriptions/Quotes/Invoices/Activity/Files). Activity timeline is currently stubbed (`buildStubActivity` — no `activity_log` table yet). Files tab empty (Phase 2).

**GST correctness is pervasive:** intra vs inter-state (CGST+SGST vs IGST) driven by `state_code` "27" = Maharashtra; HSN 998313; receipt vouchers for advances; partial-payment invoicing within 30 days of first advance.

---

## 7. Renewals & Trial Automation

### 7.1 Cadence engine (`lib/renewals/cadence.ts`, pure)
Built around `d` = days until `renewal_date` (IST-aware via `daysBetween`, +5.5h shift then day-bucket). Triggers fire **only on exact days** (steps of 3, not consecutive):

| `d` | State | Tone | Email |
|---|---|---|---|
| ≥16 | `pending` | — | none |
| 15 | `notice_sent` | soft | soft + PDF quote |
| 12 | `reminder_1` | soft | soft reminder |
| 9 | `reminder_2` | friendly | friendly |
| 6 | `reminder_3` | firm | firm |
| 3 | `reminder_4` | urgent | urgent |
| 0 | `final_sent` | final | final + suspension warning |
| −grace…−1 | `grace_period` | grace | grace (only if grace>0) |
| < −grace | `suspended` | — | none (auto-suspend) |

> Note: shipped cadence is **T-15/12/9/6/3/0**. `docs/TEST-PLAN.md` and CLAUDE.md still reference an older **T-90/60/30/7** (or T-30/15/7/0) — stale relative to code.

`decideCadence(...)` returns `{targetState, daysUntilRenewal, shouldSendEmail, tone, shouldSuspend}`. **Idempotency:** `shouldSendEmail = currentState !== trigger.step`. `shouldSuspend` is the only flag re-attempted on re-runs (self-heals failed suspends). Terminal states `renewed`/`suspended` are protected from auto-regression.

### 7.2 Renewals cron (`api/cron/renewals/route.ts`)
Schedule **09:00 IST (03:30 UTC)** (Cloud Scheduler, `30 3 * * *` — `production/scripts/setup-cloud-scheduler.sh`, with `Authorization: Bearer $CRON_SECRET`). Auth: requires Bearer `CRON_SECRET` if set, else open (dev only — **a launch blocker if unset in prod**). Service-role client. Loops active + `auto_renew=true` + `renewal_date NOT NULL` subs:
- Suspend path → `status='paused'`, `renewal_state='suspended'`, stamp `suspended_at`.
- Daily idempotency: count `renewal_email_log` rows for `(subscription_id, cadence_step)` since IST midnight; ≥1 → skip.
- Email path: `createOrGetRenewalQuote` (ensures a quote for any emailing step) → render template + PDF (non-fatal if PDF fails) → `sendEmail` → log → on sent/stubbed update `renewal_state`, `reminder_count++`, `last_reminder_sent_at_v2`.

### 7.3 Renewal/extension/add-seats quote helpers
- `lib/renewals/create-renewal-quote.ts` — idempotent. `annualAmount = round(mrr×12)`, cost = `annual×0.83/seats` (~17% margin), `commitment: annual_yearly`, `is_renewal: true`, `extension_months: 12`, validity = `renewal_date + graceDays`. Links `subscriptions.renewal_quote_id`.
- `lib/renewals/create-extension-quote.ts` — operator "add N years" (1–5). `extension_months = years×12`, `is_extension: true`. Idempotency guard (`already_open` if a renewal_quote exists). Rationale: two clean GST invoices > refund-and-rebuy (immutable invoices, clean ITC).
- `lib/subscriptions/add-seats.ts` — mid-term pro-rata (`additionalSeats` 1–5000). `proRataFactor = days/365` (clamped [0,365]), `is_renewal: false`. Updates subscription seats/mrr immediately; best-effort auto-PO.
- API routes: `POST /api/subscriptions/[id]/{add-seats,extend,generate-renewal-quote}`, `POST /api/renewals/send-now` (manual, tenant-scoped, force-send between triggers, NO daily idempotency guard).

### 7.4 Trial automation
- Public trial (`/api/public/trial/workspace`): 14-day trial, lead `stage='trial'`, `trial_started_at`/`trial_expires_at`, seats cap 300, auto-creates 3 follow-up tasks (Day 7/12/14). No quote (free).
- Trial-expiry cron (`api/cron/trial-expiry/route.ts`): **10:00 IST (04:30 UTC)**. Leads `stage='trial'`, not converted/expired, `trial_expires_at <= now()` → stamp `trial_expired_at` (idempotency marker). **Stage stays `trial`** (not auto-`lost` — operator decides). Two best-effort emails (customer "we miss you" + internal alert to `Pardeep@example.test`).
- `trials.ts` query module is read-only derived from leads (`bucketize()` → in_flight / expiring_soon ≤7d / expired_unconverted / converted).

### 7.5 Pages
- `subscriptions/page.tsx` — tabs All/Active/Trials/Expiring-30d/Expired. Trials excluded from MRR/ARR. Inline `DomainCell` editor.
- `renewals/page.tsx` — buckets Urgent (0–7d) / Upcoming (8–30d) / Future (31–90d). `renewalRisk()` 0–100 churn score is **deterministic mock** (id char-code hash for last-login/tickets/NPS).

---

## 8. Accounting / Banking / Tax / Account Aggregator

All accounting tables store **whole rupees**. All date math IST-shifted; FY = Apr 1→Mar 31. Pages under `(app)/accounting/`.

- **GST Reports** (`gst/page.tsx`) — Output GST from invoices (`amount × 100/118` taxable, GST = remainder). Input GST from `vendor_bills` (`cgst+sgst+igst`) + `expenses` (`gst_paid`). Net liability = output − input. CSV exports for GSTR-1/3B. (Real IRN via ClearTax IRP is **not built**.)
- **Customer Aging** (`aging/page.tsx`) — receivables bucketed by `daysBetween(invoice_date, today)`: Current 0–30 / 31–60 / 61–90 / 90+. WhatsApp + email chase. **Bug:** dead `b90` key never populated (61–90 writes to `b60`).
- **P&L** (`pnl/page.tsx`) — Revenue (invoices) − COGS (`vendor_bills.subtotal` where `category LIKE 'COGS-%'`) = Gross Margin − OpEx (all expenses) = Net Profit. Net GST snapshot.
- **Customer Profitability** (`profitability/page.tsx`) — per-customer margin from quotes (received/partial/invoiced), ex-GST. Phase-2 override: real allocated COGS from `purchase_order_summary` view if available.
- **SaaS Metrics** (`saas-metrics/page.tsx`) — MRR/ARR/ARPC/LTV, 30-day movement, churn (naive proxy), vendor/tier breakdowns, cohort retention.
- **TDS Receivable** (`tds-receivable/page.tsx` + `year-end/`) — lifecycle `pending_cert → cert_received → verified_26as → claimed` (+disputed/written_off). Sections 194J/C/Q/H/I. Form 16A → `tds-certificates` bucket, 1h signed URLs. Year-end: Form 26AS CSV reconcile (±₹10 tolerance), bulk-verify. **Bug:** year-end bulk-verify does `window.location.reload()` instead of query invalidation. **ID gen via `Date.now()`/`Math.random()`** (`newTdsId`).
- **Vendor Bills** (`bills/page.tsx`) — COGS + input-GST source. Distributor-mirrored bills (`source_tenant_invoice_id`) get a "From distributor" badge.
- **Expenses** (`expenses/page.tsx`) — operating spend; `gst_paid` rolls into input GST.
- **Banking** (`banking/page.tsx` + `[id]/page.tsx`) — accounts (balance via `bank_account_current_balance` RPC). CSV import (7-bank header aliases: HDFC/ICICI/SBI/Axis/Kotak/IndusInd/Yes; DD/MM/YYYY parsing). Reconcile drawer uses `suggest_bank_transaction_matches` RPC with confidence pills; manual escape hatch for charges/transfers.

**Account Aggregator (Setu) — `lib/aa/setu.ts` + `api/aa/setu/{consent/init,callback,fetch/[connectionId]}`:**
- `isSetuConfigured()` checks 4 env vars (`SETU_AA_BASE_URL/CLIENT_ID/SECRET/REDIRECT_URL`); missing → **MOCK MODE** (deterministic fakes, full flow demos without keys).
- Flow: (1) `ConnectAaDialog` collects VUA + window → POST init → `createConsent` → insert `bank_aa_connections` (`pending_approval`) → open redirectUrl. (2) User approves → `GET /callback?handle=…&approved=…` → `getConsentStatus` → `status='active'` + `consent_id` + `linked_account_ref`. (3) `useFetchAaNow` → POST fetch → `requestFiData`+`fetchFiData` → map FI txns into `bank_transactions` (`source='api_fetch'`, deduped by `txn_date|debit|credit|reference`).
- Lifecycle: `initiated → pending_approval → active → (expired|revoked)`, with `rejected`/`error`.

---

## 9. Catalog, Contacts, Campaigns, WhatsApp, Coupons

- **Items / Catalog** (`items/page.tsx`, `lib/queries/items.ts`) — vendor + kind filters, soft-delete (`is_active=false`). `useLoadDefaultCatalog` seeds 7 main + 8 add-on SKUs (HSN 998313), tenant-scoped ids `${id}-${tenantId.slice(0,8)}`, idempotent upsert. `PublicBuyPagesCard` maps catalog → buy pages. `PartnerCatalogSection` (renders only when a parent tenant exists) → `get_partner_catalog` / `sync_partner_item`.
- **Contacts** (`contacts/page.tsx`) — unified directory aggregating leads + customers + imported `contacts` (`useAllContacts`, dedup by lowercased email, prefers customer>lead>imported). Google CSV import (client-side `parseGoogleContactsCsv`) → POST `/api/contacts/import` (Zod, max 2000, dedup by email, ids `C-<base36>`). Google People API alternative (`/api/contacts/google-fetch`, OAuth `provider_token`). Promote-to-lead (`/api/contacts/[id]/promote`, blocks double-promote, lead `source='from-contact:…'`).
- **Campaigns** (`campaigns/page.tsx`, `api/campaigns/{ai-generate,send}`) — audience by lead stages, live recipient count. AI generate via Gemini (`GEMINI_API_KEY`, default `gemini-1.5-flash`, JSON response, strict inline-CSS HTML email prompt; **falls back to deterministic stub** → `mode: 'gemini'|'stub'`). Send: campaign id via `next_document_number('campaign')`, per-recipient loop, idempotent `campaign_sends` (unique per campaign+recipient).
- **WhatsApp** (`whatsapp/page.tsx`, `lib/whatsapp/client.ts`) — Gupshup/Meta inbox. `sendWhatsApp()` stub-inserts a `pending` row then POSTs Meta Graph v18.0. Enforces Meta 24-hour rule (free-form only if last inbound < 24h). Inbound webhook (`api/webhooks/whatsapp`): GET handshake, POST messages/statuses with optional HMAC-SHA256 verify. Per-tenant creds in `tenant_secrets`. Polls 15s/10s (pseudo-realtime).
- **Coupons** (`coupons/page.tsx`) — visitor-entered codes; validation `/api/public/coupons/validate`, redemption `redeem_coupon` RPC (atomic). Discount pre-GST, then 18% recomputed.
- **Online Promos** (`online-promos/page.tsx`) — auto-applied banner discounts; public read `/api/public/site-promo/current`; created via `create_site_promo` RPC.

---

## 10. Public Flows, Customer Portal, Partner/Distributor Hierarchy

### 10.1 Two product pricing models — DO NOT CONFLATE
- **Model A** = Google Workspace product pricing (what resellers SELL). Storefront `(public)/buy/workspace`. Tiers `starter|standard|plus|enterprise`. Source of truth = `items` catalog; hardcoded fallbacks.
- **Model B** = ResellerOS SaaS pricing (what resellers PAY). `(public)/pricing/page.tsx`. Tiers `Starter|Growth|Pro`. **Currently aspirational, no paywall enforced.** (The `/pricing` route exists in code — confirmed — resolving a docs discrepancy; see §14.)
- **Model C** = `LineCommitment` per-quote-line billing tier (5 values). See §11.

### 10.2 Reseller signup → tenant creation
- Email/password: `signup/page.tsx` → `POST /api/auth/signup` (service-role): `auth.admin.createUser` (`email_confirm:true`) → insert `tenants` → insert `users` (role `owner`, color `amber`). Manual rollback per step.
- Google OAuth: `(auth)/callback/route.ts` — first-timer derives company from email domain, creates tenant (`tier:'reseller'`) + owner user, redirects `/setup?welcome=1`.
- Each reseller gets exactly one tenant; isolation via RLS.

### 10.3 Public direct checkout (`/buy/workspace` → Razorpay)
`BuyNowDialog` → `POST /api/public/checkout/workspace`. Razorpay creds: per-tenant `tenant_secrets` → env → none. Modes: configured → LIVE (create lead/quote → `razorpay.orders.create` → DB flip happens in the **webhook**, not the client); not configured + `simulate:true` → SIMULATION (calls `record_payment` directly); not configured + no simulate → 503; configured + simulate → 400 (refused).

### 10.4 Enquiry / trial variants
- `/api/public/enquiry/workspace` — lead-capture, auto-creates a **draft** quote (honors Standard 20%-first-20 split-promo).
- `/api/public/trial/workspace` — 14-day trial (see §7.4).

### 10.5 Quote acceptance (`/quote/[id]/accept`)
Server page (quote ID is the implicit secret); 404 on draft. Marks sent→viewed. Accept → `POST /api/public/quote/[id]/accept` sets `status='accepted', payment_status='awaiting'`. **TODO: reseller notification email not implemented** (console log only). No payment on this page.

### 10.6 Customer portal (`/portal/*`)
Magic-link only (`signInWithOtp`). Callback finds `customers` by `ilike(contact_email)`, inserts `customer_users` link; no match → sign out + `?error=no_customer`. Session in `lib/portal/session.ts`. Pages: Dashboard, Subscription (**self-serve `auto_renew` toggle** — the only true self-service write; seat change → support ticket), Orders (read-only quotes), Invoices (**PDF download is a 503 stub**), Profile (read-only), Support. Ticket IDs via `Math.random()`.

### 10.7 Razorpay webhook (`api/webhooks/razorpay/route.ts`)
PUBLIC route; HMAC-SHA256 (`RAZORPAY_WEBHOOK_SECRET`, `timingSafeEqual`, **fails closed** if secret unset). Acts on `payment.captured`/`order.paid`. Looks up quote by receipt/notes. **Idempotent** (skips if `payment_status='received'`). Calls `record_payment` RPC, then best-effort emails.

### 10.8 Partner / distributor hierarchy
Two tiers only: **distributor** (can have children) and **reseller** (can have a parent) — single parent→child level, no deeper nesting. `tenants.parent_tenant_id` + `tier` (0040). `customers.linked_tenant_id` links a customer to a child tenant for the invoice-mirror trigger (§5.5). `/partners` page = distributor-only aggregated dashboard via `get_partner_metrics`. Settings → Company shows read-only ResellerTierCard.

---

## 11. Pricing / Commitment-Tier / Billing-Tier Model (real numbers)

### 11.1 Model A — Google Workspace (₹/user/MONTH on annual commitment; line `rate` = monthly×12)
| Tier | id | Fallback annual ₹/user/mo | Fallback monthly ₹/user/mo | Promo | Max users | Direct-buy |
|---|---|---|---|---|---|---|
| Business Starter | `starter` | 270 | 325 | — | 300 | Yes |
| Business Standard | `standard` | 1080 | 1300 | **864** (20% off, first 20 users, 12mo) | 300 | Yes (popular) |
| Business Plus | `plus` | catalog-only (fallback omits) | — | — | 300 | If in catalog |
| Enterprise | `enterprise` | null (custom) | null | — | unlimited | No — quote only |

Catalog `monthlyPrice` computed as `annual × 1.25` when absent. Business Base (₹99) excluded (Premier Partners can't resell).

**Two server-side implementations (a real inconsistency):**
- `/api/public/checkout/workspace` — catalog-driven; in-file `TIER_FALLBACK_MONTHLY = { starter:270, standard:1080, plus:1380, enterprise:2400 }`. **Ignores Standard's promo** (flat monthly×12).
- `/api/public/enquiry/workspace` — hardcoded constants: `STARTER_PER_USER_MONTH=270`, `STANDARD_PROMO_PER_USER=864`, `STANDARD_REGULAR_PER_USER=1080`, `ENTERPRISE_EST_PER_USER_YR=24000` (ranking only). **Honors** the promo (splits first-20 @ promo, rest @ regular).
- The buy-page calculator applies the promo to ALL seats; enquiry applies first-20-only; direct-checkout applies NONE. Same tier quotes differently via "Buy now" vs "Get a quote" — **flagged inconsistency**.

**Discount stacking (checkout):** subtotal → site promo (auto) → coupon (`redeem_coupon` RPC) → recompute 18% GST on discounted base.

### 11.2 Model B — ResellerOS SaaS (hardcoded, marketing-only, no paywall)
| Tier | ₹/mo | ₹/yr (2mo free) | Users | Customers |
|---|---|---|---|---|
| Starter | 999 | 9,990 | 1 | 50 |
| Growth (popular) | 2,499 | 24,990 | 5 | 500 |
| Pro | 6,999 | 69,990 | unlimited | unlimited |

All ex-18% GST. Beta free for first 10 resellers until 2026-09-01.

### 11.3 Model C — `LineCommitment` (5 values; storage always annual ₹/seat; controls invoice slicing only)
| Value | Commit | Invoices/yr | Unit |
|---|---|---|---|
| `monthly` | flex | 12 | /mo |
| `annual_monthly` | 1-yr | 12 | /mo |
| `annual_quarterly` | 1-yr | 4 | /qtr |
| `annual_half_yearly` | 1-yr | 2 | /half-yr |
| `annual_yearly` (default) | 1-yr | 1 | /yr |

In `record_payment` step 8a, `monthly` = flex (no annual sub); any other non-null commitment = 1-yr annual. All public buy/enquiry/checkout flows hardcode `annual_yearly`.

**Margin convention everywhere:** wholesale ≈ 83% of retail (~17% reseller margin), used in renewal/extension/add-seats/auto-PO cost math.

---

## 12. UI Architecture, Design Tokens, Navigation, Layout Shell

### 12.1 Components (`production/src/components/`)
- `ui/` (26) — shadcn primitives + wrappers: `button` (Button+IconButton), responsive `dialog` (bottom-sheet mobile / modal desktop), `fab` (mobile-only), `icon` (lucide wrapper), etc.
- `shared/` (4) — `activity-timeline`, `empty-state`, `gemini-card` (AI surface), `kpi`.
- `layout/` (6) — `Sidebar` (+MobileSidebar+SidebarContent), `topbar`, `command-palette`, `MobileBottomNav`, `notification-panel`, `quick-actions-panel`.
- `features/` (~44) — by domain (accounting, banking, campaigns, contacts, coupons, customers, gstin, integrations, items, leads (12), purchase-orders, quotes (8), site-promos, subscriptions, tasks, trials, whatsapp) + `margin-pill`.

### 12.2 Design tokens (`globals.css` + `tailwind.config.ts`)
Warm "paper" aesthetic, HSL channels: `--paper` #FAF8F2, `--ink` #1A1815, **brand `--amber` #C2410C** (+`--amber-soft` #FFF3E6, `--amber-ink` #9F3409). Status: emerald #166534, rose #DC2626, indigo #3730A3, slate #475569 (+soft variants). shadcn aliases derive from these (primary→amber, destructive→rose, ring→amber). Full `.dark` palette (class strategy).
Fonts: `--font-serif` **DM Serif Display** (headlines/KPI values/totals), `--font-sans` **Plus Jakarta Sans** (UI), `--font-mono` **JetBrains Mono** (IDs/GSTIN/IRN). `.tnum` for money. Radii lg 10 / md 8 / sm 6. Focus ring `ring-2 ring-amber`. Print styles for invoices/quotes.
> The `UX-DESIGN-PRINCIPLES.md` doc specifies a different (purple/glassmorphism/Inter) system — that doc predates the production tokens; the amber/paper system above is authoritative.

### 12.3 Layout shell (`app/(app)/layout.tsx`)
Flex shell (bg `paper-2/50`): Desktop Sidebar (sticky 240px, role-filtered via `filterNavForRole`, badges via `useNavBadges`, Setup hidden once `tenantSetupCompletedAt`); MobileSidebar (Sheet `w-72`); TopBar (`h-14`, breadcrumb, ⌘K, theme toggle, sparkles QuickActions, bell badge via `useTaskCountDueOrOverdue`); CommandPalette (cmdk, ⌘K, real tenant-scoped customers/leads/contacts/quotes); MobileBottomNav (role-aware tabs). NotificationPanel still uses **sample data** (Realtime TODO).

### 12.4 Navigation (`lib/nav.ts`)
Single source of truth. `UserRole` = `USER_ROLES` in `lib/auth/roles.ts` (owner, manager, sales_senior, sales, billing, delivery, accountant, support, partner_agent — checked 19 Oct 2026; the line below describes the original three-role design). `APP_NAV` sections: Workspace, Revenue, Procurement, Accounting, Engage, System (most owner/mgr-only; sales sees Leads/Tasks + Deals if `can_view_deals`). `CUSTOMER_NAV` = chromeless public pages. Helpers: `filterNavForRole`, `allowedRoutesForRole` (for middleware), `ROLE_HOME` (owner/manager→`/dashboard`, sales→`/leads`), `getCrumb`.

---

## 13. Infra: Hosting, Deploy, Env Vars, Sentry, Middleware

### 13.1 Hosting / deploy (transitioned Vercel → Firebase App Hosting → Cloud Run)
- **Cloud Run** (`cloudbuild.yaml`, `production/deploy.sh`; `firebase.json`/`.firebaserc` only rewrite hosting to the service). Project `resellsubsos-prod`, live service `resellersos` and staging service `resellersos-staging`, both **asia-southeast1**. Secrets in Google Secret Manager.
- **Crons** run from Cloud Scheduler (`production/scripts/setup-cloud-scheduler.sh`) with the Bearer `CRON_SECRET`. `vercel.json` and `apphosting.yaml` were removed on 19 Oct 2026 (R-1604) — neither did anything on Cloud Run. The old `reselleros-test` app (`deploy-test.cmd`, both `cloudbuild.test.yaml`) was retired the same day.
- `next.config.mjs`: `output: standalone`, `poweredByHeader:false`, typedRoutes, instrumentationHook, security headers (X-Frame SAMEORIGIN, nosniff, strict-origin referrer, Permissions-Policy locks camera/mic/geo), wrapped in `withSentryConfig`.

### 13.2 Env vars (`.env.example`)
Supabase (`NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`), Razorpay (`NEXT_PUBLIC_RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`), GST IRP (`GST_IRP_*`), Google CSP (`GOOGLE_CSP_*`), WhatsApp/Gupshup (`GUPSHUP_*`), Email/Resend (`RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`), AI (`GEMINI_API_KEY`, `GEMINI_MODEL`), monitoring (`NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `NEXT_PUBLIC_PLAUSIBLE_DOMAIN`), app (`NEXT_PUBLIC_APP_URL`, `NODE_ENV`). Used-but-not-in-example: `SENTRY_DSN`, `SENTRY_ORG`/`PROJECT`, `CRON_SECRET`, `NEXT_PUBLIC_DEMO_MODE`, `ALLOW_SENTRY_TEST`, `SETU_*`, `SANDBOX_*`.

### 13.3 Sentry
The canonical `instrumentation.ts → sentry.{server,edge}.config.ts` flow **does not fire** on Next 14.2.15 + standalone + Cloud Run (measured then; the app is on Next 15.5.26 since — `production/package.json`, checked 19 Oct 2026 — and the workaround below is still in place). **Workaround:** `src/lib/sentry.ts` is an idempotent side-effect module (`if (DSN && !getClient()) init(...)`), imported via **`import "@/lib/sentry"` at the top of `lib/supabase/server.ts`** — the chokepoint every authenticated server path crosses. New server-only code bypassing Supabase (standalone webhooks/cron) must add the import directly. Error boundaries `app/global-error.tsx` + `app/(app)/error.tsx`. Smoke test `GET /api/sentry-test` (prod-gated by `ALLOW_SENTRY_TEST=1`).

### 13.4 Middleware (`src/middleware.ts` + `lib/supabase/middleware.ts`)
1. `isSupabaseConfigured()` false → pass through. 2. `NEXT_PUBLIC_DEMO_MODE=true` + dev → bypass. 3. Else `updateSession()` refreshes cookies (modern `getAll/setAll`, chosen because the Cloud Run proxy can drop chunked tokens), validates via **`getUser()`** (JWT-validated, not spoofable `getSession()`), reads `users.role` + `can_view_deals`. 4. Gate against `PROTECTED_PREFIXES` (a **manual mirror of APP_NAV — drift risk, flagged in-file**): unauth+protected → `/login?next=`; auth on login/signup → `ROLE_HOME[role]`; auth + sales role → `allowedRoutesForRole` check, bounce to home if disallowed; owner/manager get full app.

---

## 14. Implemented vs Planned / TODO Gaps (code-verified where possible)

### Implemented (17 modules)
Core CRM (leads/deals, tasks, customers, contacts, items), Revenue (quote builder, send+PDF+accept, invoices w/ advance adjustment, payments+receipt vouchers, subscriptions, renewals automation, online orders), full Accounting (vendor bills, expenses, P&L, aging, profitability, SaaS metrics, GST reports, TDS receivable + 26AS), Procurement (POs, bill matching), Partner channel (hierarchy, catalog sync, invoice mirror, /partners), Customer portal (magic-link, dashboard/orders/invoices/tickets, auto_renew toggle), Engagement (campaigns + AI, WhatsApp inbox + webhook, Resend email), Banking (7-bank CSV, reconcile, AA scaffold), Setup wizard + Settings, GSTIN verify, Mobile/PWA, public/legal pages. Live atomic RPCs: `next_document_number`, `record_payment`, `compute_advance_adjustment`, `accept_quote`, `redeem_coupon`, `create_site_promo`, partner RPCs, banking RPCs.

### Partial
AA (Setu) live (mock active, needs keys), Resend (stub, needs domain verify + key), Razorpay (test mode, needs KYC + live keys), subscription multi-quote outstanding update (tech debt — needs `subscriptions.quote_id` FK), renewal-risk model (mock signals).

### Missing / Planned
- Live Razorpay billing + **paywall/tier enforcement** for ResellerOS itself (Model B not enforced).
- **GST e-Invoice IRP integration** (ClearTax/NIC GSP — legally mandatory >₹5cr turnover).
- **Audit logs** (`audit_log` table planned).
- **DPA template**, data export/deletion/retention (DPDP).
- Custom domain `resellersos.in` + email deliverability (SPF/DKIM/DMARC), status page, knowledge base, onboarding tour + `seed_demo_data`, password reset (TC-108).
- `refund_payment` RPC.
- All 8 integration tests (TC-1401–1408) not built; Playwright cross-tenant suite blocked on service-role key rotation.
- Vendor provisioning APIs (Google CSP, MS Partner Center, Zoho Partner — P3, not wired).
- WhatsApp template picker (Phase 2C); activity_log table (360 activity is stubbed); portal invoice PDF (503 stub); quote-accept reseller notification email (console-log TODO).

### Launch blockers (Tier 1, per gap analysis)
Live Razorpay + paywall; e-Invoice IRP; audit logs; DPA template. Older P0s (mostly resolved): hosting (now Cloud Run), invalid `RESEND_API_KEY`, placeholder `NEXT_PUBLIC_APP_URL`, **`CRON_SECRET` unset in prod** (cron accepts unauthenticated if unset).

### Honest schema/code caveats
- **Money unit ambiguity:** CLAUDE.md §13 says paise; PRD V3 §5 says integer ₹ (no paise except in Razorpay calls); accounting tables clearly store ₹. Canonical unit unresolved — confirm before any cross-table money math.
- **Migration numbering jump 0017→0040 is NOT a missing-files gap.** `0003_freeze_baseline.sql` is an idempotent baseline that consolidates "19 ad-hoc migrations applied directly to prod via Studio/MCP between 0002 and 0003 without being checked into git." All 27 committed files (0001–0017, 0040–0050) were examined.
- **⚠️ LIVE SCHEMA DRIFT (verified, important).** Several columns the code actively depends on are **referenced but created by NO committed migration**: `quotes.extension_months`, `quotes.is_extension`, `quotes.domain`, and `leads.trial_started_at / trial_expires_at / trial_converted_at / trial_expired_at`. The `record_payment()` RPC (0047) and the query layer read/write these, so they exist in the prod DB — meaning they were applied directly via Studio/MCP after the 0003 freeze and never re-captured in git. This is precisely the anti-pattern CLAUDE.md §17 forbids. **Action item:** generate a catch-up migration (`supabase db diff`) to bring git back in sync with prod before any schema work, or a fresh-DB rebuild will be missing these columns and `record_payment` will fail.
- Cross-tenant ID collision: a pending composite-PK migration for quotes/POs/invoices is flagged as a known unresolved risk (currently mitigated with renamed prefixes like `PO-ET-…`).
- JS document-number anti-pattern in expenses/vendor-bills/tds-receivable/contacts/tickets (non-GST docs, tolerated).

### Doc-vs-code discrepancies (resolved where checked)
- **Pricing page:** PRD said shipped, PROJECT_TRACKER said missing. **Code check confirms `(public)/pricing/page.tsx` exists** — shipped (no checkout). 
- Marketing landing: PRD says redesigned, tracker says basic — unresolved (not examined in code).
- CLAUDE.md is stale on host (lists Vercel/Plausible; reality Cloud Run, Plausible not initialized), on RPC status (lists live RPCs as TBD), and on renewal cadence (T-90/60/30/7 vs shipped T-15/12/9/6/3/0). PRD V3 + PROJECT_TRACKER (2026-05-29) are freshest.

---

## 15. Key Files Index (path → what it is)

### Migrations (`production/supabase/migrations/`)
- `0001_init.sql` → core tables + enums + RLS-less base
- `0002_rls.sql` → RLS policies + `current_tenant_id()`
- `0003_freeze_baseline.sql` → quote/payment/subscription expansion, `payment_status`, payments table
- `0004_document_series.sql` → `document_series` + `next_document_number` + FY helpers
- `0005_invoice_advance_adjustment.sql` → Rule-53 advance freeze + `compute_advance_adjustment`
- `0006/0010/0012/0047_*record_payment*.sql` → the `record_payment()` spine evolution (current = 0047)
- `0007_tasks.sql` → tasks + completion trigger
- `0008_renewals_automation.sql` → `renewal_state`, `renewal_email_log`, grace_period_days
- `0009_quote_send_log.sql` → quote-email audit
- `0011_quotes_is_renewal.sql` → `quotes.is_renewal`
- `0013_accounting_foundation.sql` → vendor_bills + expenses
- `0014/0015_tds*.sql` → tds_receivable + certificates storage
- `0016_customer_portal_auth.sql` → customer_users + `current_customer_id()` + portal RLS
- `0017_support_tickets_auto_renew.sql` → support_tickets + `auto_renew`
- `0040–0044` → reseller hierarchy, partner catalog/sync, cross-tenant invoice mirror, partner metrics
- `0045_users_can_view_deals.sql`, `0046_leads_workflow_fields.sql`
- `0048/0049_banking*.sql`, `0050_bank_aa_connections.sql`
- *(No 0018–0039 files exist — numbering jumped 0017→0040; the 19 intervening prod-only changes are consolidated into `0003_freeze_baseline.sql`.)*

### Query layer (`production/src/lib/queries/`)
22 modules: `leads, trials, quotes, invoices, payments, subscriptions, customers, contacts, imported-contacts, items, purchase-orders, vendor-bills, expenses, tds-receivable, tasks, bank, bank-aa, coupons, site-promos, whatsapp, tenant`. `invoices.ts` = the most business-critical (invoice-generation engine).

### Renewals / subscriptions logic (`production/src/lib/`)
`renewals/{cadence,templates,create-renewal-quote,create-extension-quote}.ts`, `subscriptions/add-seats.ts`.

### Pages (`production/src/app/(app)/`)
`dashboard, leads (+/deals re-export), quotes, quotes/new, quotes/[id], invoices, payments, customers, customers/[id], subscriptions, renewals, items, contacts, campaigns, whatsapp, coupons, online-promos, online-orders, lead-gen, team, support, tasks, partners, setup, settings` + `accounting/{gst,aging,pnl,profitability,saas-metrics,tds-receivable,tds-receivable/year-end,bills,expenses,banking,banking/[id]}`.

### Public / portal (`production/src/app/(public)/` + `(auth)/`)
`buy/workspace`, `pricing`, `quote/[id]/accept`, `portal/*`, `(auth)/callback`, `signup`, `login`, `aa/simulate-approval`.

### API routes (`production/src/app/api/`)
`auth/signup`, `quotes/[id]/{send,mark-accepted}`, `public/{checkout,enquiry,trial}/workspace`, `public/quote/[id]/accept`, `public/{coupons/validate,site-promo/current}`, `subscriptions/[id]/{add-seats,extend,generate-renewal-quote}`, `renewals/send-now`, `cron/{renewals,trial-expiry}`, `webhooks/{razorpay,whatsapp}`, `aa/setu/{consent/init,callback,fetch/[connectionId]}`, `contacts/{import,google-fetch,[id]/promote}`, `campaigns/{ai-generate,send}`, `whatsapp/send`, `integrations/{razorpay,sandbox,whatsapp[/test]}`, `gstin/verify`, `portal/invoice/[id]/pdf` (503 stub), `sentry-test`.

### Infra / config (`production/`)
`next.config.mjs`, `firebase.json`, `.firebaserc`, `.env.example`, `src/middleware.ts`, `src/lib/supabase/{client,server,middleware}.ts`, `src/lib/sentry.ts`, `instrumentation.ts`, `sentry.{client,server,edge}.config.ts`, `src/lib/nav.ts`, `src/app/globals.css`, `tailwind.config.ts`, `src/lib/{tenant,types}.ts`, `src/lib/aa/setu.ts`, `src/lib/whatsapp/client.ts`, `src/lib/email/send.ts`.

### Docs (`C:\dev\ResellerOSv3\`)
`RESELLEROS-PRD-V3.md` + `PROJECT_TRACKER.md` (2026-05-29 — STALE, history only; R-1609), `production/CLAUDE.md` (the project rulebook), `production/LAUNCH_READINESS.md` (2026-05-24, mid-pivot — STALE), `docs/{TEST-PLAN,WORLD_CLASS_GAP_ANALYSIS,WORKFLOW-DIAGRAM,MONITORING_SETUP,EMAIL_SETUP_RESEND,LANDING_PAGE_DESIGN_BRIEF}.md`, `UX-DESIGN-PRINCIPLES.md` (predates prod tokens), `WORKFLOWS-DETAILED.md`, `docs/archive/{LEADOS-RESELLER-CRM-V2-PRD,MODULES-BREAKDOWN,UNIFIED-PRD-V3}.md`.
