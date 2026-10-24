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
    expect(t.payable).toBe(943); // R-1108: round(799 × 1.18), what the server charges
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
        // .ai: never the free domain (R-1595), so it stays a PAID domain next to the plan.
        line({ unitPrice: 7999, sku: "domain:ai", domain: "acme.ai", cycle: "yearly" }),
      ],
      0.10,
    );
    // 2999 → 2699 (whole rupees per unit), domain 7999 untouched.
    expect(t.discount).toBe(300);
    expect(t.subtotal).toBe(2699 + 7999);
  });

  it("bundle domain (yearly hosting ke saath ₹0) ke saath coupon pehle jaisa poore gross par", () => {
    const t = cartTotals(
      [
        line({ unitPrice: 2999, sku: "hosting:standard", cycle: "yearly" }),
        line({ unitPrice: 799, sku: "domain:in", domain: "acme.in", cycle: "yearly" }),
      ],
      0.15,
    );
    // R-1108: whole rupees, as the server stores it — subtotal round(2999 × 0.85) = 2549.
    expect(t.discount).toBe(450);
    expect(t.subtotal).toBe(2549);
  });
});

/* R-1108 (23 Oct 2026): the rows a buyer reads must add up, and the payable must be what the
   server charges (lib/checkout/cart-coupon.ts subtotal = round(...); cart-checkout.ts amount =
   round(subtotal × 1.18)). Rs 899 at 20% read 719 + 129 = 849 while the server charged 848. */
describe("R-1108 shown totals add up and equal the server's charge", () => {
  it("Rs 899 at 20% off reads 719 + 129 = 848 (server: round(719 × 1.18) = 848)", () => {
    const t = cartTotals([line({ unitPrice: 899 })], 0.2);
    expect([t.subtotal, t.gst, t.payable]).toEqual([719, 129, 848]);
    expect(t.discount).toBe(180);
  });
  it("grid: whole rupees, gross − discount = subtotal, subtotal + gst = payable = round(subtotal × 1.18)", () => {
    for (const price of [99, 149, 270, 499, 799, 899, 1299, 2399, 4999]) {
      for (const qty of [1, 3, 7]) {
        for (const rate of [0, 0.05, 0.1, 0.15, 0.2, 0.25]) {
          const t = cartTotals([line({ unitPrice: price, qty })], rate);
          for (const v of [t.discount, t.subtotal, t.gst, t.payable]) expect(Number.isInteger(v)).toBe(true);
          expect(t.gross - t.discount).toBe(t.subtotal);
          expect(t.subtotal + t.gst).toBe(t.payable);
          expect(t.payable).toBe(Math.round(t.subtotal * 1.18));
        }
      }
    }
  });
});

/* R-1601: kaunsa domain/mailbox free hai, har render par lines se — server ka hi niyam
   (lib/checkout/hosting-bundle.ts). unitPrice wahi rehta hai; daam priced[] me nikalta hai. */
describe("yearly hosting bundle cart me (R-1601)", () => {
  const hosting = (cycle: "yearly" | "monthly" = "yearly") => line({ key: "h", unitPrice: 2999, sku: "hosting:standard", cycle });
  const dom = (d: string, over: Partial<CartLine> = {}) =>
    line({ key: d, unitPrice: 799, sku: `domain:${d.slice(d.indexOf(".") + 1)}`, domain: d, cycle: "yearly", yearPrices: { "1": 799, "2": 1598 }, ...over });

  it("domain pehle, hosting baad me — domain ₹0 aur note", () => {
    const t = cartTotals([dom("acme.in"), hosting()], 0);
    expect(t.priced[0]).toMatchObject({ price: 0, total: 0, freeNote: "Free with yearly hosting" });
    expect(t.priced[0].line.unitPrice).toBe(799); // the line keeps its own price
    expect(t.gross).toBe(2999);
  });

  it("hosting hatao — domain ka daam wapas", () => {
    const t = cartTotals([dom("acme.in")], 0);
    expect(t.priced[0]).toMatchObject({ price: 799, total: 799, freeNote: null });
  });

  it("monthly plan kuch free nahi karta", () => {
    expect(cartTotals([dom("acme.in"), hosting("monthly")], 0).priced[0].total).toBe(799);
  });

  it(".ai kabhi free nahi", () => {
    expect(cartTotals([dom("acme.ai", { unitPrice: 7999, yearPrices: { "1": 7999 } }), hosting()], 0).priced[0].total).toBe(7999);
  });

  it("checkout par plan apne domain par — cart wala domain poora daam", () => {
    expect(cartTotals([hosting(), dom("new.in")], 0, ["mine.com"]).priced[1].total).toBe(799);
    expect(cartTotals([hosting(), dom("new.in")], 0, ["new.in"]).priced[1].total).toBe(0);
  });

  it("2 saal ka domain: sirf pehla saal free", () => {
    const t = cartTotals([dom("acme.in", { years: 2, unitPrice: 1598 }), hosting()], 0);
    expect(t.priced[0]).toMatchObject({ price: 799, freeNote: "1st year free with yearly hosting" });
  });

  it("10 mailbox + 1 yearly plan: 1 free, 9 ka daam", () => {
    const t = cartTotals([hosting(), line({ key: "m", unitPrice: 948, qty: 10, sku: "mailbox:anutech", cycle: "yearly" })], 0);
    expect(t.priced[1]).toMatchObject({ freeQty: 1, total: 9 * 948, freeNote: "1 of 10 free with yearly hosting" });
  });
});
