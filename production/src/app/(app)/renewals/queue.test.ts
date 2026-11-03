/**
 * R-2403 — Renewals as one work queue: time-window tabs (no row in two), ONE status per row
 * (the Ravi Shankar row), "Oct bill not raised" for a subscription billed in parts, the renewal
 * amount for the term, sort/filter and the bulk "Send renewal quote" selection.
 * Rows are shaped on the staging audit (Anutech-HQ/drafts/RENEWALS-AUDIT/page-audit.md).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { classifyRenewals, type ClassifyRow } from "./classify";
import { renewalRowAction } from "./row-action";
import {
  QUEUE_TABS, queueTabs, windowTab, resolveBucket, renewalRowStatus, billsNotRaised,
  renewalAmount, termSuffix, isPaidRenewalQuote, sortQueue, filterQueue, filterOptions,
  bulkQuoteTargets, bulkQuoteConfirm, NO_FILTERS, type QueueRow,
} from "./queue";
import { renewalActionSet } from "@/components/features/renewals/renewal-actions-rules";

const TODAY = new Date("2026-11-03T06:30:00Z"); // 12:00 IST, 3 Nov 2026

interface Sub {
  id: string; customer_name: string; renewal_state: string | null; renewal_date: string | null;
  term_months: number; status: string; mrr: number; auto_renew?: boolean | null;
  billing_cycle?: string | null; start_date?: string | null; grace_until?: string | null;
  renewal_quote_id: string | null; term_amount?: number | null; plan?: string | null; vendor?: string | null;
}
type Row = ClassifyRow<Sub>;
const row = (id: string, daysUntil: number, over: Partial<Sub> = {}): Row => ({
  daysUntil,
  sub: {
    id, customer_name: id.toUpperCase(), renewal_state: "notice_sent", renewal_date: "2026-11-10",
    term_months: 12, status: "active", mrr: 1000, billing_cycle: "yearly", start_date: "2025-11-11",
    renewal_quote_id: null, ...over,
  },
});

describe("R-2403 tabs: Overdue · ≤7 days · 8–30 · 31–60 · 61–90 — every row in exactly one", () => {
  const rows: Row[] = [
    row("lapsed", -3, { renewal_date: "2026-10-31", renewal_state: "grace_period" }),
    row("stopped", -20, { renewal_date: "2026-10-14", renewal_state: "suspended" }),
    row("today", 0, { renewal_date: "2026-11-03" }),
    row("week", 7, { renewal_date: "2026-11-10" }),
    row("eight", 8, { renewal_date: "2026-11-11" }),
    row("month", 30, { renewal_date: "2026-12-03" }),
    row("d31", 31, { renewal_date: "2026-12-04" }),
    row("d60", 60, { renewal_date: "2027-01-02" }),
    row("d61", 61, { renewal_date: "2027-01-03" }),
    row("d90", 90, { renewal_date: "2027-02-01" }),
    row("far", 91, { renewal_date: "2027-02-02" }),
    row("leaver", 12, { auto_renew: false, renewal_date: "2026-11-15" }),
    row("flex", 5, { term_months: 1, billing_cycle: "monthly", renewal_date: "2026-11-08" }),
  ];
  const g = classifyRenewals(rows, () => false, TODAY);
  const tabs = queueTabs(g);
  const ids = (t: (typeof QUEUE_TABS)[number]) => tabs[t].map((r) => r.sub.id);

  it("windows by IST days", () => {
    expect(ids("overdue")).toEqual(["lapsed", "stopped"]);
    expect(ids("due7")).toEqual(["today", "week"]);
    expect(ids("d30")).toEqual(["eight", "month", "leaver"]);
    expect(ids("d60")).toEqual(["d31", "d60"]);
    expect(ids("d90")).toEqual(["d61", "d90"]);
  });

  it("no row appears in two tabs; past 90 days and flex parts are not listed", () => {
    const all = QUEUE_TABS.flatMap((t) => ids(t));
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("far");
    expect(all).not.toContain("flex");
  });

  it("the At risk tab is gone: at-risk rows are a filter on these tabs, not a second list", () => {
    expect(QUEUE_TABS).toEqual(["overdue", "due7", "d30", "d60", "d90"]);
    expect(QUEUE_TABS as readonly string[]).not.toContain("risk");
  });

  it("windowTab edges", () => {
    expect([-1, 0, 7, 8, 30, 31, 60, 61, 90, 91].map(windowTab)).toEqual(
      ["overdue", "due7", "due7", "d30", "d30", "d60", "d60", "d90", "d90", null]);
  });

  it("old ?bucket= links still open the right place (sidebar badge = Overdue + ≤7 days)", () => {
    const counts = { overdue: 2, due7: 2, d30: 3, d60: 2, d90: 2 };
    expect(resolveBucket("urgent", counts)).toEqual({ tab: "overdue", atRisk: false });
    expect(resolveBucket("urgent", { ...counts, overdue: 0 })).toEqual({ tab: "due7", atRisk: false });
    expect(resolveBucket("upcoming", counts)).toEqual({ tab: "d30", atRisk: false });
    expect(resolveBucket("future", counts)).toEqual({ tab: "d60", atRisk: false });
    expect(resolveBucket("risk", counts)).toEqual({ tab: "overdue", atRisk: true });
    expect(resolveBucket("d60", counts)).toEqual({ tab: "d60", atRisk: false });
  });
});

describe("R-2403 renewed / paid rows leave Overdue", () => {
  it("a renewal whose quote is paid is not overdue (nor in the sidebar's urgent set)", () => {
    const rows = [
      row("paid", -2, { renewal_date: "2026-11-01", renewal_quote_id: "Q-P" }),
      row("unpaid", -2, { renewal_date: "2026-11-01", renewal_quote_id: "Q-U" }),
    ];
    const quotes = new Map([
      ["Q-P", { id: "Q-P", amount: 1180, status: "accepted", payment_status: "received" }],
      ["Q-U", { id: "Q-U", amount: 1180, status: "sent", payment_status: "none" }],
    ]);
    const g = classifyRenewals(rows, () => false, TODAY, (r) => isPaidRenewalQuote(r.sub, quotes.get(r.sub.renewal_quote_id ?? "")));
    expect(queueTabs(g).overdue.map((r) => r.sub.id)).toEqual(["unpaid"]);
    expect(g.renewedPaid.map((r) => r.sub.id)).toEqual(["paid"]);
    expect(g.urgentTab.map((r) => r.sub.id)).toEqual(["unpaid"]);
    expect(renewalRowStatus(rows[0].sub, -2, { tenantGraceDays: 0, today: TODAY, renewalPaid: true }).label).toBe("Renewed");
  });

  it("a settled renewed row (next term far off) reads Renewed", () => {
    const s = row("r", 300, { renewal_state: "renewed", renewal_date: "2027-08-30" }).sub;
    expect(renewalRowStatus(s, 300, { tenantGraceDays: 0, today: TODAY })).toMatchObject({ key: "renewed", label: "Renewed" });
  });
});

describe("R-2403 ONE status per row", () => {
  /* Ravi Shankar on staging: 473 seats, 12-month term billed monthly, renewal_date 1 Nov,
     renewal_state 'renewed' left from the last payment → the page showed "Expired 2d" +
     "Renewed" + "Grace over" + "1 month due" + "Renewed — nothing to send". */
  const ravi = row("ravi", -2, {
    customer_name: "Ravi Shankar", renewal_state: "renewed", renewal_date: "2026-11-01",
    billing_cycle: "monthly", start_date: "2025-11-02", mrr: 87_505,
  }).sub;

  it("Ravi Shankar resolves to one clear status: 'Nov bill not raised'", () => {
    const s = renewalRowStatus(ravi, -2, { tenantGraceDays: 1, today: TODAY });
    expect(s).toEqual({ key: "bills-not-raised", label: "Nov bill not raised", tone: "danger", note: null });
  });

  it("…and its action is Bill next part — not 'Renewed — nothing to send'", () => {
    const a = renewalRowAction(ravi, null, TODAY);
    expect(a.kind).toBe("generate");
    expect(a.text).not.toBe("Renewed — nothing to send");
    const set = renewalActionSet(ravi, null, { daysUntil: -2, tenantGraceDays: 1, canEndSubscription: true });
    expect(set.primary?.label).toBe("Bill next part");
  });

  it("billed monthly, two parts behind (REDOQ, 33 days): '2 bills not raised', never 'Expired'", () => {
    const redoq = row("redoq", -33, {
      renewal_state: "grace_period", renewal_date: "2026-09-30", billing_cycle: "monthly", start_date: "2025-10-01", mrr: 205_000,
    }).sub;
    const s = renewalRowStatus(redoq, -33, { tenantGraceDays: 1, today: TODAY });
    expect(s.label).toBe("2 bills not raised");
    expect(s.note, "R-2095 kept: oldest first").toBe("From 1 Oct 2026 — billed oldest first");
    expect(s.label).not.toMatch(/Expired/);
  });

  it("one part behind reads the month it starts: 'Oct bill not raised'", () => {
    const s = row("m", -10, { renewal_date: "2026-10-24", billing_cycle: "monthly", start_date: "2025-10-25" }).sub;
    expect(billsNotRaised(s, new Date("2026-10-30T06:30:00Z"))?.label).toBe("Oct bill not raised");
  });

  it("a yearly row past its date: 'Overdue Nd', and NO grace line when the company has no grace", () => {
    const s = row("y", -2, { renewal_date: "2026-11-01", renewal_state: "grace_period" }).sub;
    expect(renewalRowStatus(s, -2, { tenantGraceDays: 0, today: TODAY })).toEqual({ key: "overdue", label: "Overdue 2d", tone: "danger", note: null });
  });

  it("the grace line shows only when there is a grace: in grace → the stop date; over → owner decides", () => {
    const s = row("y", -2, { renewal_date: "2026-11-01" }).sub;
    expect(renewalRowStatus(s, -2, { tenantGraceDays: 7, today: TODAY }).note).toBe("In grace · service stops 9 Nov 2026 if unpaid");
    expect(renewalRowStatus(s, -2, { tenantGraceDays: 1, today: TODAY }).note).toBe("Grace over — owner decides (Grace over list)");
  });

  it("stale 'renewed' on a yearly row past its date is Overdue, not Renewed", () => {
    const s = row("y", -5, { renewal_date: "2026-10-29", renewal_state: "renewed" }).sub;
    expect(renewalRowStatus(s, -5, { tenantGraceDays: 0, today: TODAY }).key).toBe("overdue");
  });

  it("stopped, Won't renew and due rows", () => {
    expect(renewalRowStatus(row("s", -20, { renewal_state: "suspended" }).sub, -20, { tenantGraceDays: 0, today: TODAY }).label).toBe("Service stopped");
    expect(renewalRowStatus(row("w", 12, { auto_renew: false, renewal_date: "2026-11-15" }).sub, 12, { tenantGraceDays: 0, today: TODAY }).label)
      .toBe("Non-renewing · ends 15 Nov 2026");
    expect(renewalRowStatus(row("t", 0).sub, 0, { tenantGraceDays: 0, today: TODAY }).label).toBe("Due today");
    expect(renewalRowStatus(row("d", 5).sub, 5, { tenantGraceDays: 0, today: TODAY })).toMatchObject({ label: "Due in 5d", tone: "danger" });
    expect(renewalRowStatus(row("d", 20).sub, 20, { tenantGraceDays: 0, today: TODAY }).tone).toBe("warning");
    expect(renewalRowStatus(row("d", 50).sub, 50, { tenantGraceDays: 0, today: TODAY }).tone).toBe("muted");
  });
});

describe("R-2403 the renewal amount for the term (not MRR /mo)", () => {
  it("yearly: the term amount '/yr' + GST (MAHARSHI 26 seats ₹6,500/mo → ₹78,000/yr)", () => {
    const a = renewalAmount({ mrr: 6500, term_months: 12, term_amount: 78_000, billing_cycle: "yearly", renewal_quote_id: null }, null);
    expect(a).toEqual({ value: 78_000, text: "₹78,000/yr", gst: "+ GST", fromQuote: false });
  });

  it("no term_amount → mrr × term months", () => {
    expect(renewalAmount({ mrr: 6500, term_months: 12, billing_cycle: "yearly" }, null).text).toBe("₹78,000/yr");
  });

  it("an open renewal quote: its total incl. GST, naming the quote", () => {
    const a = renewalAmount(
      { mrr: 6500, term_months: 12, term_amount: 78_000, billing_cycle: "yearly", renewal_quote_id: "Q-A1" },
      { id: "Q-A1", amount: 92_040, status: "sent", payment_status: "none" });
    expect(a).toMatchObject({ value: 92_040, text: "₹92,040", gst: "incl. GST · Q-A1", fromQuote: true });
  });

  it("a closed / other quote is ignored", () => {
    const sub = { mrr: 100, term_months: 12, billing_cycle: "yearly", renewal_quote_id: "Q-1" };
    expect(renewalAmount(sub, { id: "Q-1", amount: 5000, status: "rejected" }).fromQuote).toBe(false);
    expect(renewalAmount(sub, { id: "Q-2", amount: 5000, status: "sent" }).fromQuote).toBe(false);
  });

  it("term suffixes", () => {
    expect([12, 1, 3, 6, 24, null].map(termSuffix)).toEqual(["/yr", "/mo", "/qtr", "/6 mo", "/2 yr", "/yr"]);
  });
});

describe("R-2403 sort and filter", () => {
  const q = (id: string, daysUntil: number, amount: number, over: Partial<QueueRow> = {}): QueueRow => ({
    id, daysUntil, amount, plan: "Workspace", vendor: "google", statusKey: "due", atRisk: false, customer: id, ...over,
  });
  const rows = [
    q("b", 5, 10_000), q("a", -2, 50_000, { statusKey: "overdue", atRisk: true }),
    q("c", 5, 90_000, { plan: "M365", vendor: "microsoft" }),
  ];
  it("date: most overdue first, ties by name; amount: largest first", () => {
    expect(sortQueue(rows, "date").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(sortQueue(rows, "amount").map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
  it("filters: product, status, vendor, at risk", () => {
    expect(filterQueue(rows, NO_FILTERS).length).toBe(3);
    expect(filterQueue(rows, { ...NO_FILTERS, product: "M365" }).map((r) => r.id)).toEqual(["c"]);
    expect(filterQueue(rows, { ...NO_FILTERS, status: "overdue" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterQueue(rows, { ...NO_FILTERS, vendor: "google" }).map((r) => r.id)).toEqual(["b", "a"]);
    expect(filterQueue(rows, { ...NO_FILTERS, atRisk: true }).map((r) => r.id)).toEqual(["a"]);
  });
  it("filter options are distinct and sorted", () => {
    expect(filterOptions(["M365", "Workspace", "M365", null, ""])).toEqual(["M365", "Workspace"]);
  });
});

describe("R-2403 bulk: tick rows → Send renewal quote", () => {
  const sel = [
    row("acme", 5),
    row("beta", -3, { renewal_date: "2026-10-31", renewal_quote_id: "Q-B" }),
    row("parts", -2, { renewal_date: "2026-11-01", billing_cycle: "monthly" }),
    row("leaver", 10, { auto_renew: false }),
    row("done", 300, { renewal_state: "renewed", renewal_date: "2027-08-30" }),
  ];
  const status = (id: string | null) => (id === "Q-B" ? "sent" : null);

  it("two normal rows are both sent; billed-in-parts, Won't renew and renewed are skipped with a reason", () => {
    const t = bulkQuoteTargets(sel, status, 0);
    expect(t.send.map((r) => r.sub.id)).toEqual(["acme", "beta"]);
    expect(t.skipped.map((s) => [s.row.sub.id, s.reason])).toEqual([
      ["parts", "billed in parts — use Bill next part"],
      ["leaver", "won't renew"],
      ["done", "Renewed — nothing to send"],
    ]);
  });

  it("the confirm names who gets it and who does not", () => {
    const t = bulkQuoteTargets(sel, status, 0);
    const c = bulkQuoteConfirm(t.send, t.skipped);
    expect(c.title).toBe("Send the renewal quote to 2 customers?");
    expect(c.body).toContain("ACME, BETA.");
    expect(c.body).toContain("Not sent (3): PARTS — billed in parts — use Bill next part");
  });
});

describe("R-2403 the page wires the one queue", () => {
  const page = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
  it("tabs are QUEUE_TABS (no At risk tab); At risk is a chip that filters", () => {
    expect(page).toContain("items={QUEUE_TABS.map((t) => ({");
    expect(page).not.toMatch(/\{ id: "risk"/);
    expect(page).toMatch(/aria-pressed=\{atRiskOn\}\s+onClick=\{\(\) => setAtRisk\(!atRiskOn\)\}/);
  });
  it("every row's status and amount come from queue.ts — no '/mo' MRR column, no second status chip", () => {
    expect(page).toContain("= renewalRowStatus(r.sub, r.daysUntil,");   // R-2404: computed once, also feeds the decision status
    expect(page).toContain("amount: renewalAmount(r.sub, quoteOf(r.sub)),");
    expect(page).not.toContain(">/mo<");
    expect(page).not.toMatch(/renewalStateLabel|expiredGraceText|Expired \{Math\.abs/);
    expect(page.match(/<StatusChip status=\{status\}/g)?.length).toBe(2);
  });
  it("sort + filters + bulk Send renewal quote / Send reminder on the ticked rows", () => {
    expect(page).toContain("sortQueue(filterQueue(");
    for (const l of ['aria-label="Sort renewals"', 'aria-label="Filter by product"', 'aria-label="Filter by status"', 'aria-label="Filter by vendor"']) {
      expect(page).toContain(l);
    }
    expect(page).toMatch(/<BulkActionBar count=\{selectedRows\.length\} noun="renewal"/);
    expect(page).toContain("bulkQuoteTargets(selectedRows,");
    expect(page).toContain("bulkReminderTargets(selectedRows, today, graceDays)");
    expect(page.match(/"\/api\/renewals\/send-now"/g)?.length).toBe(1);   // the existing route, one call site
  });
});
