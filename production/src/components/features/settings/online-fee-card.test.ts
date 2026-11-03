/** R-2416 — Settings → Online payment fee: what the owner types → the saved policy. */
import { describe, expect, it } from "vitest";
import { parseOnlineFeeDraft } from "./online-fee-card";

const draft = (over: Partial<Parameters<typeof parseOnlineFeeDraft>[0]> = {}) =>
  ({ bearer: "customer" as const, rate: "2", above: "", lineText: "", ...over });

describe("parseOnlineFeeDraft (R-2416)", () => {
  it("Customer pays 2%, no threshold", () => {
    expect(parseOnlineFeeDraft(draft())).toEqual({
      ok: true, settings: { bearer: "customer", ratePct: 2, waiveAbove: null, lineText: null },
    });
  });
  it("We pay, 2.15%, threshold with commas and ₹, line text trimmed", () => {
    expect(parseOnlineFeeDraft(draft({ bearer: "business", rate: "2.15%", above: "₹1,00,000", lineText: "  Card / UPI fee " }))).toEqual({
      ok: true, settings: { bearer: "business", ratePct: 2.15, waiveAbove: 100000, lineText: "Card / UPI fee" },
    });
  });
  it("refuses a rate of 0, above 10, or with 3 decimals — and says what to type", () => {
    for (const rate of ["0", "11", "2.155", "two"]) {
      const r = parseOnlineFeeDraft(draft({ rate }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/^Rate: a percent above 0 and up to 10/);
    }
  });
  it("refuses a threshold that is not whole rupees", () => {
    const r = parseOnlineFeeDraft(draft({ above: "1000.50" }));
    expect(r.ok).toBe(false);
  });
});
