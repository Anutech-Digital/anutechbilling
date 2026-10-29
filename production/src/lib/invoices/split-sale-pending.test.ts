/**
 * R-2057 — the pending GST invoice list on a sale billed in parts. Owner's example (28 Oct, staging):
 * Q-A378-27-0021, ₹3,83,972 a year (₹3,25,400 + 18%), billed quarterly → Q1 = ₹81,350 + ₹14,643 =
 * ₹95,993; ₹95,933 received.
 */
import { describe, it, expect } from "vitest";
import { pendingPartAction, partGenerateResult, partPeriodText, partName, type SplitSaleStatus } from "./split-sale-pending";

const quote = {
  subtotal: 325400, discount_pct: 0, tax_rate: 18, amount: 383972, billing_cycle: "quarterly",
  line_items: [{ name: "Workspace", qty: 1, rate: 325400, commitment: "annual_quarterly" }],
  payment_amount: 95993,
};

function st(p: Partial<SplitSaleStatus>): SplitSaleStatus {
  return {
    quote_id: "Q-A378-27-0021", state: "ready", cycle: "quarterly", period_index: 1, period_label: "Q1",
    period_start: "2026-10-01", period_end: "2027-01-01", gross: 95993, credit: 95993, invoice_id: null,
    term_start: "2026-10-01", ...p,
  };
}

describe("partPeriodText — the payment request's own words", () => {
  it("end is exclusive", () => {
    expect(partPeriodText("2026-10-01", "2027-01-01")).toBe("1 Oct–31 Dec 2026");
    expect(partPeriodText("2026-09-28", "2026-12-28")).toBe("28 Sep–27 Dec 2026");
  });
  it("no dates → null", () => expect(partPeriodText(null, "2027-01-01")).toBeNull());
  it("names", () => {
    expect(partName("quarterly", 1)).toBe("Q1");
    expect(partName("half_yearly", 2)).toBe("H2");
    expect(partName("monthly", 3)).toBe("Month 3");
  });
});

describe("pendingPartAction", () => {
  it("not billed in parts → the whole-quote Generate, unchanged", () => {
    expect(pendingPartAction(undefined, quote)).toEqual({ kind: "whole" });
  });

  it("Q1 paid, not invoiced → Generate invoice for Q1 with its period and amount (not the year)", () => {
    const a = pendingPartAction(st({}), quote);
    expect(a).toMatchObject({ kind: "part", part: "Q1", amount: 95993 });
    if (a.kind !== "part") throw new Error("kind");
    expect(a.button).toBe("Generate invoice for Q1 · 1 Oct–31 Dec 2026 ₹95,993");
    expect(a.button).not.toContain("3,83,972");
  });

  it("Q1 already invoiced → not pending (the row goes)", () => {
    expect(pendingPartAction(st({ state: "invoiced", invoice_id: "INV-1" }), quote)).toEqual({ kind: "hide" });
  });

  it("the unpaid later part is owed on its own request → not pending", () => {
    expect(pendingPartAction(st({ state: "on_request", period_index: 2, period_label: "Q2" }), quote)).toEqual({ kind: "hide" });
  });

  it("owner's numbers: ₹95,933 of ₹95,993 → no Generate, says ₹60 short and the next step", () => {
    const a = pendingPartAction(st({ state: "short", credit: 95933 }), quote);
    expect(a.kind).toBe("short");
    if (a.kind !== "short") throw new Error("kind");
    expect(a.note).toContain("₹60 short");
    expect(a.note).toContain("record the rest");
  });

  it("not laid yet, Q1 paid → Generate for Q1 from the same schedule engine", () => {
    const a = pendingPartAction(st({ state: "not_laid", period_label: null, period_start: null, period_end: null, gross: null }), quote);
    expect(a).toMatchObject({ kind: "part", part: "Q1", amount: 95993, period: "1 Oct–31 Dec 2026" });
  });

  it("not laid yet, short → the note, no Generate", () => {
    const a = pendingPartAction(st({ state: "not_laid", credit: 95933, period_label: null, gross: null }), quote);
    expect(a.kind).toBe("short");
  });
});

describe("partGenerateResult — what Generate's answer means", () => {
  const inv = { subscription_id: "s", period_index: 1, part: "Q1", invoice_id: "INV-27-0007", gross: 95993, period_start: "2026-10-01", period_end: "2027-01-01" };

  it("raised now → names the part, the invoice, the period; Open invoice goes to it", () => {
    const r = partGenerateResult({ raised: [{ invoice_id: "INV-27-0007" }], invoices: [{ ...inv, raised_now: true }] });
    expect(r).toEqual({ kind: "raised", invoiceId: "INV-27-0007", title: "Q1 invoice INV-27-0007 issued", description: "1 Oct–31 Dec 2026 · ₹95,993" });
  });

  it("pressed again → the same invoice, opened, not a new one", () => {
    const r = partGenerateResult({ raised: [], invoices: [{ ...inv, raised_now: false }] });
    expect(r).toMatchObject({ kind: "existing", invoiceId: "INV-27-0007", title: "Q1 is already invoiced — INV-27-0007" });
  });

  it("nothing invoiced → says why, never a silent success", () => {
    expect(partGenerateResult({ raised: [], invoices: [], errors: [{ message: "Delhi has no state" }] }))
      .toEqual({ kind: "refused", title: "No invoice was issued", description: "Delhi has no state" });
    expect(partGenerateResult({ raised: [], invoices: [] }).kind).toBe("refused");
  });
});
