/* R-2808 — the Bill together contract (R-2807's route follows it) and which rows go together. */
import { describe, it, expect, vi } from "vitest";
import {
  BILL_TOGETHER_PATH, billTogetherAvailable, billsWithText, canOfferBillTogether, createTogetherProforma,
  fetchBillTogetherPreview, suggestBillTogether, type BillTogetherRow,
} from "./bill-together";

const row = (o: Partial<BillTogetherRow> & { id: string }): BillTogetherRow => ({
  customerId: "c-itbuzz", customerName: "ITBUZZ Technologies", plan: "Business Standard", seats: 161,
  domain: "itbuzz.in", split: true, billable: true, billingCycle: "monthly", nextPartStart: "2026-10-01",
  lastQuoteId: null, lastInvoiceId: null, ...o,
});

describe("suggestBillTogether", () => {
  it("ITBUZZ: Standard + Starter whose last part was ONE invoice → one group (same-bill)", () => {
    const g = suggestBillTogether([
      row({ id: "std", lastInvoiceId: "INV-1", domain: "a.in" }),
      row({ id: "other", customerId: "c-x", lastInvoiceId: "INV-1" }),
      row({ id: "sta", plan: "Business Starter", seats: 49, lastInvoiceId: "INV-1", domain: "b.in", nextPartStart: "2026-10-15" }),
    ]);
    expect(g).toEqual([{ customerId: "c-itbuzz", customerName: "ITBUZZ Technologies", subIds: ["std", "sta"], why: "same-bill" }]);
  });

  it("same last proforma (quote) also groups", () => {
    expect(suggestBillTogether([row({ id: "a", lastQuoteId: "PI-9" }), row({ id: "b", lastQuoteId: "PI-9" })])[0].subIds).toEqual(["a", "b"]);
  });

  it("same domain + same next part + same cycle groups (same-domain); a different start or cycle does not", () => {
    expect(suggestBillTogether([row({ id: "a" }), row({ id: "b" })])).toEqual([
      { customerId: "c-itbuzz", customerName: "ITBUZZ Technologies", subIds: ["a", "b"], why: "same-domain" },
    ]);
    expect(suggestBillTogether([row({ id: "a" }), row({ id: "b", nextPartStart: "2026-10-15" })])).toEqual([]);
    expect(suggestBillTogether([row({ id: "a" }), row({ id: "b", billingCycle: "quarterly" })])).toEqual([]);
    expect(suggestBillTogether([row({ id: "a", domain: "ITBUZZ.in" }), row({ id: "b" })])).toHaveLength(1);
  });

  it("never across customers, never a yearly / not-due / no-customer row", () => {
    expect(suggestBillTogether([row({ id: "a", lastInvoiceId: "I" }), row({ id: "b", customerId: "c-2", lastInvoiceId: "I" })])).toEqual([]);
    expect(suggestBillTogether([row({ id: "a" }), row({ id: "b", split: false })])).toEqual([]);
    expect(suggestBillTogether([row({ id: "a" }), row({ id: "b", billable: false })])).toEqual([]);
    expect(suggestBillTogether([row({ id: "a", customerId: null }), row({ id: "b", customerId: null })])).toEqual([]);
  });

  it("links chain: a~b by invoice, b~c by domain → one group of three", () => {
    const g = suggestBillTogether([
      row({ id: "a", lastInvoiceId: "I", domain: "x.in" }),
      row({ id: "b", lastInvoiceId: "I" }),
      row({ id: "c" }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].subIds).toEqual(["a", "b", "c"]);
    expect(g[0].why).toBe("same-domain");
  });
});

describe("hint + offer", () => {
  const group = { customerId: "c", customerName: "C", subIds: ["a", "b", "c"], why: "same-bill" as const };
  const plan = (id: string) => ({ a: "Business Standard", b: "Business Starter", c: null } as Record<string, string | null>)[id];
  it("Bills with the other plans", () => {
    expect(billsWithText({ ...group, subIds: ["a", "b"] }, "a", plan)).toBe("Bills with Business Starter");
    expect(billsWithText(group, "a", plan)).toBe("Bills with Business Starter and another subscription");
    expect(billsWithText({ ...group, subIds: ["a", "b", "c", "d"] }, "a", plan)).toBe("Bills with Business Starter and 2 more");
  });
  it("ticked rows: 2+, one customer, all billed in parts", () => {
    expect(canOfferBillTogether([{ customerId: "c", split: true }])).toBe(false);
    expect(canOfferBillTogether([{ customerId: "c", split: true }, { customerId: "c", split: true }])).toBe(true);
    expect(canOfferBillTogether([{ customerId: "c", split: true }, { customerId: "d", split: true }])).toBe(false);
    expect(canOfferBillTogether([{ customerId: "c", split: true }, { customerId: "c", split: false }])).toBe(false);
    expect(canOfferBillTogether([{ customerId: null, split: true }, { customerId: null, split: true }])).toBe(false);
  });
});

describe("client (the route's contract)", () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it("probe: 404 / 403 → not there; 400 (no ids) or 200 → there", async () => {
    for (const [s, want] of [[404, false], [403, false], [401, false], [400, true], [200, true]] as const) {
      const f = vi.fn(async () => res(s, {}));
      expect(await billTogetherAvailable(f as unknown as typeof fetch)).toBe(want);
      expect(f).toHaveBeenCalledWith(BILL_TOGETHER_PATH, { method: "GET" });
    }
  });
  it("GET ?ids=a,b → the preview; an error status throws the route's words", async () => {
    const preview = { subs: [], total: { taxable: 0, tax: 0, gross: 0 }, currency: "INR" };
    const f = vi.fn(async () => res(200, preview));
    expect(await fetchBillTogetherPreview(["a", "b c"], f as unknown as typeof fetch)).toEqual(preview);
    expect(f).toHaveBeenCalledWith(`${BILL_TOGETHER_PATH}?ids=a,b%20c`, { method: "GET" });
    await expect(fetchBillTogetherPreview(["a"], (async () => res(500, { error: "Boom" })) as unknown as typeof fetch)).rejects.toThrow("Boom");
  });
  it("POST {ids} → the one proforma; a refusal names each sub's reason", async () => {
    const made = { quoteId: "PI-ET-0001", href: "/quotes/PI-ET-0001", alreadyExisted: false, subscriptionIds: ["a", "b"] };
    const f = vi.fn(async () => res(200, made));
    expect(await createTogetherProforma(["a", "b"], f as unknown as typeof fetch)).toEqual(made);
    expect(f).toHaveBeenCalledWith(BILL_TOGETHER_PATH, expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: ["a", "b"] }) }));
    const refused = (async () => res(409, { error: "Cannot bill these together", reasons: [{ subscriptionId: "b", code: "unpaid_earlier_part", text: "Its Oct part is still unpaid" }] })) as unknown as typeof fetch;
    await expect(createTogetherProforma(["a", "b"], refused)).rejects.toThrow("Cannot bill these together — Its Oct part is still unpaid");
  });
});
