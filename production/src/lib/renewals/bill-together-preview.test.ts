/**
 * R-2807 — which ticked subscriptions can join the ONE together proforma, why the others cannot, the lines and
 * the total (pure half of /api/renewals/bill-together). ITBUZZ shape: Business Standard + Business Starter,
 * one customer, monthly, both "Part not billed (Oct)".
 */
import { describe, it, expect } from "vitest";
import { buildTogetherPreview, existingTogetherBill, parseTogetherIds, type TogetherFact } from "./bill-together-preview";

const TODAY = "2026-11-14";
const C1 = "c1", C2 = "c2";

function fact(id: string, o: Partial<NonNullable<TogetherFact["sub"]>> & { next?: Partial<NonNullable<TogetherFact["next"]>> | null; together?: TogetherFact["togetherBills"] } = {}): TogetherFact {
  const { next, together, ...sub } = o;
  return {
    id,
    sub: { id, customer_id: C1, customer_name: "ITBUZZ Technologies", plan: `Plan ${id}`, billing_cycle: "monthly", status: "active",
      auto_renew: true, renewal_quote_id: null, ...sub },
    next: next === null ? null : { seats: 10, seatRate: 161, periodStart: "2026-10-12", periodEnd: "2026-11-11", taxable: 1610, taxRate: 18,
      tax: 290, gross: 1900, unpaidEarlier: [], ...next },
    togetherBills: together ?? [],
  };
}

describe("R-2807 buildTogetherPreview", () => {
  it("two subs of one customer: both lines, total GST on the total taxable (the RPC's rule), currency INR", () => {
    const p = buildTogetherPreview([
      fact("a", { next: { seats: 161, seatRate: 51.5, taxable: 8291.5, tax: 1492, gross: 9783.5 } }),
      fact("b", { next: { seats: 49, seatRate: 31.5, taxable: 1543.5, tax: 278, gross: 1821.5 } }),
    ], TODAY);
    expect(p.subs.map((s) => s.reasons)).toEqual([[], []]);
    expect(p.subs[0].line).toMatchObject({ seats: 161, periodStart: "2026-10-12", periodEnd: "2026-11-11", taxRate: 18 });
    expect(p.total.taxable).toBe(9835);
    expect(p.total.tax).toBe(Math.round(9835 * 0.18));   // 1770, not 1492 + 278
    expect(p.total.gross).toBe(9835 + 1770);
    expect(p.currency).toBe("INR");
  });

  it("export / USD customer: amounts are the INR proforma's at 0% GST — currency stays INR (never ₹ numbers under $)", () => {
    const p = buildTogetherPreview([
      fact("a", { next: { taxRate: 0, tax: 0, gross: 1610 } }),
      fact("b", { next: { taxRate: 0, tax: 0, gross: 1610 } }),
    ], TODAY);
    expect(p.currency).toBe("INR");
    expect(p.total).toEqual({ taxable: 3220, tax: 0, gross: 3220 });
  });

  it("keeps the asked order; an unknown / foreign id is a sub with reason not_found, never an error", () => {
    const p = buildTogetherPreview([fact("a"), { id: "zz", sub: null, next: null, togetherBills: [] }, fact("b")], TODAY);
    expect(p.subs.map((s) => s.subscriptionId)).toEqual(["a", "zz", "b"]);
    expect(p.subs[1]).toMatchObject({ line: null, plan: null, reasons: [{ code: "not_found" }] });
    expect(p.total.taxable).toBe(3220);
  });

  it("other customer, yearly, Won't renew, not active, open renewal quote, unpaid earlier part — each its reason, out of the total", () => {
    const p = buildTogetherPreview([
      fact("a"),
      fact("other", { customer_id: C2, customer_name: "Someone Else" }),
      fact("yr", { billing_cycle: "yearly", next: null }),
      fact("wr", { auto_renew: false, next: null }),
      fact("sus", { status: "suspended", next: null }),
      fact("rq", { renewal_quote_id: "Q-0001" }),
      fact("up", { next: { unpaidEarlier: [{ kind: "proforma", id: "PI-0009", start: "2026-09-12", end: "2026-10-11", due: 1900, currency: "INR", dueDate: "2026-09-12", daysOverdue: 63 }] } }),
    ], TODAY);
    const codes = Object.fromEntries(p.subs.map((s) => [s.subscriptionId, s.reasons.map((r) => r.code)]));
    expect(codes).toEqual({ a: [], other: ["other_customer"], yr: ["yearly"], wr: ["not_billable"], sus: ["not_billable"], rq: ["open_renewal_quote"], up: ["unpaid_earlier_part"] });
    expect(p.subs.find((s) => s.subscriptionId === "other")!.reasons[0].text).toMatch(/Someone Else's, not ITBUZZ Technologies's/);
    expect(p.subs.find((s) => s.subscriptionId === "up")!.reasons[0].text).toMatch(/PI-0009/);
    expect(p.subs.filter((s) => s.line).map((s) => s.subscriptionId)).toEqual(["a"]);
    expect(p.total.taxable).toBe(1610);
    /* one reason per code at most (the dialog keys its lines by code) */
    for (const s of p.subs) expect(new Set(s.reasons.map((r) => r.code)).size).toBe(s.reasons.length);
  });

  it("its NEXT part already on a live together proforma: reason + onTogetherBill naming the other plans", () => {
    const together = [{ quoteId: "PI-0042", status: "sent", withPlans: ["Business Starter"], subscriptionIds: ["a", "b"], partPeriodStart: "2026-10-12", earliestOpen: true }];
    const p = buildTogetherPreview([fact("a", { together })], TODAY);
    expect(p.subs[0].onTogetherBill).toEqual({ quoteId: "PI-0042", status: "sent", withPlans: ["Business Starter"] });
    expect(p.subs[0].reasons).toEqual([{ code: "already_together", text: expect.stringContaining("PI-0042 with Business Starter") }]);
    expect(p.subs[0].line).toBeNull();
  });

  it("an OLDER part on a live together proforma (October) does not make November 'already on it' (review F1)", () => {
    const together = [{ quoteId: "PI-OCT", status: "sent", withPlans: ["Business Starter"], subscriptionIds: ["a", "b"], partPeriodStart: "2026-10-12", earliestOpen: true }];
    const p = buildTogetherPreview([fact("a", { together, next: { periodStart: "2026-11-12", periodEnd: "2026-12-11" } })], TODAY);
    expect(p.subs[0].onTogetherBill).toBeNull();
    expect(p.subs[0].reasons.map((r) => r.code)).not.toContain("already_together");
  });

  it("different GST rate from the first joinable one → different_gst", () => {
    const p = buildTogetherPreview([fact("a"), fact("b", { next: { taxRate: 5, tax: 81, gross: 1691 } })], TODAY);
    expect(p.subs[1].reasons.map((r) => r.code)).toEqual(["different_gst"]);
    expect(p.total.tax).toBe(Math.round(1610 * 0.18));
  });

  it("a part not started yet next to a started one → not_billable (R-2519b, as the RPC refuses); all not started → fine", () => {
    const mixed = buildTogetherPreview([fact("a"), fact("b", { next: { periodStart: "2026-12-12", periodEnd: "2027-01-11" } })], TODAY);
    expect(mixed.subs[1].reasons).toEqual([{ code: "not_billable", text: expect.stringContaining("12 Dec 2026") }]);
    const ahead = buildTogetherPreview([
      fact("a", { next: { periodStart: "2026-12-12" } }), fact("b", { next: { periodStart: "2026-12-01" } }),
    ], TODAY);
    expect(ahead.subs.every((s) => s.reasons.length === 0)).toBe(true);
  });

  it("next part could not be worked out → not_billable with the plain phrase", () => {
    const p = buildTogetherPreview([{ ...fact("a", { next: null }), nextError: "its billing data could not be read" }], TODAY);
    expect(p.subs[0].reasons[0]).toMatchObject({ code: "not_billable", text: expect.stringContaining("its billing data could not be read") });
  });
});

describe("R-2807 existingTogetherBill (double submit)", () => {
  const t = (ids: string[], earliestOpen = true) => [{ quoteId: "PI-7", status: "sent", withPlans: [], subscriptionIds: ids, partPeriodStart: "2026-10-12", earliestOpen }];
  it("every asked sub's oldest open part on the same proforma holding exactly them → that proforma", () => {
    expect(existingTogetherBill([fact("a", { together: t(["a", "b"]) }), fact("b", { together: t(["a", "b"]) })])).toBe("PI-7");
  });
  it("a proforma with another sub too, a sub not on it, a missing sub, or not their oldest open part → null", () => {
    expect(existingTogetherBill([fact("a", { together: t(["a", "b", "c"]) }), fact("b", { together: t(["a", "b", "c"]) })])).toBeNull();
    expect(existingTogetherBill([fact("a", { together: t(["a", "b"]) }), fact("b")])).toBeNull();
    expect(existingTogetherBill([fact("a", { together: t(["a"]) }), { id: "x", sub: null, next: null, togetherBills: [] }])).toBeNull();
    expect(existingTogetherBill([fact("a", { together: t(["a", "b"], false) }), fact("b", { together: t(["a", "b"], false) })])).toBeNull();
  });
});

describe("R-2807 parseTogetherIds", () => {
  it("comma string or array, trimmed, no empties or repeats, order kept", () => {
    expect(parseTogetherIds(" a, b ,,a,c")).toEqual(["a", "b", "c"]);
    expect(parseTogetherIds(["b", "b", " a ", 3, null])).toEqual(["b", "a"]);
    expect(parseTogetherIds(undefined)).toEqual([]);
  });
});
