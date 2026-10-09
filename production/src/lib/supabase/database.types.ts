/**
 * Database types — GENERATED shape + a thin hand-written overlay (S21, 28 Sep 2026).
 *
 *   database.generated.ts   `supabase gen types` output. NEVER edit by hand.
 *   database.types.ts       this file: what the generator can't express, and every
 *                           import stays `@/lib/supabase/database.types`.
 *
 * Pehle yeh file 5,500 lines haath se likhi thi — 32 tables missing the, isliye
 * `as any` / untyped clients. Ab table + column list DB se aati hai; yahan sirf:
 *   - ColumnPatches: text/jsonb columns jinka real shape DB nahi jaanta (CHECK wale
 *     unions, jsonb ke object shapes). Nullability DB wali hi rehti hai.
 *   - FunctionReturnPatches: jsonb/setof RPCs ka return shape.
 *   - named aliases (LeadRow, InvoiceRow…) jo pura codebase import karta hai.
 *
 * Regenerate after a migration:   node scripts/check-db-types.mjs --write
 * Check it is current (needs local docker):   node scripts/check-db-types.mjs
 */
import type { Database as GeneratedDatabase } from "./database.generated";

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ============================================================
// Standalone row interfaces (avoid circular references)
// ============================================================
/**
 * Cached GSTIN verification payload (provider-normalised).
 * Whatever the upstream API (Sandbox.co.in / ClearTax / NIC) returns, the
 * /api/gstin/verify route maps it onto this shape before persisting.
 */
export type GstinVerification = {
  status:            "Active" | "Cancelled" | "Suspended" | "Provisional" | "Inactive" | string;
  legal_name:        string | null;
  trade_name:        string | null;
  constitution:      string | null;            // Proprietorship / Pvt Ltd / Partnership / ...
  registration_type: string | null;            // Regular / Composition / SEZ / Casual / ...
  valid_from:        string | null;            // ISO date
  valid_upto:        string | null;            // ISO date (typically null for non-Casual)
  last_return_filed: string | null;            // ISO date or null
  jurisdiction:      string | null;
  state_code:        string | null;
  /** Principal place of business — structured form, ready to push into
   *  the Company form. Composed flat line is in `address` for one-shot
   *  textarea fills. */
  principal_address: {
    building:   string | null;
    street:     string | null;
    locality:   string | null;
    city:       string | null;
    district:   string | null;
    state:      string | null;
    pin_code:   string | null;
  } | null;
  address:           string | null;            // flat one-liner of principal_address
  source:            "sandbox" | "cleartax" | "nic" | "mock";
  raw?:              unknown;                  // original provider payload, for debugging
};

// Reseller hierarchy tier (migration 0040)
//   distributor → can have child tenants buying wholesale from it
//   reseller    → independent tenant OR child of a distributor (parent_tenant_id set)
export type TenantTier = "distributor" | "reseller";

type TenantRow = Tables<"tenants">;

// View exposed by migration 0040 — `tenants` joined with its parent's
// display-only fields. Backing view is `public.v_tenant_with_parent`.
export type TenantWithParent = {
  id: string;
  name: string;
  tier: TenantTier;
  parent_tenant_id: string | null;
  parent_name: string | null;
  parent_tier: TenantTier | null;
  parent_gstin: string | null;
};

// ============================================================
// tenant_secrets — owner-only credential storage (migration 0035)
// ============================================================
export type WhatsAppProvider = "meta" | "gupshup" | "twilio";

export type TenantSecretsRow = Tables<"tenant_secrets">;

// ============================================================
// team_invites — owner pre-authorizes an email to join the tenant (migration 0073)
// ============================================================
export type TeamInviteRole = "owner" | "manager" | "sales" | "sales_senior" | "billing" | "accountant" | "delivery" | "support";
export type TeamInviteRow = Tables<"team_invites">;

// ============================================================
// tenant_domains — which email domain belongs to which tenant (migration 0242)
//
// `verified_at` is the gate, not the row's existence: an unverified claim routes
// nobody. See the migration header for why (exceltechnologies.in is currently
// claimed by two accidentally-created tenants).
// ============================================================
export type TenantDomainRow = Tables<"tenant_domains">;

// ============================================================
// join_requests — someone waiting for an owner to let them in (migration 0242)
//
// Holds NO access of its own. Approving it is what creates the users row.
// ============================================================
export type JoinRequestStatus = "pending_approval" | "approved" | "rejected";
export type JoinRequestMatchedBy = "domain" | "manual";
export type JoinRequestRow = Tables<"join_requests">;

// ============================================================
// customer_domains — a customer can own many domains (migration 0074)
// ============================================================
export type CustomerDomainRow = Tables<"customer_domains">;

// ============================================================
// inbound_emails — inbound-email → lead audit + idempotency (migration 0069)
// ============================================================
/** What the router decided for a message (migration 0246). 'unknown' is only
 *  ever on rows that predate routing — the code never writes it. */
export type InboundEmailRoute = "sales" | "support" | "billing" | "ignored" | "unknown";

export type InboundEmailRow = Tables<"inbound_emails">;

// ============================================================
// api_keys — per-tenant keys for the public integration API (migration 0081)
// key_hash is NEVER selected client-side.
// ============================================================
export type ApiKeyRow = Tables<"api_keys">;

// ============================================================
// whatsapp_messages — conversation history (migration 0038)
// ============================================================
export type WhatsAppDirection = "inbound" | "outbound";
export type WhatsAppMessageType =
  | "text" | "template" | "image" | "document" | "video" | "audio"
  | "location" | "reaction" | "sticker" | "button" | "interactive" | "unsupported";
export type WhatsAppMessageStatus =
  | "pending" | "sent" | "delivered" | "read" | "failed" | "received";

export type WhatsAppMessageRow = Tables<"whatsapp_messages">;

// ============================================================
// Banking — bank_accounts + bank_transactions (migration 0048)
// ============================================================
export type BankAccountType =
  | "current" | "savings" | "overdraft" | "fixed_deposit" | "cash" | "other"
  | "credit_card";   // liability account — balance goes negative as you spend (0151)

export type BankTransactionSource =
  | "manual" | "csv_upload" | "api_fetch";

export type BankMatchToType =
  | "payment" | "project" | "expense" | "vendor_bill" | "transfer" | "salary" | "split" | "manual" | "statutory"
  | "prepaid"    // migration 20260925160000 — line funded a prepaid advance
  | "referral_commission";   // migration 20260927190000 — referral commission paid from this line

export type BankMatchConfidence =
  | "exact" | "high" | "low" | "manual";

/** Which layer decided a bank line's category. Mirrors the DB check constraint. */
export type TxnCategorySource = "rule" | "ai" | "manual";
/** Which side of the statement a rule may fire on. Mirrors the DB check constraint. */
export type TxnRuleDirection = "debit" | "credit" | "any";

type TxnCategoryRuleRow = Tables<"txn_category_rules">;

// AA connection (migration 0050)
export type BankAaProvider = "setu" | "finvu" | "onemoney";
export type BankAaStatus =
  | "initiated" | "pending_approval" | "active" | "expired" | "revoked" | "rejected" | "error";

// Suggestion row returned by suggest_bank_transaction_matches RPC
export type BankMatchSuggestionRow = {
  match_type:       "payment" | "project" | "expense" | "salary";
  match_id:         string;
  match_label:      string;
  match_amount:     number;
  match_date:       string;
  match_confidence: "exact" | "high" | "low";
};

type UserRow = Tables<"users">;

/** An additional person at a customer (migration 0164 — Zoho-style contact persons). */
export type ContactPerson = {
  salutation?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  designation?: string;
};

/** Separate shipping address (migration 0164). Billing stays the flat customer columns. */
export type ShippingAddress = {
  attention?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
};

/** Customer classification (migration 0165). Individuals have no company. */
export type CustomerType = "business" | "individual";

export type NotificationRow = Tables<"notifications">;

type CustomerRow = Tables<"customers">;

// Migration 0168 — Customer Groups / Parent Accounts. Umbrella linking multiple
// customer companies routed by one common reseller/coordinator. Reporting layer
// only — each member company keeps its own GSTIN + invoices.
type CustomerGroupRow = Tables<"customer_groups">;

/**
 * Per-commitment pricing for an item. Only 2 underlying prices — annual commit
 * has the SAME ₹/seat/month rate regardless of billing frequency (monthly invoice
 * vs single yearly invoice). The form shows 3 rows but row 2 (annual monthly bill)
 * and row 3 (annual yearly bill) bind to the same `annual` value.
 *
 *  - monthly — no commitment, monthly bill (highest rate, max flexibility)
 *  - annual  — 1-yr commit, ₹/seat/month (billed monthly OR yearly = same total)
 */
export type ItemPriceTier = "monthly" | "annual";
export type ItemPrices = Partial<Record<ItemPriceTier, { msrp: number; wholesale: number }>> & {
  /**
   * Real USD list price (USD per seat per MONTH) for international/export deals.
   * A SaaS product's USD price is its own number, NOT an INR→USD conversion
   * (e.g. Google Workspace ₹136/mo vs $7/mo). Optional — when set, USD quotes/
   * invoices use it; otherwise they fall back to converting the ₹ price.
   */
  usd?: { msrp: number; wholesale: number };
  /**
   * Seat-slab volume pricing — "1-10 seats ₹270, 11-50 ₹250, 51+ ₹230".
   * ₹/seat/MONTH like the tiers above. VOLUME pricing (one rate for all seats),
   * deliberately not graduated — see lib/quotes/volume-tiers.ts for why that
   * distinction is a money decision and not a detail.
   * Absent on most rows; `slabPricing()` falls back to the flat tiers.
   */
  slabs?: Array<{ minSeats: number; maxSeats: number | null; msrp: number; wholesale: number }>;
};

type ItemRow = Tables<"items">;

/** Row returned by get_partner_metrics() RPC (migration 0044). */
export type PartnerMetricsRow = {
  tenant_id:            string;
  tenant_name:          string;
  tenant_gstin:         string | null;
  active_subscriptions: number;
  total_seats_sold:     number;
  mrr:                  number;
  invoiced_this_month:  number;
  paid_this_month:      number;
  renewals_due_30d:     number;
  renewal_revenue_30d:  number;
  last_invoice_date:    string | null;
};

/** Row returned by get_partner_catalog() RPC (migration 0041). */
export type PartnerCatalogRow = {
  id: string;
  tenant_id: string;
  name: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  kind: "main" | "addon";
  hsn: string | null;
  msrp: number;
  partner_price: number | null;
  prices: ItemPrices;
  is_active: boolean;
  /** True when the calling child tenant already has a row with synced_from_partner_id = this row's id. */
  already_synced: boolean;
};

export type LeadPriority = "low" | "medium" | "high";

type LeadRow = Tables<"leads">;

/**
 * A line's PRICE TIER. Since migration 0161, invoice frequency lives in the
 * quote-level `billing_cycle` — a line's `commitment` now only distinguishes
 * flex-monthly pricing from annual-commit pricing. New quotes write just two
 * values: "monthly" (flex) or "annual_yearly" (annual price tier). The
 * annual_monthly/quarterly/half_yearly variants are legacy (pre-0161) and are
 * still read/tolerated — record_payment's "make a subscription?" gate keys off
 * `commitment is distinct from 'monthly'`, which holds for all annual_* values.
 *  - monthly            — flex, no commitment (its own price tier)
 *  - annual_yearly      — annual commitment price tier (default)
 *  - annual_* (legacy)  — annual price tier; frequency now in quote.billing_cycle
 */
export type LineCommitment =
  | "monthly"
  | "annual_monthly"
  | "annual_quarterly"
  | "annual_half_yearly"
  | "annual_yearly";

/**
 * Quote-level BILLING CYCLE = how often invoices are raised through the year.
 * Migration 0161 made this independent of a line's `commitment` (which is now
 * the PRICE TIER: monthly-flex vs annual). A flex-monthly line forces the whole
 * quote to 'monthly'. Frequency is a stated schedule/label today — it does not
 * yet auto-generate N invoices/yr (that's a separate future feature).
 */
export type BillingCycle = "monthly" | "quarterly" | "half_yearly" | "yearly";

/** Invoices raised per year for each billing cycle. */
export const BILLING_CYCLE_INVOICES_PER_YEAR: Record<BillingCycle, number> = {
  yearly: 1, half_yearly: 2, quarterly: 4, monthly: 12,
};

export type QuoteLineItem = {
  id: string;        // local UUID for React keys
  item_id?: string;  // FK to items table (optional — only if from catalog)
  name: string;
  description?: string;
  qty: number;
  rate: number;          // ₹ per seat per YEAR on an annual_* line, per MONTH on a "monthly" (flex) line — R-369, lib/quotes/line-rate-unit.ts (the negotiated SELLING price)
  /** ₹ per seat (same unit as `rate`) — the LIST price captured when the line was added (catalog MSRP,
   *  or the first rate entered for a custom item). Frozen; editing `rate` below this
   *  surfaces the difference as the customer's discount. Falls back to `rate` if unset. */
  list_rate?: number;
  cost: number;          // ₹ per seat wholesale, same unit as `rate` (for margin calc)
  commitment?: LineCommitment;  // billing/commitment tier (default "annual_yearly")
  /** Service start date (YYYY-MM-DD). Blank ⇒ subscription starts on payment date.
   *  When set, record_payment uses it as the subscription start (renewal = start + term). */
  start_date?: string;
  /** Reseller-given discount on THIS line (0–50%). Comes out of reseller margin, NOT Google wholesale. */
  discount_pct?: number;
  /** Optional reason shown on quote PDF + accept page (e.g., "Loyalty discount", "Volume offer"). */
  discount_reason?: string;
  /**
   * HSN/SAC printed on this line of a tax invoice (R-010, CGST Rule 46(f)).
   *
   * OPTIONAL, and the default is the point: every SaaS line in this product is SAC 998313,
   * so the documents fall back to `SAAS_HSN` and nothing has to carry it. A PROJECT
   * invoice does — `raise_project_milestone_invoice` writes the project's own
   * `project_sales.sac_code` (998314, IT design and development) here, because a
   * development contract is not a SaaS subscription and must not inherit its code.
   */
  hsn?: string;
  /** BULK ORDER: when true, this one line expands into one subscription PER domain on payment. */
  bulk?: boolean;
  /** Per-domain breakdown for a bulk line. `qty` must equal the sum of these seats. */
  domains?: Array<{ domain: string; seats: number }>;
  /** Domain registration lines only: years paid for, 1–10 (R-031). Absent → 1. The
   *  register-domains cron registers for exactly this term. */
  years?: number;
  /** Optional domain this subscription is provisioned against (Google Workspace /
   *  M365 / Zoho). Per-line because a quote can hold products for different domains. */
  domain?: string | null;
  // Customer-adjustable quote (lib/quotes/configure.ts) ─────────────────────
  /** The customer may tick this line on or off on the public quote page. */
  optional?: boolean;
  /** For an optional line: is it ticked when the page first loads? */
  included_by_default?: boolean;
  /** The customer may change the seat count on the public quote page. */
  seats_adjustable?: boolean;
  /** Bounds for that change. Absent → a sensible default around the quoted qty. */
  min_seats?: number;
  max_seats?: number;
};

type QuoteRow = Tables<"quotes">;

/**
 * A click-to-sign acknowledgement on the public quote page.
 *
 * Evidence of assent — NOT a digital signature under the IT Act 2000, which needs a
 * DSC from a licensed CA. See migration 20260816113000 for why that distinction is
 * written down rather than assumed.
 */
type QuoteSignatureRow = Tables<"quote_signatures">;
/**
 * One dunning message per overdue invoice.
 *
 * Separate from renewal_email_log on purpose: that counts DOWN to a renewal, this
 * counts UP from a due date, and a customer can be current on one and late on the
 * other. See migration 20260816114500.
 */

/**
 * Seats to be created at a vendor once a quote is paid.
 *
 * Raised by trg_quotes_raise_provisioning as ONE unresolved row per paid quote (vendor
 * / plan / seats all null); the app expands it per line with lib/provisioning/plan.ts.
 * No vendor API is connected on this project, so every task is mode='manual'.
 */
type ProvisioningTaskRow = Tables<"provisioning_tasks">;
/**
 * A customer asking for a seat change, as data rather than as prose in a ticket.
 * See migration 20260816150000 for why this is not a support_tickets row.
 */
type SeatRequestRow = Tables<"seat_requests">;
/**
 * One customer's MRR for one month. The history NRR is computed from — nothing else
 * in this schema records what MRR WAS. Grain is the CUSTOMER, so a plan swap is not
 * a churn plus a new customer. See migration 20260816160000.
 */
type MrrSnapshotRow = Tables<"mrr_snapshots">;
/**
 * An append-only record of a change to a subscription's commercial terms.
 *
 * `Insert` and `Update` are `never` on purpose: rows arrive only from
 * trg_subscriptions_record_amendment, and the table refuses edits outright. Typing
 * them as writable would offer the app a door Postgres has already bricked up.
 * See migration 20260816170000.
 */
/* R-489: actor_label (20261007040000) is in the generated Row now; kept OPTIONAL here so a
   reader written for a DB without the column (lib/subscriptions/amendments.ts) still types. */
type ContractAmendmentRow = Omit<Tables<"contract_amendments">, "actor_label"> & { actor_label?: string | null };

/**
 * A customer's standing permission to be debited (UPI Autopay / e-NACH).
 *
 *  is written ONLY by the signature-verified Razorpay webhook.
 * See migration 20260817090000 for why the app has no path to it.
 */
type PaymentMandateRow = Tables<"payment_mandates">;
type PaymentMandateInsert = TablesInsert<"payment_mandates">;

/**
 * One instalment of a subscription term (migration 20260817110000).
 *
 * `invoice_id` null means "due, not yet raised" — that IS the state machine. The
 * unique key (subscription_id, term_start, period_index) is what stops the daily
 * billing cron invoicing the same period twice.
 */
type SubscriptionBillingRow = Tables<"subscription_billings">;
type SubscriptionBillingInsert = TablesInsert<"subscription_billings">;

/**
 * Single entry in the adjusted_advances jsonb array on an invoice.
 * Snapshot of a Receipt Voucher payment that was applied against this invoice
 * at issue time. Frozen — never edited; later refunds become credit notes.
 */
export type InvoiceAdvanceAdjustment = {
  payment_id:  string;         // uuid of payments row
  voucher_no:  string | null;  // RV-2025-26-NNNN (null for legacy un-numbered)
  amount:      number;         // ₹ (paise once #103 lands)
  received_at: string;         // ISO timestamp
  method:      "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";
};

type InvoiceRow = Tables<"invoices">;

export type RenewalState =
  | "pending"
  /** T-30 early heads-up. Added to the DB enum by migration 0228 — this union
   *  mirrors `public.renewal_state`, so it must not list a value the enum lacks. */
  | "early_notice"
  | "notice_sent"
  | "reminder_1"
  | "reminder_2"
  | "reminder_3"
  | "reminder_4"
  | "final_sent"
  | "grace_period"
  | "renewed"
  | "suspended";

type SubscriptionRow = Tables<"subscriptions">;

// ============================================================
// Payments — multiple per quote (partial / installments / refunds)
// ============================================================
export type PaymentMethod = "upi" | "razorpay" | "bank_transfer" | "cheque" | "cash" | "other";

type PaymentRow = Tables<"payments">;

// ============================================================
// Tasks — follow-up to-dos for sales reps (per migration 0007)
// ============================================================
export type TaskStatus = "pending" | "done" | "snoozed" | "cancelled";
export type TaskKind   = "call" | "email" | "meeting" | "followup" | "custom";

type TaskRow = Tables<"tasks">;

// ============================================================
// Renewal email log (migration 0008) — audit of every renewal cadence email
// ============================================================
/** Migration 0229 — one row per statutory reminder actually sent. */

// ============================================================
// Migration 0231 — gamified task collaboration
// ============================================================
/**
 * Co-workers on a shared task. A join table rather than a `uuid[]` on `tasks`,
 * because kudos and join-time attach per collaborator and an array can hold
 * neither a foreign key nor per-row state.
 */

/** Discussion thread on a task, with @mention targets and an optional file. */

/**
 * Peer kudos (+10 pts) on a shared task.
 *
 * Rows rather than a counter: the per-giver budget and the "kudos from 3+
 * different people" badge both need the individual awards. `awarded_by` is NOT
 * NULL — an unattributed kudos cannot be budgeted, and the tally rejects it.
 * DB constraints enforce one per (task, recipient, giver) and no self-kudos.
 */

// ============================================================
// Quote send log (migration 0009) — audit of every quote email sent
// ============================================================

// ============================================================
// Accounting — vendor_bills + expenses (migration 0013)
// ============================================================
export type VendorBillLine = {
  id?:    string;
  name:   string;
  qty?:   number;
  rate?:  number;
  amount: number;
};
export type VendorBillRow = Tables<"vendor_bills">;
// Vendors master (migration 0134)
export type VendorRow = Tables<"vendors">;

export type ExpenseRow = Tables<"expenses">;

// ============================================================
// Balance sheet manual lines (migration 0084)
// ============================================================
export type BalanceSheetSection = "asset" | "liability" | "equity";

// Employee loans / advances (migration 0085). A loan is an asset, not an expense.
type EmployeeLoanKind = "loan" | "salary_advance" | "expense_advance";

// Payroll + leave (migration 0087).

// ── Company property with an employee — migration 20260927240000 ─────────────

// ── Google Business Profile — migration 20260927250000 (server-written) ──────

// ── Ad platforms (Google Ads / Meta Ads) — migration 20260927260000 (server-written) ──

// ── AI Lead Finder — migration 20260927270000 ──────────────────────────────

export type ReimbursementRow = Tables<"reimbursements">;

type LeaveKind = "casual" | "sick" | "earned" | "unpaid";

// ── Project / one-time sales (custom software etc.) — migration 0101 ──────────
export type ProjectSaleRow = Tables<"project_sales">;
export type ProjectQuoteLine = { name: string; qty: number; rate: number; amount: number };

// ── Project labour allocation (migration 0193) — employee time as project cost ──
export type ProjectLabourRow = Tables<"project_labour">;

// ── Project task roadmap — migration 0214 ────────────────────────────────────
export type ProjectTaskStatus = "todo" | "in_progress" | "done";
export type ProjectTaskRow = Tables<"project_tasks">;

// ── Company Document Vault — migration 0107 ──────────────────────────────────
export type DocumentCategory = "legal" | "finance" | "hr" | "operations" | "sales_marketing" | "admin" | "branding" | "other";
export type DocumentRow = Tables<"documents">;

export type ProjectMilestoneRow = Tables<"project_milestones">;

export type ProjectPaymentRow = Tables<"project_payments">;

type StatutoryDuesKind = "tds" | "pf" | "esi" | "mixed";

// ── Month-end close checklist — migration 20260927200000 ─────────────────────

// GST + income-tax payments booked from bank lines (migration 20260925140000).
// Separate from statutory_dues_payments so TDS/PF/ESI totals never include GST.
export type TaxPaymentKind = "gst" | "advance_tax" | "self_assessment_tax";

// Customer advance credit — money received over the expected amount (migration 0141).
export type CustomerCreditRow = Tables<"customer_credits">;

// Credit Note (CGST §34) — reduces a previously-issued invoice. Migration 0154.
export type CreditNoteReasonCode = "overbilling" | "seats_reduced" | "discount" | "cancellation" | "return" | "other";
export type CreditNoteRow = Tables<"credit_notes">;

// Debit Note (CGST §34) — the mirror of a credit note; increases an invoice. Migration 0155.
export type DebitNoteReasonCode = "undercharge" | "additional_charge" | "price_escalation" | "other";
export type DebitNoteRow = Tables<"debit_notes">;

// ── Referral / channel-partner commissions (migration 0156) ──────────────────
export type CommissionBasis = "percent" | "fixed";
export type CommissionScope = "one_time" | "recurring";

export type ReferralPartnerRow = Tables<"referral_partners">;

export type ReferralAgreementRow = Tables<"referral_agreements">;

export type ReferralCommissionRow = Tables<"referral_commissions">;

// Company holiday calendar (migration 0143) — excluded from payroll working days.
export type HolidayRow = Tables<"holidays">;

// Attendance (migration 0088).

// Activity log (migration 0222).

// Assets bought on EMI (migration 0092).

// ── Fixed asset register — migration 20260927230000 ───────────────────────────

/* Migration 20260819170000 — the owner's PRIVATE books.
   Every one of these is scoped by RLS to `owner_user_id = auth.uid()`, not to the
   tenant and not to the owner role. Read the migration header before changing that. */



/* Migration 20260821140000 — one attendance reminder per person per day per kind.
   The unique index on (user_id, work_date, kind) is the point of the table: it makes a
   Scheduler retry, an overlapping deploy and a half-hourly cron all harmless. Written by
   the cron under the service role only — RLS is on with no policies. */

/* Migration 20260821120000 + 20260821123000 — Web Push subscriptions.
   One row per DEVICE: `endpoint` is unique, so re-subscribing updates instead of adding
   a second row (a phone with two rows receives every notification twice). `categories`
   is the consent split — one browser permission covers offers and work alerts alike, so
   the difference has to live in our data. */

/* Migration 20260819120000 — internal feedback + its machine triage.
   Deliberately not support_tickets: that table carries a customer SLA clock. */

// Business loans TAKEN by the company (migration 0131)
export type BusinessLoanRow = Tables<"business_loans">;

export type BusinessLoanPaymentRow = Tables<"business_loan_payments">;

// ============================================================
// TDS Receivable (migration 0014)
// ============================================================
export type TdsStatus =
  | "pending_cert"
  | "cert_received"
  | "verified_26as"
  | "claimed"
  | "disputed"
  | "written_off";

export type TdsReceivableRow = Tables<"tds_receivable">;

// ============================================================
// Customer Portal Auth (migration 0016)
// ============================================================
export type CustomerUserRow = Tables<"customer_users">;

// ============================================================
// Support tickets (migration 0017)
// ============================================================
export type SupportTicketStatus =
  | "open"
  | "in_progress"
  | "awaiting_customer"
  | "resolved"
  | "closed";

export type SupportTicketCategory =
  | "billing"
  | "tech"
  | "plan_change"
  | "feature"
  | "other";

export type SupportTicketPriority = "low" | "normal" | "high" | "urgent";

export type SupportTicketRow = Tables<"support_tickets">;

/**
 * Agent tooling on a support ticket (migration 20260907120000 — DSP-merge
 * brick 1). Notes and time logs are APPEND-ONLY for authenticated: RLS carries
 * no update/delete policy, so Update types exist only for service_role paths.
 */
export type SupportTicketNoteRow = Tables<"support_ticket_notes">;

export type SupportTicketTimeLogRow = Tables<"support_ticket_time_logs">;

export type SupportCannedResponseRow = Tables<"support_canned_responses">;

/**
 * CSAT: the customer's one verdict on a finished ticket (migration
 * 20260907150000 — DSP-merge brick 3). Insert is the PORTAL customer's alone
 * (RLS gates on current_customer_id + resolved/closed); nobody updates it.
 */
export type SupportTicketRatingRow = Tables<"support_ticket_ratings">;

/**
 * A customer asking for a live 1-on-1 call (migration 20260817180000).
 *
 * `meet_url` is NULL until a REAL Google Meet link exists. A meeting code can only be
 * issued by Google, through the Calendar API — one generated locally produces a link
 * that looks right and is dead, and everybody believes the call is booked until the
 * moment it fails, which is the moment of the call.
 */
export type SupportCallRequestRow = Tables<"support_call_requests">;

// ============================================================
// Purchase Orders — procurement / buy-side (migration 0022)
// ============================================================
export type PurchaseOrderStatus =
  | "draft"          // auto-created when sub spawns; not yet placed
  | "placed"         // ordered from vendor (Google CSP, MS Partner, Zoho)
  | "provisioned"    // licenses live on customer's domain
  | "closed"         // billed by vendor, fully reconciled
  | "cancelled";

export type PurchaseOrderRow = Tables<"purchase_orders">;

// ============================================================
// PO ↔ Vendor Bill allocations (migration 0024)
// ============================================================
export type PoBillAllocationRow = Tables<"po_bill_allocations">;

// ============================================================
// Campaigns — bulk email broadcasts to leads (migration 0028)
// ============================================================
export type CampaignStatus = "draft" | "sending" | "sent" | "failed" | "cancelled";

export type CampaignRow = Tables<"campaigns">;

export type CampaignSendStatus = "pending" | "sent" | "failed" | "skipped" | "stubbed";

export type CampaignSendRow = Tables<"campaign_sends">;

// ── campaign_templates (migration 0029) ─────────────────────────
export type CampaignTemplateCategory =
  | "newsletter" | "offer" | "winback" | "onboarding" | "custom";

export type CampaignTemplateRow = Tables<"campaign_templates">;

// ============================================================
// Contacts — standalone directory (migration 0030)
// ============================================================
export type ContactSource     = "manual" | "google_csv" | "google_api" | "outlook" | "linkedin" | "event" | "other" | "enquiry";
export type ContactStatus     = "pending" | "engaged" | "promoted" | "archived";

/** One email/phone entry on a contact. label ∈ mobile|work|home|other. */
export type ContactChannel = { value: string; label: string };

export type ContactRow = Tables<"contacts">;
/**
 * Which PEOPLE serve which CUSTOMERS — migration 20260918090000.
 *
 * A contact can be linked to several customers (an IT consultant looking after three of
 * them, say), so `role` and `is_primary` live on the LINK, not on the person: the same
 * human can be the accountant for one customer and the owner of another. The primary is
 * who receives that customer's invoices and payment reminders.
 *
 * `contacts.customer_id` / `.is_primary` are the legacy single-customer columns and are
 * NOT the source of truth any more — see the comments on those columns.
 */
export type CustomerContactRow = Tables<"customer_contacts">;
export type CustomerContactInsert = TablesInsert<"customer_contacts">;

// Birthday / anniversary greeting audit + idempotency (migration 0199).
export type ContactGreetingLogRow = Tables<"contact_greeting_log">;

// Prepaid / vendor advances (migration 0205).
export type PrepaidAdvanceRow = Tables<"prepaid_advances">;

// Employee reasoning assessments (migration 0207).
export type AssessmentRow = Tables<"assessments">;

export type AssessmentAttemptRow = Tables<"assessment_attempts">;

// Statutory-compliance filing log (migration 0201).
export type ComplianceLogRow = Tables<"compliance_log">;

// Inbound purchase capture — Amazon & co. order emails staged for review (migration 0200).
export type InboundPurchaseItem = { name: string; qty: number; amount: number };
export type InboundPurchaseRow = Tables<"inbound_purchases">;

// ── Per-user Google OAuth tokens (Contacts sync, migration 0190) ────────────
export type UserGoogleTokenRow = Tables<"user_google_tokens">;

// ── App person ↔ Google resourceName link (migration 0191) ──────────────────
export type GoogleContactLinkRow = Tables<"google_contact_links">;

// ============================================================
// Coupons — public buy-page promo codes (migration 0031)
// ============================================================
export type CouponDiscountType = "percent" | "flat";

export type CouponRow = Tables<"coupons">;

export type CouponRedemptionRow = Tables<"coupon_redemptions">;

// ============================================================
// Site Promos — public buy-page automatic sales (migration 0032)
// Pardeep enables one; the buy page auto-discounts and shows a
// big banner — no code required. Stacks below Google promo, above
// any visitor-entered coupon code.
// ============================================================
export type SitePromoBannerStyle = "amber" | "rose" | "emerald" | "indigo" | "ink";

export type SitePromoRow = Tables<"site_promos">;

/**
 * document_series — the per-tenant, per-fiscal-year GST document counters
 * (CLAUDE.md §17a). In the database since migration 0054 and absent from this file
 * until 23 Aug 2026, so the invoice-issue confirmation could not read `last_number` to
 * predict the next number without a cast — and AGENTS.md L5 is about exactly that: a
 * cast added to get one table through stops checking everything else in the call.
 *
 * Application code only READS this. `next_document_number()` is the sole allocator and
 * `set_document_series_start()` the sole way to move the counter, so an Update type
 * exists for structural completeness rather than as an invitation.
 */
export type DocumentSeriesRow = Tables<"document_series">;
export type DocumentSeriesInsert = TablesInsert<"document_series">;

// ============================================================
// Database type (the shape supabase-js expects)
// ============================================================
type Gen = GeneratedDatabase["public"];

type Pick2<M, K, D = never> = K extends keyof M ? M[K] : D;

/**
 * Column ka type narrow karo (ColumnPatches), par nullability DB wali rakho — DB null
 * allow kare to null bhi. RowNotNull wale columns Row me null-free rehte hain (neeche dekho).
 */
type PatchInsert<T, P> = { [K in keyof T]: K extends keyof P ? P[K] | Extract<T[K], null> : T[K] };
type PatchRow<T, P, NN> = {
  [K in keyof T]: K extends NN
    ? Exclude<K extends keyof P ? P[K] : T[K], null>
    : K extends keyof P ? P[K] | Extract<T[K], null> : T[K];
};

type PatchedTables = {
  [T in keyof Gen["Tables"]]: T extends keyof ColumnPatches | keyof RowNotNull
    ? {
        Row: PatchRow<Gen["Tables"][T]["Row"], Pick2<ColumnPatches, T, {}>, Pick2<RowNotNull, T>>;
        Insert: PatchInsert<Gen["Tables"][T]["Insert"], Pick2<ColumnPatches, T, {}>>;
        Update: PatchInsert<Gen["Tables"][T]["Update"], Pick2<ColumnPatches, T, {}>>;
        Relationships: Gen["Tables"][T]["Relationships"];
      }
    : Gen["Tables"][T];
};

/** SQL function ka har arg null le sakta hai; generator yeh nahi likhta, isliye jo code null bhejta hai unhe `| null`. */
type NullableArgs<A, N> = { [K in keyof A]: K extends N ? A[K] | null : A[K] };
type PatchedFunctions = {
  [F in keyof Gen["Functions"]]: F extends keyof FunctionReturnPatches | keyof ArgNullable
    ? {
        Args: NullableArgs<Gen["Functions"][F]["Args"], Pick2<ArgNullable, F>>;
        Returns: F extends keyof FunctionReturnPatches ? FunctionReturnPatches[F] : Gen["Functions"][F]["Returns"];
      }
    : Gen["Functions"][F];
};

export type Database = {
  public: {
    Tables: PatchedTables;
    Views: Gen["Views"];
    Functions: PatchedFunctions;
    Enums: Gen["Enums"];
    CompositeTypes: Gen["CompositeTypes"];
  };
};

type PublicTables = Database["public"]["Tables"];
type PublicViews = Database["public"]["Views"];
/** Row of a table (or view): `Tables<"leads">`. Same name as the generator's helper. */
export type Tables<T extends keyof PublicTables | keyof PublicViews> =
  T extends keyof PublicTables ? PublicTables[T]["Row"] : T extends keyof PublicViews ? PublicViews[T]["Row"] : never;
export type TablesInsert<T extends keyof PublicTables> = PublicTables[T]["Insert"];
export type TablesUpdate<T extends keyof PublicTables> = PublicTables[T]["Update"];
export type Enums<E extends keyof Database["public"]["Enums"]> = Database["public"]["Enums"][E];

/* Overlay ki chaabiyan DB me honi chahiye. Mapped types galat key ko CHUP-CHAAP chhod dete
   hain — column rename/drop ke baad patch bina error ke lagna band ho jata. Ye constraint
   tsc ko laal karta hai; error me jo naam dikhe wo overlay se hatao/badlo. */
type MustBeNever<T extends never> = T;
type GenRowKeys<T> = T extends keyof Gen["Tables"] ? keyof Gen["Tables"][T]["Row"] : never;
export type OverlayCheck = [
  MustBeNever<Exclude<keyof ColumnPatches | keyof RowNotNull, keyof Gen["Tables"]>>,
  MustBeNever<{ [T in keyof ColumnPatches]: Exclude<keyof ColumnPatches[T], GenRowKeys<T>> }[keyof ColumnPatches]>,
  MustBeNever<{ [T in keyof RowNotNull]: Exclude<RowNotNull[T], GenRowKeys<T>> }[keyof RowNotNull]>,
  MustBeNever<Exclude<keyof FunctionReturnPatches | keyof ArgNullable, keyof Gen["Functions"]>>,
];

// ── Overlay: jo generator nahi bata sakta ──────────────────────
// Har entry ek text/jsonb column hai jiska asli shape CHECK constraint ya app code
// tay karta hai. Naya column? Pehle generated type chalao; patch tabhi jab narrow chahiye.

type ColumnPatches = {
  tenants: {
    gstin_verification: GstinVerification | null;
    tier: TenantTier;
    email_provider: "resend" | "gmail";
  };
  customers: {
    customer_type: CustomerType;
    contact_persons: ContactPerson[];
    shipping_address: ShippingAddress | null;
    gstin_verification: GstinVerification | null;
  };
  items: {
    kind: "main" | "addon";
    item_type: "subscription" | "one_time";
    covered_product: "google" | "microsoft" | "zoho" | "hosting" | "domain" | "other" | "all" | null;
    prices: ItemPrices;
  };
  leads: {
    enquiry_type: "subscription" | "project";
    junk_reason: "fake_phone" | "spam_email" | "not_commercial" | "unresponsive" | "other" | null;
    priority: LeadPriority;
    subscription_type: "fresh" | "switch" | null;
    /* R-071 (migration 20260930200000): leads_billing_cycle_check. Descriptive only —
       leads.value stays the ANNUAL deal value whatever this says. */
    billing_cycle: "monthly" | "yearly" | null;
  };
  quotes: {
    line_items: QuoteLineItem[];
    billing_cycle: BillingCycle;
  };
  quote_signatures: {
    signer_ip: string | null;
    signed_snapshot: {
        subtotal?: number;
        total?: number;
        lines?: Array<{ name: string; qty: number; rate: number }>;
        changed?: boolean;
      };
  };
  contract_amendments: {
    changes: Record<string, { from: unknown; to: unknown }>;
  };
  invoices: {
    adjusted_advances: InvoiceAdvanceAdjustment[];
    line_items: QuoteLineItem[] | null;
  };
  payments: {
    method: PaymentMethod;
    status: "received" | "refunded";
  };
  inbound_emails: {
    route: InboundEmailRoute;
  };
  renewal_email_log: {
    status: "sent" | "stubbed" | "failed" | "skipped";
  };
  compliance_reminder_log: {
    status: "sent" | "stubbed" | "failed" | "skipped";
  };
  quote_send_log: {
    status: "sent" | "stubbed" | "failed";
  };
  vendors: {
    msme_category: "micro" | "small" | "medium" | null;
  };
  vendor_bills: {
    line_items: VendorBillLine[];
  };
  expenses: {
    line_items: VendorBillLine[];
  };
  balance_sheet_items: {
    section: BalanceSheetSection;
  };
  employee_loans: {
    kind: EmployeeLoanKind;
    status: "active" | "closed";
  };
  employee_loan_repayments: {
    method: "cash" | "bank" | "salary_deduction" | "expense";
  };
  lead_finder_runs: {
    trigger: "manual" | "cron";
  };
  lead_finder_candidates: {
    status: "new" | "approved" | "rejected" | "converted";
  };
  ad_accounts: {
    platform: "google-ads" | "meta-ads";
  };
  ad_sync_runs: {
    trigger: "manual" | "cron" | "connect";
  };
  gbp_sync_runs: {
    trigger: "manual" | "cron" | "connect";
  };
  employee_assets: {
    kind: "laptop" | "phone" | "sim" | "id_card" | "keys" | "access" | "vehicle" | "document" | "other";
    return_condition: "ok" | "damaged" | "lost" | "revoked" | null;
  };
  reimbursements: {
    status: "pending" | "settled";
  };
  leave_entries: {
    type: LeaveKind;
  };
  salary_payments: {
    paid_status: "unpaid" | "partial" | "paid";
  };
  project_sales: {
    status: "draft" | "quoted" | "active" | "completed" | "cancelled";
    line_items: ProjectQuoteLine[];
  };
  project_milestones: {
    status: "pending" | "invoiced" | "paid";
  };
  project_tasks: {
    status: ProjectTaskStatus;
  };
  documents: {
    category: DocumentCategory;
  };
  statutory_dues_payments: {
    kind: StatutoryDuesKind;
  };
  tax_payments: {
    kind: TaxPaymentKind;
  };
  customer_credits: {
    status: "open" | "used" | "refunded";
  };
  credit_notes: {
    reason_code: CreditNoteReasonCode;
  };
  debit_notes: {
    reason_code: DebitNoteReasonCode;
  };
  emi_purchases: {
    category: "vehicle" | "equipment" | "furniture" | "property" | "other";
    status: "active" | "closed";
  };
  fixed_assets: {
    block: "computers" | "plant" | "furniture" | "vehicles" | "building" | "intangible";
  };
  business_loans: {
    status: "active" | "closed";
  };
  expense_claims: {
    status: "pending" | "approved" | "rejected";
  };
  contact_greeting_log: {
    kind: "birthday" | "anniversary";
  };
  assessments: {
    questions: unknown;
  };
  assessment_attempts: {
    answers: unknown;
  };
  inbound_purchases: {
    items: InboundPurchaseItem[];
    status: "pending" | "imported" | "ignored";
  };
  tds_receivable: {
    status: TdsStatus;
  };
  support_tickets: {
    category: SupportTicketCategory;
    priority: SupportTicketPriority;
    status: SupportTicketStatus;
    tier: "free" | "standard" | "enterprise" | null;
    channel: "email" | "whatsapp" | "portal" | "app" | null;
  };
  support_call_requests: {
    tier: "free" | "standard" | "enterprise";
    status: "requested" | "scheduled" | "completed" | "cancelled";
  };
  purchase_orders: {
    status: PurchaseOrderStatus;
  };
  campaigns: {
    audience_filter: { stages?: string[]; sources?: string[]; search?: string };
    status: CampaignStatus;
  };
  campaign_sends: {
    status: CampaignSendStatus;
  };
  campaign_templates: {
    category: CampaignTemplateCategory;
  };
  contacts: {
    emails: ContactChannel[];
    phones: ContactChannel[];
    source: ContactSource;
    status: ContactStatus;
  };
  google_contact_links: {
    source_type: "contact" | "lead" | "customer";
  };
  coupons: {
    discount_type: CouponDiscountType;
  };
  site_promos: {
    discount_type: CouponDiscountType;
    banner_style: SitePromoBannerStyle;
  };
  tenant_secrets: {
    whatsapp_provider: WhatsAppProvider | null;
    razorpay_mode: "test" | "live" | null;
  };
  team_invites: {
    role: TeamInviteRole;
  };
  join_requests: {
    requested_role: TeamInviteRole;
    status: JoinRequestStatus;
    matched_by: JoinRequestMatchedBy;
  };
  whatsapp_messages: {
    direction: WhatsAppDirection;
    type: WhatsAppMessageType;
    template_params: unknown;
    status: WhatsAppMessageStatus;
  };
  bank_accounts: {
    account_type: BankAccountType;
  };
  bank_transactions: {
    source: BankTransactionSource;
    matched_to_type: BankMatchToType | null;
    match_confidence: BankMatchConfidence | null;
    category_source: TxnCategorySource | null;
  };
  txn_category_rules: {
    direction: TxnRuleDirection;
  };
  bank_aa_connections: {
    provider: BankAaProvider;
    status: BankAaStatus;
    consent_payload: unknown;
  };
  referral_partners: {
    default_basis: CommissionBasis;
  };
  referral_agreements: {
    basis: CommissionBasis;
    scope: CommissionScope;
    status: "active" | "closed" | "cancelled";
  };
  referral_commissions: {
    basis: CommissionBasis;
    status: "earned" | "paid" | "cancelled";
  };
  feedback: {
    reported_type: "bug" | "feature" | "ui_improvement";
    reported_severity: "low" | "medium" | "high" | "critical";
    triage_status: "pending" | "triaged" | "failed";
    triage_mode: "gemini" | "stub" | null;
    inferred_type: "bug" | "feature" | "ui_improvement" | null;
    status: "open" | "agent_queued" | "fixed" | "wont_fix" | "duplicate";
  };
  personal_accounts: {
    kind: "savings" | "current" | "credit_card" | "fd" | "rd" | "ppf" | "cash" | "wallet";
  };
  personal_transactions: {
    kind: "drawing" | "dividend" | "salary" | "interest" | "other_income" | "expense";
  };
  personal_holdings: {
    asset_class: "mutual_fund" | "stock" | "real_estate" | "gold" | "sgb" | "lic" | "ppf" | "epf" | "nps" | "fd" | "bond" | "crypto" | "other";
  };
  attendance_reminder_log: {
    kind: "check_in" | "check_out";
  };
  /* R-060. Text in the DB (same reasoning as invoice_dunning_log.dunning_step), so the
     set of values lives here where a typo is a compile error rather than a claim that
     silently never replays. */
  seat_increase_claims: {
    status: "in_progress" | "done" | "failed";
  };
};

/**
 * DB me NULL allowed hai (NOT NULL constraint nahi), par app hamesha value likhta hai
 * (default ya insert path) — purani hand-written file inhe non-null maanti thi aur code
 * usi par chalta hai. Sach DB me NOT NULL lagana hai (follow-up migration), tab tak Row me
 * null-free. Insert/Update DB wale hi hain.
 */
type RowNotNull = {
  customers: "health" | "contact_persons" | "since";
  items: "prices" | "margin_pct";
  quotes: "line_items" | "subtotal" | "total_cost" | "discount_pct" | "tax_rate" | "payment_status";
  quote_signatures: "signed_snapshot";
  contract_amendments: "changes";
  invoices: "overdue_days" | "adjusted_advances";
  subscriptions: "used" | "is_urgent";
  vendor_bills: "line_items";
  expenses: "line_items";
  project_sales: "line_items";
  assessments: "questions";
  assessment_attempts: "answers";
  inbound_purchases: "items";
  campaigns: "audience_filter";
  contacts: "emails" | "phones" | "tags";
  whatsapp_messages: "template_params";
  bank_aa_connections: "last_fetch_count" | "consent_payload";
};

/** RPC args jinhe app `null` bhejta hai (generator args ko kabhi nullable nahi likhta). */
type ArgNullable = {
  backup_all_tenants: "p_label";
  backup_tenant: "p_label";
  consume_prepaid_advance: "p_note" | "p_attachment";
  consume_prepaid_fifo: "p_note" | "p_attachment" | "p_vendor_id" | "p_bill_no" | "p_igst" | "p_cgst" | "p_sgst" | "p_tds_section";
  book_bank_txn_as_prepaid: "p_notes";
  create_tenant_backup: "p_label";
  correct_attendance: "p_check_in" | "p_check_out";
  list_leads: "p_limit";
  list_whatsapp_threads: "p_limit";
  log_activity: "p_entity_id" | "p_label";
  sync_partner_item: "p_my_msrp";
  create_direct_invoice: "p_notes";
  create_project_direct_invoice: "p_customer_id" | "p_description";
  pay_referral_commission: "p_paid_on" | "p_method";
  set_document_series_start: "p_prefix";
  get_active_site_promo: "p_tier_id" | "p_seats";
  create_site_promo: "p_subheadline" | "p_badge_text" | "p_applies_to_tier" | "p_max_seats" | "p_valid_until" | "p_created_by";
  record_payment: "p_notes";
  record_payment_with_tds: "p_notes" | "p_tds_section" | "p_tds_rate_pct" | "p_customer_tan" | "p_invoice_id" | "p_fiscal_year";
  record_account_transfer: "p_note";
  create_project_sale: "p_customer_id" | "p_description";
  record_project_payment: "p_method" | "p_reference" | "p_bank_txn_id";
  create_project_quote: "p_customer_id" | "p_description";
  update_project_quote: "p_description";
  update_project_details: "p_description";
  disburse_employee_loan: "p_notes";
  settle_expense_advance: "p_return_account" | "p_notes";
  submit_expense_claim: "p_purpose" | "p_receipt_path";
  reject_expense_claim: "p_reason";
  edit_expense_claim: "p_purpose";
  edit_claim_public: "p_purpose";
  log_lead_activity: "p_detail";
  book_bank_txn_as_expense: "p_vendor" | "p_notes";
  book_bank_credit: "p_notes";
  book_bank_advance: "p_notes";
  edit_employee_loan: "p_notes";
  record_emi_purchase: "p_down_account" | "p_lender" | "p_notes";
  record_emi_payment: "p_notes";
  record_business_loan: "p_purpose" | "p_interest_rate" | "p_tenure_months" | "p_emi_amount";
  record_loan_emi: "p_notes";
  pay_vendor_bill: "p_method";
  record_employee_loan_repayment: "p_bank_account_id" | "p_notes";
  pay_salary: "p_advance_loan_id" | "p_notes" | "p_pf_wage";
  book_bank_txn_as_vendor_bill: "p_method";
  book_bank_txn_as_statutory: "p_notes" | "p_challan_no" | "p_period";
  add_project_receipt_milestone: "p_label";
  record_project_receipt_with_tds: "p_bank_txn_id" | "p_reference";
  create_project_quote_from_lead: "p_description";
  split_project_milestone: "p_label";
  book_bank_txn_as_tax: "p_period" | "p_fy" | "p_notes";
  redeem_customer_credits: "p_note";
  issue_credit_note: "p_reason" | "p_notes";
  issue_debit_note: "p_reason" | "p_notes";
  add_reimbursement: "p_paid_via" | "p_employee_id" | "p_receipt_path";
  settle_reimbursement: "p_notes";
  reconcile_bank_txn: "p_matched_to_type" | "p_matched_to_id" | "p_match_confidence";
  report_balance_sheet: "p_as_of";
  msme_payables_aging: "p_as_of";
  reconcile_salary_advance_split: "p_notes";
  pay_statutory_dues: "p_notes" | "p_challan_no" | "p_period";
  mark_attendance: "p_ip";
  save_package: "p_id" | "p_pitch";
  academy_review_task: "p_marks";
};

/** jsonb / setof RPCs ka return shape (generator sirf `Json` likhta hai). */
type FunctionReturnPatches = {
  backup_all_tenants: {
            label:       string;
            ok:          number;
            failed:      number;
            total_bytes: number;
            results:     Array<{ tenant: string; ok: boolean; bytes?: number; tables?: number; error?: string }>;
          };
  export_snapshots_for_offsite: Array<{
            tenant_id:   string;
            tenant_name: string | null;
            snapshot_id: string;
            created_at:  string;
            label:       string | null;
            kind:        string | null;
            table_count: number | null;
            payload:     Json;
          }>;
  reset_tenant_selected_tables: {
            backup_id: string;
            backup_bytes: number;
            deleted: Record<string, number>;
          };
  merge_stranded_user_into_tenant: {
            action: "attached" | "moved" | "already_member" | "role_updated";
            email: string;
            full_name: string | null;
            auth_user_id: string;
            role: string;
            tenant_id: string;
            tenant_name: string | null;
            old_tenant_name: string | null;
            old_tenant_deleted: boolean;
          };
  list_stranded_auth_users: { email: string; full_name: string | null; created_at: string; last_sign_in_at: string | null }[];
  create_tenant_backup: { id: string; table_count: number; bytes: number; created_at: string };
  list_tenant_backups: { id: string; created_at: string; label: string | null; kind: string; table_count: number; bytes: number }[];
  get_tenant_backup: unknown;
  auto_backup_if_stale: { created: boolean };
  nav_badges: {
            leads: number; enquiries: number; deals: number; tasks: number;
            renewals: number; invoices: number; payments: number; quotes: number;
          };
  restore_tenant_backup: { restored_tables: number; restored_at: string };
  my_attendance_today: unknown;
  today_inbox: { kind: string; id: string; title: string; due_at: string | null; priority: number; href: string }[];
  my_attendance_history: { work_date: string; check_in: string | null; check_out: string | null; source: string }[];
  get_my_tenant_with_parent: TenantWithParent[];
  get_partner_catalog: PartnerCatalogRow[];
  get_partner_metrics: PartnerMetricsRow[];
  pay_referral_commission: void;
  delete_customer: { deleted: boolean; customer_id: string };
  set_document_series_start: null;
  compute_advance_adjustment: {
            advances:   InvoiceAdvanceAdjustment[];
            total_paid: number;
            first_at:   string | null;
          }[];
  portal_list_products: {
            id: string;
            name: string;
            vendor: string;
            price_per_seat_month: number;
            hsn: string | null;
          }[];
  accept_quote: {
            quote_id:       string;
            customer_id:    string;
            converted_now:  boolean;
            quote_status:   string;
            awaits_payment: boolean;
          };
  redeem_coupon: {
            ok:             boolean;
            discount?:      number;
            discount_type?: CouponDiscountType;
            discount_value?: number;
            code?:          string;
            reason?:        string;
            required_tier?: string;
            min_seats?:     number;
            max_seats?:     number;
          };
  get_active_site_promo: SitePromoRow | null;
  refund_payment: {
            refund_voucher_no:  string;
            payment_id:         string;
            amount:             number;
            quote_id:           string;
            new_payment_status: string;
            credits_closed:     number;
            gateway_refunded:   boolean;
          };
  record_payment: {
            payment_id:           string;
            receipt_voucher_no:   string | null;
            customer_id:          string | null;
            total_received:       number;
            expected:             number;
            outstanding:          number;
            is_first_payment:     boolean;
            is_fully_paid:        boolean;
            converted_now:        boolean;
            subscription_created: boolean;
            invoice_paid:         boolean;
            has_existing_invoice: boolean;
            /** Added in migration 0010. True if the quote is linked to a subscription's renewal_quote_id. */
            is_renewal_quote:        boolean;
            /** Added in migration 0010. True when this payment fully covered a renewal quote and the linked subscription was advanced 1 year. */
            renewal_rolled_forward:  boolean;
            /** True when the same (quote, reference) was already recorded — idempotent replay; no new row inserted. */
            idempotent_replay?:      boolean;
            already_recorded?:       boolean;
            /** Migration 20260901110000 (audit A5) — is bhugtan ne jitna NAYA excess banaya, utni 'open' customer credit isi transaction me bani. Replay par absent. */
            overpaid_credit?:        number;
          };
  record_payment_with_tds: {
            payment_id:           string;
            receipt_voucher_no:   string | null;
            customer_id:          string | null;
            total_received:       number;
            expected:             number;
            outstanding:          number;
            is_first_payment:     boolean;
            is_fully_paid:        boolean;
            converted_now:        boolean;
            subscription_created: boolean;
            invoice_paid:         boolean;
            has_existing_invoice: boolean;
            is_renewal_quote:        boolean;
            renewal_rolled_forward:  boolean;
            idempotent_replay?:      boolean;
            already_recorded?:       boolean;
            /** True when the TDS receivable committed in the same txn as the payment. */
            tds_saved?:              boolean;
            /** record_payment se hokar aata hai — migration 20260901110000 (audit A5). */
            overpaid_credit?:        number;
          };
  suggest_bank_transaction_matches: BankMatchSuggestionRow[];
  book_bank_txn_as_vendor_bill: { bill_id: string; replaced_synthetic: string | null; amount: number };
  book_bank_txn_as_referral_commission: { commission_id: string; replaced_synthetic: string | null; amount: number };
  reconcile_bank_txn: Tables<"bank_transactions">;
  report_balance_sheet: Json;
  report_pnl: Json;
  msme_payables_aging: Json;
};

// ============================================================
// Public type aliases
// ============================================================
export type Tenant       = TenantRow;
export type DBUser       = UserRow;
export type Customer     = CustomerRow;
export type CustomerGroup = CustomerGroupRow;
export type Item         = ItemRow;
export type Lead         = LeadRow;
export type Quote        = QuoteRow;
export type QuoteSignature = QuoteSignatureRow;
export type ProvisioningTask = ProvisioningTaskRow;
export type SeatRequest = SeatRequestRow;
export type MrrSnapshot = MrrSnapshotRow;
export type ContractAmendment = ContractAmendmentRow;
export type PaymentMandate = PaymentMandateRow;
export type PaymentMandateInsertT = PaymentMandateInsert;
export type SubscriptionBilling = SubscriptionBillingRow;
export type SubscriptionBillingInsertT = SubscriptionBillingInsert;
export type Invoice      = InvoiceRow;
export type Subscription = SubscriptionRow;
export type Payment      = PaymentRow;
export type TxnCategoryRule = TxnCategoryRuleRow;
export type Task         = TaskRow;
