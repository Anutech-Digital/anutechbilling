import { describe, it, expect } from "vitest";
import { cartTotals, cycleLabel, isSingleUnit, singleUnitNote, type CartLine } from "./money";

/* ─────────────────────────────────────────────────────────────────────────────
   Cart ka hisaab — handoff ke formula, aur wahi order jo paisa sahi rakhta hai:
   coupon GROSS par lagta hai (GST se pehle), GST discount ke BAAD ke subtotal par.
   Ulta karne par sarkar ka hissa galat ban jata hai — isi liye ye pin hai.
   ───────────────────────────────────────────────────────────────────────────── */

const line = (over: Partial<CartLine>): CartLine => ({
  key: "k", label: "L", detail: "", unitPrice: 100, qty: 1, unit: "item", cycle: "once", ...over,
});

describe("cart ke totals", () => {
  it("gross = Σ unitPrice × qty", () => {
    const t = cartTotals([line({ unitPrice: 165, qty: 40 }), line({ unitPrice: 899, qty: 1 })], 0);
    expect(t.gross).toBe(165 * 40 + 899);
  });

  it("coupon gross par, GST discount ke baad — order maayne rakhta hai", () => {
    /* 1000 par 10%: discount 100, subtotal 900, GST 162, payable 1062.
       Agar GST pehle lagta to payable 1080 - 100 = 980... alag hota. */
    const t = cartTotals([line({ unitPrice: 1000 })], 0.10);
    expect(t.discount).toBe(100);
    expect(t.subtotal).toBe(900);
    expect(t.gst).toBeCloseTo(162);
    expect(t.payable).toBeCloseTo(1062);
  });

  it("galat coupon (rate 0) = koi discount nahi, error bhi nahi", () => {
    const t = cartTotals([line({})], 0); // the server said "not valid" (R-329)
    expect(t.discountRate).toBe(0);
    expect(t.payable).toBeCloseTo(118);
  });

  it("R-329: cart sirf server ka rate leta hai — bekaar rate (NaN, 0 se kam, 1 ya zyada) = koi discount nahi", () => {
    for (const r of [Number.NaN, -0.1, 1, 1.5]) expect(cartTotals([line({})], r).discount).toBe(0);
    expect(cartTotals([line({})], 0.1).discountRate).toBe(0.1);
  });

  it("recurring me sirf monthly line — yearly aur once nahi", () => {
    const t = cartTotals(
      [
        line({ unitPrice: 165, qty: 40, cycle: "monthly" }),
        line({ unitPrice: 899, cycle: "yearly" }),
        line({ unitPrice: 500, cycle: "once" }),
      ],
      0,
    );
    /* Yahi wo aankda hai jo "Then ₹X/month from next month" banata hai. Isme yearly ka
       ghusna grahak ko har mahine ka jhootha bojh dikhata. */
    expect(t.recurring).toBe(165 * 40);
  });

  it("khaali cart par sab shunya", () => {
    const t = cartTotals([], 0.10);
    expect(t.gross).toBe(0);
    expect(t.payable).toBe(0);
    expect(t.recurring).toBe(0);
  });
});

describe("cycle ke shabd", () => {
  it("teeno label", () => {
    expect(cycleLabel("monthly")).toBe("Recurring monthly");
    expect(cycleLabel("yearly")).toBe("Renews yearly");
    expect(cycleLabel("once")).toBe("One time");
  });
});

describe("singleUnitNote — why a line's quantity is locked at 1 (30 Sep 2026)", () => {
  it("names the reason for each single-unit kind", () => {
    expect(singleUnitNote({ sku: "hosting-trial:starter" })).toBe("1 per customer");
    expect(singleUnitNote({ sku: "hosting:plus" })).toBe("1 per order");
    expect(singleUnitNote({ sku: "domain:in" })).toBe("1 per domain");
  });
  it("is null for a line whose quantity can change, and every single-unit line has a note", () => {
    expect(singleUnitNote({ sku: "mail:pro" })).toBeNull();
    for (const sku of ["hosting-trial:starter", "hosting:starter", "domain:com"]) {
      expect(isSingleUnit({ sku })).toBe(true);
      expect(singleUnitNote({ sku })).not.toBeNull();
    }
  });
});

/* R-225 (7 Oct 2026): coupon domain par nahi lagta — domain registry cost ke kareeb bikta hai.
   Baaki lines par niyam wahi jo pehle tha. */
describe("coupon aur domain (R-225)", () => {
  it("sirf domain wali cart + sahi code = poora daam", () => {
    const t = cartTotals([line({ unitPrice: 799, sku: "domain:in", domain: "acme.in", cycle: "yearly" })], 0.10);
    expect(t.discount).toBe(0);
    expect(t.discountRate).toBe(0);
    expect(t.payable).toBeCloseTo(799 * 1.18);
  });

  it("workspace line par coupon pehle jaisa — gross ka 10%", () => {
    const t = cartTotals([line({ unitPrice: 270, qty: 10, sku: "workspace:starter", cycle: "monthly" })], 0.10);
    expect(t.discountRate).toBe(0.10);
    expect(t.discount).toBeCloseTo(270);
    expect(t.subtotal).toBeCloseTo(2430);
  });

  it("hosting + paid domain: discount sirf hosting par, domain poore daam", () => {
    const t = cartTotals(
      [
        line({ unitPrice: 2999, sku: "hosting:standard", cycle: "yearly" }),
        line({ unitPrice: 799, sku: "domain:in", domain: "acme.in", cycle: "yearly" }),
      ],
      0.10,
    );
    // 2999 → 2699 (whole rupees per unit), domain 799 untouched.
    expect(t.discount).toBe(300);
    expect(t.subtotal).toBe(2699 + 799);
  });

  it("₹0 bundle domain ke saath coupon pehle jaisa poore gross par", () => {
    const t = cartTotals(
      [
        line({ unitPrice: 2999, sku: "hosting:standard", cycle: "yearly" }),
        line({ unitPrice: 0, sku: "domain:in", domain: "acme.in", cycle: "yearly" }),
      ],
      0.15,
    );
    expect(t.discount).toBeCloseTo(2999 * 0.15);
  });
});
