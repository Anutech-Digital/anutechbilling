/**
 * The ResellerOS page's content — the one page on the site that wears the orange accent.
 *
 * The mock rows and KPI figures below are ILLUSTRATIVE screenshots-in-text from the handoff,
 * not live data. The page's live links are the real integration: signup and demo go to the
 * actual app (see lib/config.ts, where the handoff's alias URL was corrected).
 */

export const OS_KPIS: readonly { label: string; value: string; note: string; accent?: boolean }[] = [
  { label: "MRR", value: "₹69.4K", note: "4 active subs" },
  { label: "PIPELINE", value: "₹96.3K", note: "1 active deal" },
  { label: "ACCEPTED", value: "₹6.3L", note: "MTD · 4 quotes", accent: true },
  { label: "RENEWALS", value: "0", note: "Next 30 days" },
] as const;

export const OS_QUOTES = [
  { no: "Q-2026-27-0005", who: "Manoj", amount: "₹2.4L", status: "SENT", color: "#5C6672" },
  { no: "Q-2026-27-0004", who: "Sunil Loza", amount: "₹28.9K", status: "ACCEPTED", color: "#0F7B4F" },
  { no: "Q-2026-27-0003", who: "TechVista", amount: "₹6.3L", status: "PAID", color: "#0F7B4F" },
  { no: "Q-2026-27-0002", who: "Demo Co", amount: "₹54K", status: "DRAFT", color: "#5C6672" },
] as const;

export const OS_FACTS = [
  "GOOGLE PREMIER PARTNER SINCE 2014",
  "17 MODULES, ONE DATABASE",
  "GST + HSN 998313",
  "DPDP ACT 2023 READY",
  "GOOGLE CLOUD MUMBAI",
  "RAZORPAY PAYOUTS",
] as const;

export const OS_PAINS = [
  { title: "Lead chaos", body: "Spreadsheet for leads. WhatsApp for follow-ups. Memory for what was said." },
  { title: "Quote → invoice friction", body: "Tally or Zoho Books for invoices, and customer details re-typed every quote." },
  { title: "Bank and renewal slips", body: "Reconciliation on paper. Renewal reminders that get missed." },
  { title: "GST quarterly crisis", body: "Filings at the eleventh hour, and margins that stay fuzzy." },
] as const;

export interface OsModule {
  no: string;
  title: string;
  body: string;
  bullets: readonly string[];
  mockTitle: string;
  rows: readonly { a: string; b: string; c: string; color: string }[];
}

export const OS_MODULES: readonly OsModule[] = [
  {
    no: "01 · SUBSCRIPTIONS",
    title: "Every subscription, seat and commitment in one ledger.",
    body: "This is the core of it: each customer's Workspace, M365 and Zoho subscriptions with their seat counts, commitment term, price tier and next renewal date. Add seats mid-term and the pro-rata is calculated for you.",
    bullets: ["Seat changes with pro-rata billing", "5 commitment types × 2 price tiers", "MRR, ARR, churn and LTV off the same ledger"],
    mockTitle: "resellersos.in/subscriptions",
    rows: [
      { a: "TechVista · GW Business", b: "50 seats", c: "ANNUAL", color: "#0F7B4F" },
      { a: "Sunil Loza · M365 Biz", b: "12 seats", c: "MONTHLY", color: "#5C6672" },
      { a: "Demo Co · Zoho One", b: "9 seats", c: "+3 MID-TERM", color: "#C2410C" },
      { a: "MRR across 4 subs", b: "₹69.4K", c: "LIVE", color: "#1668E3" },
    ],
  },
  {
    no: "02 · PIPELINE",
    title: "From inbox to ₹ won, in one view.",
    body: "A unified pipeline replaces the spreadsheet. Smart Views push the right deals up; the Today strip surfaces what needs a follow-up before lunch.",
    bullets: ["Lead → Deal split for sales workflow", "Kanban, list and smart filters", "Inline call / email / WhatsApp"],
    mockTitle: "resellersos.in/leads · Kanban",
    rows: [
      { a: "New · Acme Corp", b: "₹84K", c: "NEW", color: "#5C6672" },
      { a: "Contacted · DataCo", b: "₹1.2L", c: "CONTACTED", color: "#5C6672" },
      { a: "Quote sent · TechVista", b: "₹2.4L", c: "QUOTE SENT", color: "#1668E3" },
      { a: "Won · Manoj", b: "₹6.3L", c: "WON", color: "#0F7B4F" },
    ],
  },
  {
    no: "03 · QUOTES",
    title: "GST-compliant quotes in 90 seconds.",
    body: "Five commitment types across two pricing tiers, per-line discounts, prospect mode. The CGST/SGST split is calculated, not handcrafted.",
    bullets: ["CGST §31 compliant numbering", "Multi-tier catalog with wholesale", "Send, audit log, accept page"],
    mockTitle: "resellersos.in/quotes/new",
    rows: [
      { a: "Q-2026-27-0042", b: "Draft", c: "TECHVISTA", color: "#5C6672" },
      { a: "GSTIN 27AADCB2230M1Z2", b: "verified", c: "GSTIN", color: "#0F7B4F" },
      { a: "GW Business Standard × 50", b: "₹12,600/yr", c: "LINE 1", color: "#5C6672" },
      { a: "Total excl. GST", b: "₹6,30,000", c: "TOTAL", color: "#0C1116" },
    ],
  },
  {
    no: "04 · RENEWALS",
    title: "Renewals on autopilot, with grace.",
    body: "A T-30, T-15, T-7, T-0 cadence with reminder emails, auto-suspend and a grace window. The renewal quote is drafted on day one — the operator just clicks send.",
    bullets: ["Auto-generated renewal quotes", "Configurable grace period per tenant", "Daily cron, idempotent and safe"],
    mockTitle: "resellersos.in/renewals/GW-882",
    rows: [
      { a: "T-30 reminder sent", b: "01 May", c: "DONE", color: "#0F7B4F" },
      { a: "T-15 quote auto-drafted", b: "15 May", c: "Q-…0038", color: "#0F7B4F" },
      { a: "T-7 final reminder", b: "23 May", c: "DUE", color: "#C98A0A" },
      { a: "T-0 expiry and grace", b: "30 May", c: "SCHEDULED", color: "#5C6672" },
    ],
  },
  {
    no: "05 · BANKING",
    title: "Reconciliation that knows what “Razorpay-2026-05” means.",
    body: "CSV import for HDFC, ICICI, SBI, Axis, Kotak, IndusInd and Yes Bank, with auto-match suggestions and confidence pills. Setu Account Aggregator ready for live fetch.",
    bullets: ["Seven bank parsers, period-suffix safe", "Exact / high / low match suggestions", "Manual reconcile escape hatch"],
    mockTitle: "resellersos.in/accounting/banking",
    rows: [
      { a: "UPI/TechVista/INV-0042", b: "₹6,30,000", c: "MATCHED", color: "#0F7B4F" },
      { a: "NEFT-SUNIL LOZA-HDFC", b: "₹28,900", c: "ACCEPT?", color: "#C98A0A" },
      { a: "AWS EMEA SARL", b: "₹12,450", c: "UNRECONCILED", color: "#B3261E" },
      { a: "HDFC Current ••• 1234", b: "Setu AA", c: "CONNECTED", color: "#1668E3" },
    ],
  },
] as const;

export const OS_MORE = [
  { title: "Razorpay + buy pages", body: "Public checkout, coupons, site promos." },
  { title: "Accounting layer", body: "P&L, aging, MRR/ARR/churn/LTV." },
  { title: "TDS receivable", body: "Form 16A upload, 26AS reconcile." },
  { title: "Customer portal", body: "Magic-link, invoices, tickets." },
  { title: "WhatsApp + email", body: "Gupshup BSP, Resend, PDF send." },
  { title: "Procurement", body: "POs, PO ↔ bill matching." },
  { title: "Partner channel", body: "Distributor ↔ reseller sync." },
  { title: "GSTIN verification", body: "Sandbox.co.in lookup and auto-fill." },
] as const;

export const OS_ONBOARDING = [
  { step: "01", title: "Create your tenant", body: "Company details, GSTIN, invoice series and financial year. Two minutes, no card." },
  { step: "02", title: "Import what you have", body: "Customers, subscriptions and open invoices by CSV — or a 1-click Tally or Excel import." },
  { step: "03", title: "Send one real quote", body: "Pick a customer, pick an edition, send. GST split and numbering are handled." },
  { step: "04", title: "Turn on renewals", body: "Set the grace window and the T-30 cadence starts running on its own the next morning." },
] as const;

export const OS_SECURITY = [
  { title: "Hosted on Google Cloud Mumbai", body: "Data stays in India. Region is asia-south1, with managed Postgres and daily encrypted snapshots." },
  { title: "DPDP Act 2023 ready", body: "Consent records, purpose limitation and data-principal deletion requests built into the schema." },
  { title: "Tenant isolation", body: "Every reseller is a separate tenant. Row-level scoping on every query, verified in tests, not by convention." },
  { title: "Role-based access", body: "Owner, operator and accountant roles with an append-only audit log on quotes, invoices and payments." },
  { title: "GST correctness", body: "HSN 998313, CGST §31 numbering, intra and inter-state split, advance receipts — schema-level, not a plugin." },
  { title: "Your data leaves freely", body: "CSV export of customers, subscriptions, invoices and payments at any time. No exit fee, no lock-in." },
] as const;

export const OS_INTEGRATIONS = [
  { name: "Razorpay", note: "Checkout, payouts, webhooks" },
  { name: "Setu AA", note: "Live bank feed, account aggregator" },
  { name: "Gupshup BSP", note: "WhatsApp templates and sends" },
  { name: "Resend", note: "Transactional email and PDFs" },
  { name: "Sandbox.co.in", note: "GSTIN verification and auto-fill" },
  { name: "Tally / Excel", note: "1-click migration import" },
  { name: "HDFC · ICICI · SBI", note: "Statement CSV parsers" },
  { name: "Axis · Kotak · Yes", note: "Statement CSV parsers" },
] as const;

export const OS_CHANGELOG = [
  { date: "AUG 2026", title: "Subscription pro-rata on mid-term seat changes", body: "Add or remove seats inside a term and the next invoice carries the adjustment automatically." },
  { date: "JUL 2026", title: "Setu Account Aggregator live fetch", body: "Bank feed without CSV upload for HDFC and ICICI, with the other five following." },
  { date: "JUN 2026", title: "TDS receivable and 26AS reconcile", body: "Form 16A upload with matching against booked receivables." },
  { date: "MAY 2026", title: "Customer portal with magic-link sign-in", body: "Clients see their invoices, subscriptions and tickets without a password." },
] as const;

export const OS_TIERS = [
  { name: "Beta", price: "₹0", note: "Now — first 10 resellers", highlighted: true, lines: ["Every module, no seat limits", "Onboarding done with you personally", "You decide when to start paying"] },
  { name: "Starter", price: "TBA", note: "Launches at ₹15K MRR", highlighted: false, lines: ["Single operator", "Subscriptions, quotes, invoices", "GST and renewals"] },
  { name: "Growth", price: "TBA", note: "Launches at ₹15K MRR", highlighted: false, lines: ["Small team, roles and audit log", "Banking reconciliation, TDS", "Customer portal"] },
  { name: "Pro", price: "TBA", note: "Launches at ₹15K MRR", highlighted: false, lines: ["Partner channel and procurement", "API access and webhooks", "Priority escalation"] },
] as const;

export const OS_WHY = [
  { no: "01", title: "Built by a reseller", body: "12+ years running Anutech Digital as a Google Workspace, M365 and Zoho reseller. Every workflow comes from real operational pain, not a feature list." },
  { no: "02", title: "GST-first by design", body: "HSN 998313, CGST §31 invoice numbering, intra and inter-state tax split, advance receipts — in the schema, not bolted on." },
  { no: "03", title: "No drift from our own desk", body: "Anutech Digital is its first customer. If a feature does not work for us in production, it does not ship." },
] as const;

export const OS_FOUNDER_QUOTE =
  "Twelve years as a Google Workspace, M365 and Zoho reseller — payments missed, renewals slipped, GST filings done at the eleventh hour. ResellerOS came out of those constraints, and Anutech Digital is still its first customer.";
