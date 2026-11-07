/**
 * R-1473 (second pass, 7 Nov 2026) — Pawan's ✗ Galat on staging (24 Oct):
 *   "Tile ₹67,855 hai par Companies list me sirf Kochi ₹25,488 (Delhi Traders list se gayab,
 *    chip 2 dikhata hai), Renewals ka jod ₹44,746 — ₹23,109 ka hisaab kahin nahi."
 *
 * The numbers fit one shape: Kochi owes ₹25,488 on a subscription; Delhi Traders owes ₹19,258 on
 * a subscription + ₹23,109 on a project invoice, and Delhi Traders is ARCHIVED. The dashboard tile
 * and the Companies "To collect" tile / "Has receivables" chip count every company; the list hid
 * archived ones; Renewals only ever shows subscription dues. These tests feed that data to the
 * same functions the three screens use.
 */
import { describe, it, expect } from "vitest";
import { toChaseSummary, subscriptionDuesLine, toCollectBreakdown } from "@/lib/accounting/receivables-due";
import { customerInList, collectLineState } from "./server-list";

const KOCHI = "kochi";
const DELHI = "delhi-traders";
const subs = [
  { customer_id: KOCHI, outstanding_amount: 25_488 },
  { customer_id: DELHI, outstanding_amount: 19_258 },
];
const projects = { [DELHI]: 23_109 };
const customers = [
  { id: KOCHI, is_active: true },
  { id: DELHI, is_active: false }, // archived
];

describe("R-1473 Pawan's staging data — the same ₹67,855 everywhere", () => {
  const chase = toChaseSummary(subs, projects);

  it("the dashboard tile and the Companies tile are ₹67,855", () => {
    expect(chase.total).toBe(67_855);
    expect(chase.companiesTotal).toBe(67_855);
  });

  it("Has receivables lists BOTH companies (an archived company that owes is not hidden)", () => {
    const listed = customers.filter((c) =>
      customerInList(c.is_active, { showArchived: false, viewId: "unpaid", owes: chase.byCustomer.get(c.id) ?? 0 }));
    expect(listed.map((c) => c.id)).toEqual([KOCHI, DELHI]);
    const listSum = listed.reduce((s, c) => s + (chase.byCustomer.get(c.id) ?? 0), 0);
    expect(listSum).toBe(67_855);
  });

  it("the line over the list adds up to the tile and names the archived company", () => {
    const listedIds = new Set(customers.map((c) => c.id));
    const archivedIds = new Set([DELHI]);
    const line = toCollectBreakdown(chase, listedIds, archivedIds);
    expect(line).toContain("Subscription dues ₹44,746");
    expect(line).toContain("project invoices ₹23,109");
    expect(line).toContain("₹67,855");
    expect(line).toContain("1 archived company");
  });

  it("Renewals says its ₹44,746 is subscriptions only and where the ₹23,109 is", () => {
    const line = subscriptionDuesLine(chase, 44_746);
    expect(line).toBe("₹44,746 unpaid on these renewals · Companies › Has receivables ₹67,855 also has project invoices ₹23,109");
  });
});

describe("R-1473 customerInList — which rows the Companies list shows", () => {
  it("every other view keeps the old rule: active only, Archived switch shows archived only", () => {
    expect(customerInList(true, { showArchived: false, viewId: "all", owes: 0 })).toBe(true);
    expect(customerInList(false, { showArchived: false, viewId: "all", owes: 5_000 })).toBe(false);
    expect(customerInList(false, { showArchived: true, viewId: "all", owes: 0 })).toBe(true);
    expect(customerInList(true, { showArchived: true, viewId: "all", owes: 0 })).toBe(false);
    expect(customerInList(null, { showArchived: false, viewId: "all", owes: 0 })).toBe(true);
  });
  it("Has receivables shows an archived company only while it owes", () => {
    expect(customerInList(false, { showArchived: false, viewId: "unpaid", owes: 1 })).toBe(true);
    expect(customerInList(false, { showArchived: false, viewId: "unpaid", owes: 0 })).toBe(false);
  });
});

describe("R-1473 toCollectBreakdown — names money the list cannot show", () => {
  it("says how much sits on companies that are not in the list (e.g. not readable)", () => {
    const chase = toChaseSummary([{ customer_id: "a", outstanding_amount: 1_000 }, { customer_id: "b", outstanding_amount: 500 }]);
    const line = toCollectBreakdown(chase, new Set(["a"]), new Set());
    expect(line).toContain("₹500 on 1 company not in this list");
  });
  it("says nothing extra when every company is listed and none is archived", () => {
    const chase = toChaseSummary([{ customer_id: "a", outstanding_amount: 1_000 }]);
    const line = toCollectBreakdown(chase, new Set(["a"]), new Set());
    expect(line).toBe("Subscription dues ₹1,000 = ₹1,000 to collect");
  });
  it("names dues on subscriptions with no company — in the dashboard figure, never in this list", () => {
    const chase = toChaseSummary([{ customer_id: "a", outstanding_amount: 1_000 }, { customer_id: null, outstanding_amount: 300 }]);
    const line = toCollectBreakdown(chase, new Set(["a"]), new Set());
    // the parts add up to the figure: the ₹300 with no company is named apart, not in "Subscription dues"
    expect(line).toBe("Subscription dues ₹1,000 = ₹1,000 to collect · + ₹300 on 1 subscription with no company linked (in the dashboard figure)");
  });
});

describe("R-1473 subscriptionDuesLine", () => {
  it("is null when nothing is unpaid", () => {
    expect(subscriptionDuesLine(toChaseSummary([]), 0)).toBeNull();
  });
  it("has no rest when the renewals hold every due", () => {
    expect(subscriptionDuesLine(toChaseSummary([{ customer_id: "a", outstanding_amount: 2_000 }]), 2_000))
      .toBe("₹2,000 unpaid on these renewals");
  });
  it("names dues on subscriptions that are not on Renewals (cancelled, no renewal date)", () => {
    const all = toChaseSummary([{ customer_id: "a", outstanding_amount: 2_000 }, { customer_id: "b", outstanding_amount: 10_000 }]);
    expect(subscriptionDuesLine(all, 2_000))
      .toBe("₹2,000 unpaid on these renewals · Companies › Has receivables ₹12,000 also has ₹10,000 on subscriptions not listed here");
  });
  it("does not open with ₹0 when only project money is owed", () => {
    expect(subscriptionDuesLine(toChaseSummary([], { a: 23_109 }), 0))
      .toBe("No renewal unpaid · Companies › Has receivables ₹23,109 also has project invoices ₹23,109");
  });
  it("says so when the project read failed", () => {
    expect(subscriptionDuesLine(toChaseSummary([{ customer_id: "a", outstanding_amount: 2_000 }]), 2_000, true))
      .toBe("₹2,000 unpaid on these renewals · Project invoices couldn't be read");
  });
});

describe("R-2559 the line waits for both halves (no 'Subscription dues ₹0 … = ₹23,109' while loading)", () => {
  const loaded = { data: [], isError: false };
  const loading = { data: undefined, isError: false };
  const failed = { data: undefined, isError: true };
  it("is loading while the subscription dues or the project invoices are still being read", () => {
    expect(collectLineState([loading, loaded])).toBe("loading");
    expect(collectLineState([loaded, loading])).toBe("loading");
  });
  it("is ready only when every part is in", () => {
    expect(collectLineState([loaded, { data: {}, isError: false }])).toBe("ready");
  });
  it("is failed when a read failed — the page's money error says so; no half-made line", () => {
    expect(collectLineState([failed, loaded])).toBe("failed");
    expect(collectLineState([failed, loading])).toBe("failed");
  });
  it("stays ready when a background refetch failed but the last good data is still there", () => {
    expect(collectLineState([{ data: [], isError: true }, loaded])).toBe("ready");
  });
});
