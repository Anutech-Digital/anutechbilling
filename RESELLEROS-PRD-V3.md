# ResellerOS — Product Requirements Document (V3)

> **Version:** 3.0
> **Date:** 2026-05-29
> **Status:** Current state — reflects production codebase at commit `7e0bd49`
> **Target user:** Indian cloud resellers (Google Workspace, Microsoft 365, Zoho)
> **Live URL:** https://resellersos-njvk4nxhdq-el.a.run.app
> **Repo:** https://github.com/Pardeep-byte1/resellersos
> **Replaces:** `docs/archive/LEADOS-RESELLER-CRM-V2-PRD.md` (V2, Firebase plan, archived)

---

## 0. Why a V3 — what changed since V2

V2 PRD (2026-05-19) described a single-product Google Workspace reseller CRM on Firebase. The actual built product diverged significantly:

| Dimension | V2 PRD | V3 Reality |
|---|---|---|
| Product name | LeadOS V2 | **ResellerOS** |
| Scope | GW only | **GW + M365 + Zoho** + multi-product |
| Tenancy | Single agency | **Multi-tenant** with RLS |
| Stack | Firestore + Firebase | **Supabase Postgres + Cloud Run** |
| Search | Algolia indexed | Server-side Postgres queries |
| Functions | Firebase Cloud Functions | API routes + cron handlers |
| Modules built | 6 (V2 scope) | **17 shipped modules** |
| Customer-facing | None | **Customer portal + public buy pages** |
| Compliance | GST mentioned | **GST + HSN + DPDP + TDS + multi-step** |
| Channels | Web only | **Web + PWA + WhatsApp + email** |
| Partner channel | Not in scope | **Distributor → reseller hierarchy built** |
| Banking | Not in scope | **Multi-bank CSV import + AA scaffold** |

V3 is not an aspirational doc — it documents what's already in production at Client A (the dogfooding tenant) and Anutech Digital (the partner tenant).

---

## 1. Product Vision

**ResellerOS is a multi-tenant operating system for Indian cloud resellers** — solo SaaS hustlers to 100-employee distributors — that replaces the 5-7 disconnected tools they juggle today (CRM spreadsheet, Tally, Zoho Books, WhatsApp, Gmail, bank-statement paperwork, Razorpay dashboard, GST return prep) with one cohesive operating layer.

```
Lead inbound → Qualify → Quote (GST-compliant) → Send (email/WhatsApp/PDF)
        ↓
Accept (with/without payment) → Customer auto-created → Subscription seeded
        ↓
Invoice generated (CGST §31) → Razorpay collect → Receipt voucher (CGST §31(3)(d))
        ↓
Renewal cadence T-30 / T-15 / T-7 / T-0 → Auto-suspend with grace
        ↓
Bank reconciliation (CSV or live AA) → Accounting layer → GST return prep
        ↓
TDS receivable cycle → Form 26AS reconcile at year-end
```

**Success metric:** A reseller can run their entire month-end ops cycle inside ResellerOS without opening Tally, Zoho Books, their bank's portal, Razorpay dashboard, WhatsApp business, or a single spreadsheet.

**North-star metric:** Number of paying tenants × average MRR (currently 0 paying, target 10 in 90 days, 100 in 12 months).

---

## 2. User Personas

| Persona | Permissions | Daily surface |
|---|---|---|
| **Owner** (Pardeep at Client A) | Full access — billing, settings, all data, partner channel | Dashboard → Leads/Deals → Quotes → Invoices → Renewals → Banking → Reports |
| **Sales rep** (Darshan at Client A) | Owned leads + own deals + own quotes; read-only customers; cannot delete; no Import CSV; no campaigns | /leads → /deals → /tasks → /support |
| **Support/Ops** | Customers + subscriptions + invoices (no quote pricing edit) | /customers → /subscriptions → /support |
| **Accountant / Finance** | Invoices + payments + TDS + banking + GST reports | /invoices → /payments → /banking → /reports |
| **Customer portal user** (the reseller's own customers) | Magic-link login; their own subscriptions/invoices/tickets only | /portal/* (separate origin / brandable) |

RBAC implementation: `users.role` column + RLS policies that respect role. The `users` table has `role` enum and `permissions` JSONB for per-feature flags (e.g., `can_view_deals` for restricted sales role).

---

## 3. Tech Stack (current, accurate)

| Layer | Tech | Why |
|---|---|---|
| Framework | **Next.js 14.2.15** (App Router) | RSC-ready, mature, Cloud Run friendly |
| Language | TypeScript strict | No `any`, no `@ts-ignore` |
| Styling | Tailwind CSS + shadcn/ui base | Token system, dark-mode-ready |
| Database | **Supabase Postgres** | RLS, realtime, free-tier generous |
| Auth | **Supabase Auth** (email/password + Google OAuth) | SSR-aware, custom-claims-ready |
| State (server) | TanStack Query v5 | Optimistic mutations, focused refetches |
| State (forms) | React Hook Form + Zod | Type-safe schemas |
| Animations | Framer Motion (sparingly) | Drawer + dialog transitions |
| Charts | Recharts | Bundle-friendly |
| Command palette | cmdk | Cmd+K universal search |
| Toast | sonner | Top-right, dismissable |
| i18n | next-intl (English only; Hindi prepped for 100+ customers) | Pluggable later |
| Icons | lucide-react (wrapped in `<Icon>`) | Single import surface |
| Email | **Resend** | Domain-verified sending |
| Payments | **Razorpay** (test mode → production after KYC) | India-first, UPI/Cards |
| GST verification | **Sandbox.co.in** (with mock fallback) | Two-step token flow |
| WhatsApp | **Gupshup BSP** | India BSP, send + webhook + media |
| Bank statements | CSV parser (HDFC/ICICI/SBI/Axis/Kotak/IndusInd/Yes Bank) | Period-suffix safe |
| Account Aggregator | **Setu API** (mock-first, switches to live with env keys) | RBI-regulated bank data |
| PDF | `@react-pdf/renderer` (server-side) | Quote + Invoice + Receipt PDFs |
| Monitoring | **Sentry** (error tracking) + **BetterStack** (uptime) | Wired with chokepoint pattern |
| Hosting | **Google Cloud Run** (asia-south1, Mumbai) | Container-based, autoscale to 0 |
| Source control | GitHub | Branch deploys, gh CLI |
| Tests | Vitest + Playwright | Unit + E2E (cross-tenant fixture) |
| CI | GitHub Actions workflow | typecheck + lint + smoke on every push |

### What's intentionally NOT in stack

- ❌ Algolia / Elasticsearch — Postgres full-text + Supabase queries cover Cmd+K
- ❌ Redis — TanStack Query cache + Supabase pooling is enough
- ❌ Microservices — monolith is correct at this scale
- ❌ Kubernetes — Cloud Run handles orchestration
- ❌ GraphQL — REST + Supabase client gives the same DX for less complexity

---

## 4. Multi-tenancy + RLS (the architectural foundation)

Every table except `tenants` and `users` has `tenant_id uuid NOT NULL REFERENCES tenants(id)` and **Row-Level Security enabled**. The canonical RLS policy:

```sql
CREATE POLICY tenant_isolation ON <table>
  FOR ALL
  USING (tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid()));
```

This means a logged-in user CAN ONLY see/modify rows in their own tenant. Cross-tenant leakage is impossible at the database layer, regardless of bugs in app code.

**Multi-tenant SaaS pattern**: Each `tenant` is one reseller business. Client A and Anutech Digital are two real tenants today; both have their own catalog, leads, quotes, customers, etc.

**Partner channel exception**: When a distributor (parent tenant) issues an invoice to its child reseller (downstream tenant), a `vendor_bill` row is auto-created in the child's tenant via a `SECURITY DEFINER` RPC that bypasses RLS in a controlled way. This is the only sanctioned cross-tenant write.

### Verification rules

- **Every PR adding a new query MUST have a Playwright cross-tenant test** verifying it can't read another tenant's data. Existing fixture at `e2e/fixtures` sets up two tenants and asserts isolation.
- **Service-role key is server-only.** Never exposed to client.
- **Code review checklist** flags any query missing `.eq("tenant_id", ...)` or RLS bypass.

---

## 5. Data Model (current Supabase schema)

The full schema lives in `production/supabase/migrations/` (0001 → 0040+ at time of writing). High-level tables:

### Core entities

| Table | Purpose | Key columns |
|---|---|---|
| `tenants` | One row per reseller business | `id`, `name`, `gstin`, `state_code`, `subscription_tier`, `reseller_tier` (`distributor` / `reseller`) |
| `users` | Team members across tenants | `id` (= auth.uid), `tenant_id`, `email`, `role`, `permissions` JSONB |
| `leads` | Both raw inquiries AND qualified deals (split by `plan` field) | `company`, `contact_name`, `plan`, `stage`, `value`, `owner_id`, `follow_up_date`, `priority` |
| `customers` | Closed-won leads upgraded | `legal_name`, `gstin`, `state_code`, `billing_address`, `primary_contact` |
| `contacts` | Standalone contacts (pre-lead) | `name`, `email`, `phone`, `tenant_id` |
| `items` | Product catalog (GW Starter, M365 Premium, etc.) | `name`, `hsn` (default 998313), `prices` JSONB (monthly + annual tiers) |
| `quotes` | Sent quotations | `quote_number` (Q-YYYY-YY-NNNN), `customer_id` or lead-context, `line_items` JSONB, `status`, `payment_status`, `total`, `tax_breakdown` JSONB |
| `subscriptions` | Active customer subscriptions | `customer_id`, `item_id`, `seats`, `commitment`, `start_date`, `renewal_date`, `status` |
| `invoices` | GST tax invoices | `invoice_number` (INV-YYYY-YY-NNNN), `irn` (e-Invoice IRP, when wired), `qr_code`, `line_items`, `tax_breakdown` |
| `payments` | Razorpay + manual payments | `quote_id` or `invoice_id`, `amount`, `method`, `razorpay_payment_id` |

### Money + accounting

| Table | Purpose |
|---|---|
| `vendor_bills` | Bills FROM vendors (Google / Microsoft / etc., or parent distributor) |
| `expenses` | Operational expenses |
| `purchase_orders` | POs raised to vendors |
| `bank_accounts` | Multi-bank list per tenant |
| `bank_transactions` | CSV-imported bank statement rows |
| `bank_aa_connections` | Setu AA consent + sync state |
| `tds_receivables` | TDS deducted by customers, recoverable via Form 26AS |

### Engagement

| Table | Purpose |
|---|---|
| `tasks` | Follow-ups, generic to-dos |
| `activities` | Timeline events (calls, emails, meetings, notes) |
| `campaigns` | Bulk email campaigns (newsletters, offers) |
| `whatsapp_messages` | Gupshup BSP inbox |
| `support_tickets` | Customer portal tickets |

### System

| Table | Purpose |
|---|---|
| `document_sequences` | Per-tenant + per-fiscal-year invoice/quote/PO numbering |
| `audit_logs` | (Planned) actor/action/entity/before/after for sensitive ops |
| `partner_catalog_sync` | Distributor → reseller item mirror state |
| `tenant_settings` | Per-tenant config (renewal grace days, Razorpay keys, GSP keys, WhatsApp creds, etc.) |

### Money representation

- **Internally**: integer ₹ (no paise, except inside Razorpay calls)
- **`items.prices` JSONB**: `{ monthly?: {msrp, wholesale}, annual?: {msrp, wholesale} }` — both in **₹/seat/month** integers
- **`quotes.line_items[].rate`**: **₹/seat/YEAR** (canonical unit for math)
- **Display conversion** based on commitment:

```
commitment              invoicesPerYear   display unit
monthly                 12                /mo (flex)
annual_monthly          12                /mo (1-yr commit, monthly bill)
annual_quarterly         4                /qtr
annual_half_yearly       2                /half-yr
annual_yearly            1                /yr (default for prospect quotes)
```

---

## 6. Atomic Postgres functions (multi-row writes)

Any operation touching >1 row goes through a `SECURITY DEFINER` RPC. Never chain client-side Supabase calls — mid-flight failures leave the tenant inconsistent.

| RPC | Purpose | Status |
|---|---|---|
| `next_document_number(p_doc_type)` | Atomic, gap-free, per-tenant per-FY sequence | ✅ live |
| `record_payment(...)` | Lead → customer cascade + receipt voucher + subscription update | ✅ live |
| `generate_invoice(...)` | From paid quote → invoice with `IRN` placeholder | ✅ live |
| `compute_advance_adjustment(...)` | Advance receipts applied to invoices | ✅ live |
| `accept_quote(...)` | Convert lead/customer + seed subscription on accept-with-payment | ✅ live |
| `refund_payment(...)` | (Planned) refund + outstanding recompute | ⏳ pending |
| `renew_subscription(...)` | Roll subscription forward + create next-period quote | ✅ live (Piece B of renewal lifecycle) |
| `seed_demo_data(p_tenant_id)` | (Planned) creates sample customers/leads/quotes for new tenants | ⏳ pending |

Document numbering format: `{PREFIX}-{YYYY}-{YY}-{NNNN}` (e.g., `INV-2025-26-0001`). Prefixes: `INV` (tax invoice), `RV` (receipt voucher), `RFV` (refund voucher), `CN` (credit note), `DN` (debit note), `Q` (quote), `PO` (purchase order).

---

## 7. Module catalog (the 17 shipped modules)

### A. Core CRM

#### A1. Leads + Deals
- `/leads` shows raw inquiries (plan IS NULL) — triage queue
- `/deals` shows qualified opportunities (plan set) — sales pipeline
- Stages: `new` → `contact` → `demo` → `trial` → `quote` → `won` / `lost`
- Smart Views: All · Mine · Today · Hot · New · Won MTD
- Today Strip: leads added today + 5 hot leads + N quotes pending
- Pipeline Pulse: horizontal bar chart by stage × ₹ value
- Kanban (Deals only) + List (both) views, persisted in localStorage
- Lead Intelligence card: top hot lead suggestion with Call/Send nudge actions
- Bulk select + bulk actions (delete, assign, change stage)
- Hover row reveals Call / WhatsApp / Email inline buttons
- Smart cross-tab empty states ("All leads qualified → Go to Deals")
- Detail drawer with timeline + contact card + actions
- Deep-link via `?lead=<id>` for /buy page completions

#### A2. Tasks
- Lead-attached follow-ups + standalone tasks
- Due dates, priorities, assignees
- Today + Overdue + Upcoming widget on dashboard
- Bell badge in TopBar with count
- Dialog-based add from any lead drawer

#### A3. Customers
- Closed-won leads → customers via `record_payment` RPC
- Legal name, display name, GSTIN, primary domain
- Billing + shipping addresses (state_code auto-derived from GSTIN)
- Primary / billing / technical contacts (3 roles)
- GSTIN verification via Sandbox.co.in two-step token flow
- Auto-fill form from GST response
- Customer aging report integration

#### A4. Contacts
- Standalone contacts table (pre-lead, post-customer support contacts)
- Google CSV import (Google Contacts export format auto-detected)
- Google OAuth direct import (no CSV required)
- Promote contact → lead in one click

#### A5. Items catalog
- 2-tier pricing JSONB: `monthly` + `annual` tiers
- MSRP + wholesale per tier (gross margin auto-computed)
- Partner-visible flag for distributor → reseller sync
- "From your distributor" tab for reseller-tier tenants
- HSN code default 998313 (SaaS), overridable

### B. Revenue

#### B1. Quote builder
- 5 commitments × 2 tiers (10 pricing combinations)
- Line items array (JSONB) with rate, cost, per-line discount
- CGST + SGST split for intra-state (Maharashtra ↔ Maharashtra) vs IGST for inter-state (auto-derived from `customer.state_code` vs `tenant.state_code`)
- Prospect mode (quote from lead before customer record exists)
- Editable prospect details (company, contact, phone, email) sync back to lead on save
- Save as draft / send-as-PDF / accept-without-payment / send-with-online-pay-link
- Catalog match logic: exact → substring (handles fuzzy plan names)

#### B2. Quote send + PDF
- Server-rendered PDF via `@react-pdf/renderer`
- Multi-tenant branding (tenant logo + brand color in PDF)
- Send via email (Resend with Client A sender until resellersos.in is bought)
- Send via WhatsApp Business as document attachment (Gupshup BSP)
- Send audit log per quote (`activities` row)
- Public accept page at `/quote/[id]/accept` (no login required)
- Accept-with-payment (Razorpay) or accept-without-payment (manual settle)

#### B3. Invoices (GST-compliant)
- Generated from paid quote OR manually
- Number format `INV-YYYY-YY-NNNN` via `next_document_number`
- Partial invoice support (CGST §13(2)) — generate invoice on partial advance
- Advance adjustment computation (`compute_advance_adjustment` RPC)
- "Partial" status badge for invoices with advances applied
- PDF download with QR code placeholder (e-Invoice IRP integration pending)

#### B4. Payments + Receipt vouchers
- Razorpay test mode wired (per-tenant via Settings → Integrations)
- Production switch via env vars when KYC complete
- Receipt voucher (CGST §31(3)(d)) auto-generated on payment record
- Refund voucher (CGST §31(3)(e)) on refund
- TDS captured at payment time (deduction certificate optional)
- BuyNowDialog 2-col calculator layout for public buy pages
- Simulation mode for testing without real Razorpay

#### B5. Subscriptions
- One row per active customer subscription
- Domain field end-to-end (customer's GW/M365 domain tracked)
- Extension/top-up flow for N additional years
- Add Seats (pro-rata) for mid-term seat expansion
- Trial automation (Option B lifecycle): trial-started → trial-active → trial-expiring → converted/lost
- "Trials" section on Subscriptions page

#### B6. Renewals automation
- Cadence: T-30 (heads-up) → T-15 (renewal quote drafted + sent) → T-7 (final reminder) → T-0 (suspend with grace)
- Daily cron handler at `/api/cron/renewals` (called by Cloud Run scheduled job; protected by `CRON_SECRET`)
- Idempotent: same-day run doesn't duplicate
- Configurable grace period per tenant (default 7 days)
- "Renewal" tag on auto-generated renewal quotes
- Dashboard widget: morning visibility into next-30-day renewals
- On-demand "Generate quote" if cadence hasn't fired yet
- Email + WhatsApp reminder channels

#### B7. Online orders (Razorpay public)
- Public buy pages at `/buy/workspace`, `/buy/microsoft365`, `/buy/zoho`
- Coupon code system (per-product, per-tenant)
- Site Promos — auto-applied online sale system (e.g., 10% off all products this month)
- Post-purchase thank-you page at `/buy/<product>/thanks`
- Hides Buy now CTA when Razorpay isn't configured for tenant

### C. Accounting (full P&L layer)

#### C1. Vendor bills
- Bills from Google/Microsoft/Zoho (or upstream distributor)
- Manual upload + PO ↔ bill matching
- PO → Vendor bill pre-fill wizard
- Cross-tenant invoice → vendor bill auto-mirror (partner channel)

#### C2. Expenses
- Operational expense tracking
- Vendor + amount + category + GST credit eligibility

#### C3. P&L Report
- Revenue (paid invoices) − COGS (vendor bills) − Expenses = Gross profit
- Monthly + quarterly + annual views

#### C4. Customer Aging
- 0-30 / 31-60 / 61-90 / 90+ buckets
- Highlights overdue invoices needing follow-up

#### C5. Customer Margin (profitability)
- Per-customer revenue − per-customer COGS = margin
- Sortable by margin to identify high-value customers

#### C6. SaaS Metrics
- MRR (Monthly Recurring Revenue), ARR (× 12), Churn rate, LTV (Lifetime Value)
- Computed from active subscriptions + payment history

#### C7. GST Reports
- 3 sub-pages: Output Tax (sales), Input Tax Credit (purchases), Summary
- Filterable by period (monthly / quarterly / annual)
- HSN-wise breakdown for GSTR filing prep

#### C8. TDS Receivable (4-tab lifecycle)
- Tab 1: Pending (TDS deducted, certificate not yet received)
- Tab 2: Certificate received (Form 16A upload)
- Tab 3: Form 26AS reconciliation (year-end)
- Tab 4: Closed (reconciled or written off)

### D. Procurement

#### D1. Purchase Orders
- Raised to upstream vendors (Google/Microsoft/distributor)
- Auto-numbered (`PO-YYYY-YY-NNNN`)
- Line items + tax breakdown

#### D2. PO ↔ Vendor Bill matching
- Auto-suggest match by amount + vendor
- Pre-fill bill from selected PO
- Mismatch detection (over/under billing)

### E. Partner channel (distributor tier)

#### E1. Reseller hierarchy
- `tenants.reseller_tier` enum: `distributor` / `reseller`
- `tenants.parent_id` for child resellers under a distributor
- Settings → Company "Reseller Tier" card (read-only)

#### E2. Partner catalog
- Distributor marks items as "partner-visible"
- Child resellers see them in "From your distributor" tab on Items page
- Sync RPC prevents duplicate items

#### E3. Cross-tenant invoice → vendor bill mirror
- When distributor invoices a child reseller, child auto-receives a vendor bill
- `SECURITY DEFINER` RPC bypasses RLS in controlled way

#### E4. /partners aggregated page (distributor view)
- All child resellers' aggregate metrics
- Renewal sync alerts (parent inventory)

### F. Customer portal

#### F1. Magic-link auth
- `customer_portal_users` table separate from operator `users`
- Email-link login, no password
- RLS scoped to customer's data only

#### F2. Portal pages
- Dashboard (active subscriptions + outstanding invoices)
- Orders (purchase history)
- Invoices (download PDF, mark paid manually if offline)
- Subscriptions (renewal date visibility, request changes)
- Support tickets (create + reply)

### G. Engagement

#### G1. Campaigns
- Bulk email to filtered lead/customer audience
- AI-assisted HTML template designer (uses Gemini API stub when configured)
- Template library (newsletter, offer, renewal-reminder)
- Send audit log + per-recipient delivery status
- Persistent template selection in composer dropdown

#### G2. WhatsApp Business inbox
- Gupshup BSP integration
- Send messages (text + document attachments)
- Webhook for inbound + delivery status
- "Send quote as PDF" attached to WhatsApp message

#### G3. Email (Resend)
- Renewal reminders + quote-sent + welcome
- Stub mode when API key absent (logs to DB)
- Per-tenant from-address configurable

### H. Banking

#### H1. Bank accounts
- Multi-bank support: HDFC, ICICI, SBI, Axis, Kotak, IndusInd, Yes Bank (7 parsers)
- IFSC + account number + opening balance per account
- Reconcile drawer with exact / high / low confidence match pills

#### H2. CSV bank import
- Auto-detect bank from CSV header pattern
- Period suffix safe (handles HDFC "Withdrawal Amt.(INR)" quirk)
- Per-tenant historical statement archive

#### H3. Account Aggregator (Setu API)
- Mock-first wiring; flips to live with `SETU_*` env vars
- Consent init → callback → fetch flow
- Daily-sync cron handler ready

### I. Setup + Settings

#### I1. Setup Wizard
- One-time onboarding flow for new tenants
- Steps: company info → first customer → first quote → integrations
- Auto-hides from sidebar once complete

#### I2. Settings
- Company tab: GSTIN, state, brand color, logo
- Integrations tab: Razorpay test/prod keys, Resend key, Gupshup creds, Sandbox.co.in key
- Team tab: invite users, role assignment, permissions
- Renewals tab: grace period, cadence customization
- Billing tab: (planned) subscription tier of THIS tenant in ResellerOS itself

### J. GSTIN verification

#### J1. Real checksum validation
- Pure JS check-digit verification (no API call)
- 15-char alphanumeric format

#### J2. Sandbox.co.in API
- Two-step token flow (access + tracking ID)
- Mock fallback when no API key
- "Fill form from GST" auto-populate name, address, state_code
- Customer GSTIN verification + auto-fill in AddCustomerForm

### K. Mobile + PWA

#### K1. PWA manifest + install
- Custom icon (dynamic, no static assets needed)
- iOS apple-icon for Add-to-Home-Screen
- Install page at `/mobile` (also includes live preview iframe)

#### K2. Responsive foundation
- `useBreakpoint()` hook (SSR-safe)
- `<FAB>` floating action button (mobile-only by default)
- `<MobileBottomNav>` 5-section bottom tab bar
- `<DialogContent>` auto-switches between centered modal (desktop) and bottom sheet (mobile)

#### K3. Mobile-specific UX
- Card lists on 11+ pages (tables convert below md)
- Inline Call / WhatsApp / Email buttons on lead cards
- Swipe gestures on mobile lead cards (v2)
- Quick-add lead form (4 fields)
- Mobile contacts picker for Android PWA (uses native Contacts API)
- Draggable FAB with persisted position

### L. Public marketing + legal

#### L1. Marketing landing
- 9-section editorial page at `/`
- Hero with browser-frame dashboard mockup
- 4 alternating module showcases (Kanban, Quote builder, Renewal timeline, Banking) — all CSS-only
- Compact 8-module grid
- Founder section with editorial pull-quote
- Beta pricing teaser
- ?preview=1 query escape for signed-in operators

#### L2. Pricing page
- 3 tiers: Starter ₹999/mo · Growth ₹2,499/mo · Pro ₹6,999/mo
- Feature comparison table (6 groups, 25+ rows)
- 8 honest FAQ items
- Beta banner: "Free until 10 paying resellers"

#### L3. Privacy policy
- DPDP Act 2023 compliant
- 10 sections covering data collection, retention, sub-processors

#### L4. Terms of service
- 13 sections, Indian law + Mumbai jurisdiction
- Liability cap = 12 months fees

#### L5. About page
- Founder story (Pardeep at Client A, 12+ years reseller)
- Mission + dogfooding badge
- Company facts (legal entity, GCP Mumbai, DPDP compliant)

### M. Reports + Support

#### M1. Reports
- Sales leaderboard
- Recent activity timeline
- Pipeline value by stage

#### M2. Support module
- Internal ticket queue (operator-facing)
- Linked to customer portal tickets

### N. Internal dev

#### N1. /dev showcase
- Component library reference (non-prod gated)

#### N2. /mobile preview tab
- Live in-iframe phone view of the app

---

## 8. Indian market rules (compiled checklist)

| Rule | Implementation |
|---|---|
| Money in integer ₹ | All schemas; `rupee()` formatter in `lib/utils.ts` |
| Indian number format (lakh/crore) | `rupee(n, { compact: true })` → `₹4,90,644` |
| Date format `DD MMM YYYY` IST | `formatDate()` helper |
| Phone format `+91 98765 43210` | `formatPhone()` helper with space groupings |
| GSTIN format (15-char alphanumeric) | `isValidGstin()` checksum validation |
| HSN code for SaaS = 998313 | `items.hsn` default |
| GST rate 18% (CGST 9% + SGST 9% intra; IGST 18% inter) | Auto-computed from `customer.state_code` vs `tenant.state_code` |
| State codes (07 Delhi, 27 MH, etc.) | `STATE_CODES` map in utils |
| Document numbering per FY (Apr 1 → Mar 31) | `next_document_number` RPC |
| Receipt voucher per CGST §31(3)(d) | `record_payment` auto-generates |
| Refund voucher per CGST §31(3)(e) | (Pending in `refund_payment` RPC) |
| Credit/debit note per CGST §34 | Same numbering system |
| TDS at payment time | Captured in `record_payment` |
| Form 26AS reconciliation | TDS Phase 4 module |
| GST e-Invoice IRP (>₹5cr turnover) | Schema ready (`irn`, `qr_code` cols); GSP integration pending |
| DPDP Act 2023 — privacy policy public | `/privacy` page live |
| DPDP — data portability (export) | Pending (planned for Day 13) |
| DPDP — account deletion + retention | Pending |

---

## 9. Integrations

| Service | Status | Use |
|---|---|---|
| Supabase | ✅ Live (project `ontpnqjoysjgrlsukecm`) | Postgres + Auth + Storage |
| Razorpay | 🟡 Test mode | Payments; production needs KYC + live keys |
| Resend | 🟡 Wired, key pending | Email; needs `example.test` DNS verification |
| Gupshup BSP | ✅ Live (with WhatsApp credentials) | WhatsApp send + webhook |
| Setu AA | 🟡 Mock active | Bank account aggregator; needs Setu API keys |
| Sandbox.co.in | ✅ Live | GSTIN verification |
| Sentry | ✅ Live | Error tracking (chokepoint via `lib/sentry.ts`) |
| BetterStack | ✅ Live | Uptime monitoring + email alerts |
| Google Cloud Run | ✅ Live (asia-south1) | Hosting |
| ClearTax GSP / NIC IRP | ⏳ Not wired | GST e-Invoice (legally required >₹5cr) |
| Google Workspace Reseller API | ⏳ Not wired | Auto-provision GW seats (P3) |
| Microsoft Partner Center API | ⏳ Not wired | M365 auto-provision (P3) |
| Zoho Partner API | ⏳ Not wired | Zoho auto-provision (P3) |
| Gemini API | ⏳ Stubbed | AI campaign templates, future lead scoring |

---

## 10. Pricing + Monetization

### Beta period (current — until 10 paying customers OR 2026-09-01)

- Free for first 10 resellers
- All features unlocked
- Paid tiers visible at `/pricing` for transparency

### Tier structure (effective after beta)

| Tier | Monthly | Annual (2 months free) | Audience |
|---|---|---|---|
| Starter | ₹999 | ₹9,990 | Solo reseller, 1 user, 50 customers |
| Growth (most popular) | ₹2,499 | ₹24,990 | 2-10 employees, 5 users, 500 customers, all automation |
| Pro | ₹6,999 | ₹69,990 | Distributor / 10+ employees, unlimited, partner channel, white-label |

### Revenue model

- Subscription billing via Razorpay (live mode + recurring webhooks pending)
- 18% GST added at checkout
- Annual prepay discount built in (saves 2 months)
- Existing beta tenants get grandfathered 50% discount for 12 months after billing launches

---

## 11. Quality + Compliance (current state)

### Code quality

- TypeScript strict (`no any`, `no @ts-ignore`)
- ESLint + Prettier
- Pre-commit: `npm run typecheck && lint`
- Vitest unit tests (utilities)
- Playwright E2E (smoke, cross-tenant, lead-flow, role-permissions)
- GitHub Actions CI: typecheck + lint + smoke on every push

### Performance budgets (CLAUDE.md §12)

| Metric | Budget | Current |
|---|---|---|
| LCP | < 2.5s | Not measured (need Lighthouse CI) |
| FCP | < 1.5s | Not measured |
| CLS | < 0.1 | Not measured |
| Lighthouse Performance | > 90 | Not measured |
| Lighthouse Accessibility | > 95 | Not measured |
| Main bundle gzipped | < 200 KB | Not measured |

**Critical gap**: No automated performance enforcement. Lighthouse CI is a Tier-5 task in the gap analysis.

### Compliance

| Item | Status |
|---|---|
| DPDP Act 2023 — privacy policy public | ✅ |
| Privacy + Terms + About pages | ✅ |
| GST HSN 998313 compliance | ✅ |
| CGST §31 invoice numbering | ✅ |
| Multi-tenant RLS | ✅ |
| DPA template for B2B customers | ⏳ Pending |
| SOC 2 Type I prep | ⏳ Pending (premature at 0 customers) |
| Penetration test | ⏳ Pending (before first enterprise customer) |

---

## 12. Roadmap (90-day plan)

### Days 1-15 (June 2026) — Charge first ₹1

Goal: ResellerOS can accept money.

- ✅ Day 1: Privacy + Terms + About pages (DPDP compliant)
- ✅ Day 4a: Sentry error monitoring
- ✅ Day 4b: BetterStack uptime monitoring
- ✅ Day 5: Marketing landing redesign (visual v3 with mockups)
- ✅ Day 6: Pricing page with 3 tiers + comparison + FAQ
- ⏳ Day 7: Buy custom domain `resellersos.in`
- ⏳ Day 8: Email deliverability (Resend + Cloudflare DNS)
- ⏳ Day 9-11: Razorpay live mode + paywall enforcement
- ⏳ Day 12-14: GST e-Invoice IRP integration (via ClearTax GSP)
- ⏳ Day 13: Audit logs + data export tool
- ⏳ Day 15: Public status page (BetterStack hosted)

### Days 16-45 (July 2026) — First 5 paying customers

- Onboarding tour (react-joyride)
- Demo data seed (`seed_demo_data` RPC)
- Knowledge base seed (20 articles)
- DPA template (legal review)
- First case study (Client A itself)
- Cold outreach to ICP list (10 → 30 resellers)

### Days 46-90 (Aug 2026) — Scale to 20 customers

- Public REST API + webhooks (subscription events, payment events)
- Referral program
- AI features: lead scoring + quote suggestions (Gemini Flash)
- Storybook for design system
- Lighthouse 95+ enforcement in CI
- Account deletion + retention controls (DPDP)

### Days 91-180 (Sep-Nov 2026) — Enterprise readiness

- SOC 2 Type I prep (Vanta / Drata)
- SAML SSO (Pro tier)
- Native iOS/Android (Capacitor wrap)
- Security audit (penetration test)

See `docs/WORLD_CLASS_GAP_ANALYSIS.md` for the full 595-line gap analysis with effort + ROI per task.

---

## 13. Open decisions (current)

| # | Decision | Status |
|---|---|---|
| 1 | Domain registrar for `resellersos.in` | Bigrock recommended; Pardeep to buy |
| 2 | Razorpay live mode KYC timing | Schedule with Pardeep once business docs ready |
| 3 | GSP for e-Invoice IRP (ClearTax vs Sandbox.co.in vs direct NIC) | ClearTax recommended (~₹5K/mo) |
| 4 | DPA template source | SignDesk / Leegality / SaaS lawyer (~₹15-50K one-time) |
| 5 | Pricing tier launch trigger | 10 paying OR 2026-09-01, whichever first |
| 6 | Hindi i18n timing | Defer until 100+ paying customers |
| 7 | Native mobile app — Capacitor or React Native? | Capacitor (wraps existing PWA, less work) |
| 8 | AI provider for features (Gemini vs Claude vs OpenAI) | Gemini Flash (cost) for routine tasks; Claude/GPT for complex reasoning |
| 9 | First case study — Client A only or invite a friendly reseller? | Client A first (ground truth); external second |
| 10 | Knowledge base hosting (Mintlify / GitBook / Notion+Super) | Mintlify (free for OSS-style docs, fast) |

---

## 14. Future enhancements (out of 90-day scope)

- **Auto-draft email replies** using Gmail context + AI
- **Voice call logging** via Exotel / Knowlarity integration
- **Customer health score** with churn-risk playbooks
- **Slack + Microsoft Teams** outbound integrations
- **Zapier app** for marketplace presence
- **Multi-currency** (USD / EUR for international resellers' clients)
- **Native iOS/Android apps** (Capacitor)
- **Hindi UI** (next-intl already wired)
- **Composite PK migration** (quotes/POs/invoices — cross-tenant ID collision fix)
- **Public API + webhooks** for tenant integrations
- **Referral / affiliate program**
- **Storybook** design system documentation
- **A/B testing** infrastructure (PostHog / GrowthBook)
- **Lighthouse CI** automated performance enforcement

See `docs/WORLD_CLASS_GAP_ANALYSIS.md` for detailed effort estimates.

---

## 15. Glossary

| Term | Meaning |
|---|---|
| **AA** | Account Aggregator — RBI-regulated bank data sharing framework (Setu, Finvu, OneMoney) |
| **ARR** | Annual Recurring Revenue — MRR × 12 |
| **BSP** | Business Solution Provider (WhatsApp Business intermediary, e.g., Gupshup) |
| **CGST / SGST / IGST** | Central / State / Integrated GST. CGST+SGST for intra-state, IGST for inter-state |
| **Churn** | Customer cancellation rate (count or revenue) |
| **DPDP** | Digital Personal Data Protection Act 2023 (India's GDPR equivalent) |
| **GSP** | GST Suvidha Provider — authorized middleman for e-Invoice IRP submission |
| **GSTIN** | GST Identification Number — 15-char alphanumeric per business |
| **HSN** | Harmonized System of Nomenclature — GST product/service code (998313 = SaaS) |
| **IRN** | Invoice Reference Number — issued by NIC IRP upon e-Invoice submission |
| **ITC** | Input Tax Credit — GST paid on purchases, recoverable against output tax |
| **LTV** | Lifetime Value — revenue per customer over entire relationship |
| **MRR** | Monthly Recurring Revenue — sum of all active subscriptions' monthly value |
| **MSME** | Micro Small Medium Enterprises (Indian govt classification) |
| **NIC** | National Informatics Centre — runs India's e-Invoice IRP |
| **POC** | Proof of Concept (extended trial with specific use case) |
| **Reseller margin** | Commission % paid by Google/Microsoft/Zoho to authorized reseller |
| **RLS** | Row-Level Security — Postgres feature enforcing tenant isolation at DB layer |
| **SaaS metrics** | MRR, ARR, Churn, LTV, NRR — standard subscription business KPIs |
| **SKU** | Stock Keeping Unit — product variant (e.g., GW Starter / Standard / Plus) |
| **TDS** | Tax Deducted at Source — Indian withholding tax (recoverable via Form 26AS) |
| **Trial** | Free GW/M365/Zoho provisioning to prospect (typically 14 days) |

---

## 16. Maintenance + ownership

| Aspect | Owner |
|---|---|
| Product strategy + roadmap | Pardeep A |
| Architecture + database | Pardeep A + Claude (architect role) |
| Frontend + UX | Pardeep A + Claude |
| Indian compliance + GST nuances | Pardeep A (operator expertise) |
| Marketing + sales | Pardeep A |
| Customer success | Pardeep A (until first 10 customers) |
| Hosting + infrastructure | Cloud Run (autoscale) |
| DB hosting | Supabase (managed) |
| Error monitoring | Sentry (free tier 5K errors/mo) |
| Uptime monitoring | BetterStack (free tier 10 monitors) |

---

## 17. How this PRD is maintained

This PRD reflects the codebase at commit **`7e0bd49`** (2026-05-29). It is updated when:

1. A new major module is shipped (Phase rollup added)
2. A core architectural decision changes (tech stack pivot, multi-tenancy approach)
3. The roadmap pivots significantly
4. A previously-open decision is closed

For day-to-day task tracking, see **`PROJECT_TRACKER.md`** at repo root. For coding conventions and gotchas, see **`production/CLAUDE.md`**. For the brutal gap-vs-world-class assessment, see **`docs/WORLD_CLASS_GAP_ANALYSIS.md`**.

---

**End of PRD V3**
