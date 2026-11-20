/**
 * R-2969 — every row of the dashboard's Company cards opens EXACTLY the records behind its
 * number. For each row the same fixture goes to the card's number (lib/company/summary.ts) and
 * to the filter its list page applies (the predicate the page calls), and the count / sum must
 * agree. IST month edges are in the fixtures, so a browser clock in another zone cannot pass.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  growthSummary, leadAddedInMonth, trialsStartedInMonth, trialStartedInMonth, invoiceMoney,
  collectedInMonth, newCustomersInMonth, customerNewInMonth, subscriptionSummary,
  openTicketCount, ticketStillOpen, activationWaiting, OPEN_TICKET_STATUSES,
} from "./summary";
import { invoiceInFocus, invoiceIssuedInMonth } from "@/lib/invoices/kpis";
import { paymentInFocus, projectReceivedInMonth } from "@/lib/payments/focus";
import { cashReceived } from "@/lib/payments/cash-received";
import { subInFocus } from "@/lib/subscriptions/focus";
import { folderOf, folderMrr } from "@/lib/subscriptions/folders";
import { totalMrr } from "@/lib/subscriptions/mrr-of";
import { customerInList, customerListMode } from "@/app/(app)/customers/server-list";
import { DRILL, PAGE_CHOICES, drillHref } from "@/lib/navigation/drilldown";

// 15 Nov 2026, 10:00 IST
const NOW = new Date("2026-11-15T04:30:00Z");
const TODAY = "2026-11-15";
const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("Growth", () => {
  const leads = [
    { source: "enquiry-form", created_at: "2026-10-31T18:30:00Z" },        // 1 Nov 00:00 IST → in
    { source: "buy-workspace-trial", created_at: "2026-11-03T05:00:00Z" },
    { source: "referral", created_at: "2026-11-04T05:00:00Z" },
    { source: null, created_at: "2026-11-30T18:29:59Z" },                  // 30 Nov 23:59 IST → in
    { source: "enquiry-form", created_at: "2026-10-31T18:29:59Z" },        // 31 Oct 23:59 IST → out
    { source: "buy-workspace", created_at: "2026-11-30T18:30:00Z" },       // 1 Dec IST → out
  ];
  it("Leads added = the /lead-gen?channel=all list", () => {
    expect(growthSummary(leads, NOW).newLeads).toBe(leads.filter((l) => leadAddedInMonth(l, "all", NOW)).length);
    expect(growthSummary(leads, NOW).newLeads).toBe(4);
  });
  it("From the website = the /lead-gen?channel=website list", () => {
    expect(growthSummary(leads, NOW).fromWebsite).toBe(leads.filter((l) => leadAddedInMonth(l, "website", NOW)).length);
    expect(growthSummary(leads, NOW).fromWebsite).toBe(2);
  });
  it("Trials started = the /subscriptions?focus=trials-month list (any trial state)", () => {
    const trials = [
      { trial_started_at: "2026-10-31T19:00:00Z" },   // 1 Nov IST
      { trial_started_at: "2026-11-10T05:00:00Z" },
      { trial_started_at: "2026-10-20T05:00:00Z" },
      { trial_started_at: null },
    ];
    expect(trialsStartedInMonth(trials, NOW)).toBe(trials.filter((t) => trialStartedInMonth(t, NOW)).length);
    expect(trialsStartedInMonth(trials, NOW)).toBe(2);
  });
});

describe("Money", () => {
  const inv = (o: Record<string, unknown>) => ({
    status: "pending", amount: 1000, due_date: null, invoice_date: "2026-11-05", paid_amount: 0, net_payable: null, ...o,
  }) as Parameters<typeof invoiceMoney>[0][number];
  const invoices = [
    inv({ amount: 1_000 }),
    inv({ amount: 2_500, status: "paid", paid_amount: 2_500, paid_date: "2026-11-06" }),
    inv({ amount: 400, status: "overdue", invoice_date: "2026-11-01" }),
    inv({ amount: 7_000, status: "draft" }),                                   // not issued
    inv({ amount: 8_000, status: "void" }),                                    // not issued
    inv({ amount: 9_000, document_kind: "opening_invoice" }),                  // imported — not our sale
    inv({ amount: 3_000, invoice_date: "2026-10-31" }),                        // last month
    inv({ amount: 600, invoice_date: "2026-10-31T19:00:00Z" }),                // 1 Nov IST (stored as an instant)
  ];
  it("Invoiced = the /invoices?focus=issued-month list, count AND sum", () => {
    const card = invoiceMoney(invoices, NOW).invoicedThisMonth;
    const listed = invoices.filter((i) => invoiceInFocus(i, "issued-month", NOW));
    expect(card).toEqual({ count: listed.length, value: listed.reduce((s, i) => s + i.amount, 0) });
    expect(card).toEqual({ count: 4, value: 4_500 });
  });
  it("issued-month is the one-record test the card uses", () => {
    for (const i of invoices) expect(invoiceInFocus(i, "issued-month", NOW)).toBe(invoiceIssuedInMonth(i, NOW));
  });
  it("Collected = the /payments?focus=received-month rows (cash in) + the project receipts the banner adds", () => {
    const pays = [
      { status: "received", amount: 1_000, received_at: "2026-10-31T18:30:00Z" },                // 1 Nov IST
      { status: "received", amount: 500, credit_applied: 200, received_at: "2026-11-02T05:00:00Z" },
      { status: "received", amount: 900, received_at: "2026-10-31T18:29:59Z" },                // October
      { status: "refunded", amount: 70, received_at: "2026-11-04T05:00:00Z" },
    ];
    const proj = [{ amount: 300, received_at: "2026-11-05" }, { amount: 9, received_at: "2026-10-30" }];
    const rows = pays.filter((p) => paymentInFocus(p, "received-month", NOW));
    const bannerTotal = rows.reduce((s, p) => s + cashReceived(p), 0) + projectReceivedInMonth(proj, NOW);
    expect(collectedInMonth(pays, proj, NOW)).toBe(bannerTotal);
    expect(bannerTotal).toBe(1_000 + 300 + 300);
  });
});

describe("Customers & Ops", () => {
  it("New customers = the /customers?focus=new-month list, archived ones included", () => {
    const customers = [
      { created_at: "2026-10-31T18:30:00Z", is_active: true },
      { created_at: "2026-11-09T05:00:00Z", is_active: false },   // archived — counted, so listed
      { created_at: "2026-10-31T18:29:59Z", is_active: true },    // October
      { created_at: null, is_active: true },
    ];
    const listed = customers.filter((c) =>
      customerInList(c.is_active, { showArchived: false, viewId: "all", owes: 0, focus: "new-month" })
      && customerNewInMonth(c, NOW));
    expect(newCustomersInMonth(customers, NOW)).toBe(listed.length);
    expect(listed.length).toBe(2);
    /* The 50-row server page cannot apply the month test — the focus reads the full list. */
    expect(customerListMode({ view: "all", sortKey: "recent", sortDir: "desc", contactIds: null, focus: "new-month" })).toBe("full");
    /* Without the focus, archived customers stay hidden as before. */
    expect(customerInList(false, { showArchived: false, viewId: "all", owes: 0 })).toBe(false);
  });

  const subs = [
    { status: "active", mrr: 1_000, renewal_date: "2027-03-01", term_months: 12, plan: "Workspace" },
    { status: "active", mrr: 500, renewal_date: "2026-11-30", term_months: 12, plan: "Workspace" },   // renews in 15 days
    { status: "active", mrr: 200, renewal_date: "2026-11-01", term_months: 1, plan: "Mail" },        // lapsed, still live
    { status: "active", mrr: 50, renewal_date: "2027-01-01", term_months: null, plan: "Setup one-time" }, // adds 0 to MRR
    { status: "paused", mrr: 300, renewal_date: "2026-11-20", term_months: 12, plan: "Workspace" },
    { status: "cancelled", mrr: 900, renewal_date: "2026-11-25", term_months: 12, plan: "Workspace" },
  ];
  it("Monthly revenue (MRR) = the /subscriptions?focus=active rows, count and MRR sum", () => {
    const card = subscriptionSummary(subs, NOW);
    const rows = subs.filter((s) => subInFocus(s, "active"));
    expect(card.activeCount).toBe(rows.length);
    expect(card.mrr).toBe(totalMrr(rows));
    expect(card.mrr).toBe(1_700);
  });
  it("Renewals in 30 days = the /subscriptions?tab=expiring rows, count and ₹ a month", () => {
    const card = subscriptionSummary(subs, NOW).renewalsDue;
    const rows = subs.filter((s) => folderOf(s, TODAY) === "expiring");
    expect(card.count).toBe(rows.length);
    expect(card.value).toBe(folderMrr(subs, "expiring", TODAY));
    expect(card).toEqual({ count: 2, value: 700 });
  });
  it("Open tickets = the /support?focus=still-open list (counts built the way the API builds them)", () => {
    const tickets = ["open", "in_progress", "awaiting_customer", "resolved", "closed", "open"].map((status) => ({ status }));
    const counts: Record<string, number> = {};
    for (const t of tickets) counts[t.status] = (counts[t.status] ?? 0) + 1;
    expect(openTicketCount(counts)).toBe(tickets.filter((t) => ticketStillOpen(t.status)).length);
    expect(openTicketCount(counts)).toBe(4);
    for (const s of OPEN_TICKET_STATUSES) expect(ticketStillOpen(s)).toBe(true);
    expect(ticketStillOpen(null)).toBe(false);
  });
  it("Waiting to activate = the /provisioning?focus=waiting list, and the API counts with the same test", () => {
    const rows = ["queued", "activated", "queued", "failed", "cancelled"].map((status) => ({ status }));
    expect(rows.filter(activationWaiting).length).toBe(2);
    expect(read("app/api/provisioning/queue/route.ts")).toMatch(/const waiting = rows\.filter\(activationWaiting\)/);
  });
});

describe("every Company row links to its exact filter", () => {
  const section = read("components/features/dashboard/company-section.tsx");
  const ROWS: Array<[string, keyof typeof DRILL, string]> = [
    ["Leads added", "leadsAddedMonth", "/lead-gen?channel=all"],
    ["From the website", "leadsWebsiteMonth", "/lead-gen?channel=website"],
    ["Trials started", "trialsStartedMonth", "/subscriptions?focus=trials-month"],
    ["Won this month", "dealsWonMonth", "/deals?view=won-mtd"],
    ["Pipeline", "dealsOpen", "/deals?view=all"],
    ["Invoiced", "invoicesIssuedMonth", "/invoices?focus=issued-month"],
    ["Collected", "paymentsReceivedMonth", "/payments?focus=received-month"],
    ["Still owed (invoices)", "invoicesUnpaid", "/invoices?focus=unpaid"],
    ["Overdue invoices", "invoicesOverdue", "/invoices?tab=overdue"],
    ["New customers", "customersNewMonth", "/customers?focus=new-month"],
    ["Monthly revenue (MRR)", "subsActive", "/subscriptions?focus=active"],
    ["Renewals in 30 days", "subsExpiring", "/subscriptions?tab=expiring"],
    ["Open tickets", "ticketsStillOpen", "/support?focus=still-open"],
    ["Waiting to activate", "activationsWaiting", "/provisioning?focus=waiting"],
  ];
  for (const [label, name, href] of ROWS) {
    it(`${label} → ${href}`, () => {
      expect(drillHref(name)).toBe(href);
      const esc = label.replace(/[()]/g, "\\$&");
      expect(section).toMatch(new RegExp(`<Metric href=\\{drillHref\\("${name}"\\)\\} label="${esc}"`));
      const d = DRILL[name];
      expect(PAGE_CHOICES[d.path]?.[d.key]).toContain(d.value);
    });
  }
  it("no row opens a bare, unfiltered page", () => {
    expect(section).not.toMatch(/<Metric href="\//);
  });
});

describe("each list page reads the filter from the address and shows a Clear chip", () => {
  const PAGES: Array<[string, RegExp]> = [
    ["app/(app)/invoices/page.tsx", /useUrlChoice<InvoiceFocus>\("focus", INVOICE_FOCI, ""\)/],
    ["app/(app)/payments/page.tsx", /useUrlChoice<PaymentFocus>\("focus", PAYMENT_FOCI, ""\)/],
    ["app/(app)/subscriptions/page.tsx", /useUrlChoice<SubFocus>\("focus", SUB_FOCI, ""\)/],
    ["app/(app)/customers/page.tsx", /useUrlChoice<[^>]+>\("focus", CUSTOMER_FOCUS, ""\)/],
    ["app/(app)/support/page.tsx", /useUrlChoice<[^>]+>\("focus", SUPPORT_FOCUS, ""\)/],
    ["app/(app)/provisioning/page.tsx", /useUrlChoice<[^>]+>\("focus", PROVISIONING_FOCUS, ""\)/],
    ["app/(app)/lead-gen/page.tsx", /useUrlChoice<[^>]+>\("channel", LEADGEN_CHANNELS, ""\)/],
  ];
  for (const [file, re] of PAGES) {
    it(file, () => {
      const src = read(file);
      expect(src).toMatch(re);
      if (!file.includes("lead-gen")) expect(src).toMatch(/<FocusBanner/);
    });
  }
  it("the pages filter with the card's own one-record tests", () => {
    expect(read("app/(app)/customers/page.tsx")).toMatch(/focus === "new-month" && !customerNewInMonth\(c\)/);
    expect(read("app/(app)/support/page.tsx")).toMatch(/filter\(\(t\) => ticketStillOpen\(t\.status\)\)/);
    expect(read("app/(app)/provisioning/page.tsx")).toMatch(/filter\(activationWaiting\)/);
    expect(read("app/(app)/subscriptions/page.tsx")).toMatch(/filter\(\(t\) => trialStartedInMonth\(t\)\)/);
    expect(read("app/(app)/lead-gen/page.tsx")).toMatch(/leadAddedInMonth\(l, "all", now\)/);
  });
});
