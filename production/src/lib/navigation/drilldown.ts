/**
 * Drill-downs — where a number's records live (R-118, 2 Oct 2026).
 *
 * Pardeep: "click karne related lead hi open ho — poori app me". A tile that shows "4 deals
 * won this month" must open those four deals, not the deals page. Two halves have to agree
 * for that: the TILE links to `/deals?view=won-mtd`, and the LIST PAGE reads `view` from the
 * URL and accepts `won-mtd`. Both halves import from here, so a renamed tab breaks a test
 * instead of silently landing the owner on "All".
 *
 * Each list page passes its `*_TABS` list to useUrlChoice (lib/hooks/use-url-choice.ts).
 * Pure data — no React — so the tests can check every link against the list it targets.
 */

/** /leads and /deals smart views (components/features/leads/leads-smart-views.tsx). */
export const LEAD_VIEWS = [
  "everything", "all", "mine", "waiting", "today", "overdue", "hot", "new",
  "closing", "stalled", "won-mtd", "duplicates", "junk",
] as const;
export type LeadViewId = (typeof LEAD_VIEWS)[number];

export const QUOTE_TABS = ["all", "draft", "sent", "viewed", "accepted", "awaiting", "invoiced", "rejected", "expired"] as const;
export const INVOICE_TABS = ["all", "paid", "partial", "pending", "overdue", "draft", "void"] as const;
export const SUBSCRIPTION_TABS = ["all", "active", "expiring", "suspended", "ended", "trials"] as const;
export const TASK_TABS = ["today", "overdue", "upcoming", "done", "all"] as const;
export const RENEWAL_BUCKETS = ["urgent", "upcoming", "future", "risk"] as const;
export const CUSTOMER_VIEWS = ["all", "unpaid", "subscribed", "projects", "nosub", "credit", "received"] as const;
export const PAYMENT_TABS = ["all", "received", "refunded"] as const;
/** /accounting/aging ?bucket= ("" = every customer owing). */
export const AGING_BUCKETS = ["", "current", "b30", "b60", "over90"] as const;
/** /purchase-orders ?tab= */
export const PO_TABS = ["open", "draft", "placed", "provisioned", "closed"] as const;
/** /accounting/tds-receivable ?tab= (claimable = cert received + 26AS verified). */
export const TDS_TABS = ["all", "claimable", "pending_cert", "cert_received", "verified_26as", "claimed", "disputed", "written_off"] as const;
/** /accounting/bills ?status= ("" = all; owed = unpaid + partial, the Outstanding tile). */
export const BILL_STATUSES = ["", "owed", "unpaid", "partial", "paid"] as const;

/** /invoices ?focus= — the money tiles' exact sets (lib/invoices/kpis.ts). Kept in step
 *  with INVOICE_FOCI by a test. */
export const INVOICE_FOCUS = ["", "unpaid", "paid-month"] as const;
/** /subscriptions ?focus= (lib/subscriptions/focus.ts). */
export const SUB_FOCUS = ["", "active"] as const;
/** /quotes ?focus= (lib/quotes/focus.ts). */
export const QUOTE_FOCUS = ["", "pipeline", "review", "accepted", "partial", "to-invoice"] as const;
/** /payments ?focus= (lib/payments/focus.ts). */
export const PAYMENT_FOCUS = ["", "received-month"] as const;

/** One drill-down: the page, the URL key it reads, and the value — checked by the tests. */
export interface Drill { path: string; key: string; value: string }

const d = (path: string, key: string, value: string): Drill => ({ path, key, value });

export const DRILL = {
  /* Deals — the dashboard strip (lib/deals/pipeline-summary.ts uses the same rules). */
  dealsOpen:        d("/deals", "view", "all"),
  dealsClosing:     d("/deals", "view", "closing"),
  dealsWonMonth:    d("/deals", "view", "won-mtd"),
  /* Leads */
  leadsActive:      d("/leads", "view", "all"),
  leadsToday:       d("/leads", "view", "today"),
  leadsFollowUpDue: d("/leads", "view", "overdue"),
  /* Quotes */
  quotesDraft:      d("/quotes", "tab", "draft"),
  quotesAccepted:   d("/quotes", "tab", "accepted"),
  /* Invoices */
  invoicesOverdue:  d("/invoices", "tab", "overdue"),
  invoicesUnpaid:   d("/invoices", "focus", "unpaid"),
  /* Subscriptions / renewals */
  subsExpiring:     d("/subscriptions", "tab", "expiring"),
  subsActive:       d("/subscriptions", "focus", "active"),
  renewalsUrgent:   d("/renewals", "bucket", "urgent"),
  /* Tasks */
  tasksOverdue:     d("/tasks", "tab", "overdue"),
  tasksToday:       d("/tasks", "tab", "today"),
} as const satisfies Record<string, Drill>;

export type DrillName = keyof typeof DRILL;

/** The link for a drill-down: "/deals?view=won-mtd". */
export function drillHref(name: DrillName): string {
  const x = DRILL[name];
  return `${x.path}?${x.key}=${encodeURIComponent(x.value)}`;
}

/** Which allowed-list each page + key reads — the tests check every DRILL entry against it. */
export const PAGE_CHOICES: Record<string, Record<string, readonly string[]>> = {
  "/leads":         { view: LEAD_VIEWS },
  "/deals":         { view: LEAD_VIEWS },
  "/quotes":        { tab: QUOTE_TABS, focus: QUOTE_FOCUS },
  "/invoices":      { tab: INVOICE_TABS, focus: INVOICE_FOCUS },
  "/subscriptions": { tab: SUBSCRIPTION_TABS, focus: SUB_FOCUS },
  "/tasks":         { tab: TASK_TABS },
  "/renewals":      { bucket: RENEWAL_BUCKETS },
  "/customers":     { view: CUSTOMER_VIEWS },
  "/payments":      { tab: PAYMENT_TABS, focus: PAYMENT_FOCUS },
};
