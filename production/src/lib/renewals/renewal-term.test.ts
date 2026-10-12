import { describe, it, expect } from "vitest";
import { renewalTerm, suspectAnnualMrr, type RenewalTermInput } from "./renewal-term";

/* The two real rows this was written from, measured 23 Aug 2026. */

/** c398e832 — "Xyz cloud solutions". term_months = 1, and mrr holds an ANNUAL figure. */
const XYZ: RenewalTermInput = {
  mrr: 32_400, termMonths: 1, seats: 10, catalogPerSeatMonth: 270,
};

/** BETACO — the healthy shape: 14 seats at ₹3,780 is exactly ₹270/seat/month. */
const BETACO: RenewalTermInput = {
  mrr: 3_780, termMonths: 12, seats: 14, catalogPerSeatMonth: 270,
};

describe("renewalTerm — the term is read, never assumed", () => {
  it("quotes a MONTHLY subscription for one month", () => {
    /* The defect: createOrGetRenewalQuote hardcoded `mrr * 12`, so a 1-month
       subscription was quoted for a year. term_months appears nowhere in that file,
       even though the reminder ladder shipped term-aware on 22 Aug. */
    const r = renewalTerm({ ...XYZ, mrr: 2_700 });   // a CORRECT monthly rate
    expect(r.ok).toBe(true);
    expect(r.ok && r.termMonths).toBe(1);
    expect(r.ok && r.subtotal).toBe(2_700);
    expect(r.ok && r.commitment).toBe("monthly");
  });

  it("quotes an ANNUAL subscription for twelve months, as before", () => {
    const r = renewalTerm(BETACO);
    expect(r.ok && r.subtotal).toBe(45_360);        // 3,780 x 12
    expect(r.ok && r.perSeatRate).toBe(3_240);      // 270 x 12, per seat per year
    expect(r.ok && r.commitment).toBe("annual_yearly");
  });

  it("labels a one-month renewal 'monthly', not an annual commitment", () => {
    /* record_payment reads `commitment` to decide what subscription to build on the way
       back in, so calling a monthly renewal "annual_yearly" produces the wrong one. */
    expect(renewalTerm({ ...BETACO, termMonths: 1, mrr: 3_780 }).ok
      && renewalTerm({ ...BETACO, termMonths: 1, mrr: 3_780 }).ok).toBe(true);
    const r = renewalTerm({ ...BETACO, termMonths: 1 });
    expect(r.ok && r.commitment).toBe("monthly");
  });

  it("handles other real terms — quarterly, half-yearly", () => {
    expect(renewalTerm({ ...BETACO, termMonths: 3 }).ok && renewalTerm({ ...BETACO, termMonths: 3 }).ok).toBe(true);
    const q = renewalTerm({ ...BETACO, termMonths: 3 });
    expect(q.ok && q.subtotal).toBe(11_340);        // 3,780 x 3
    expect(q.ok && q.commitment).toBe("annual_yearly");
  });

  it("falls back to 12 months when the term is missing or nonsensical", () => {
    /* Almost every row in this data is annual, so 12 is the safe default AND the
       historical behaviour — this change must not move the price of an existing
       annual renewal. */
    for (const t of [null, undefined, 0, -3, 999]) {
      const r = renewalTerm({ ...BETACO, termMonths: t as number | null });
      expect(r.ok && r.termMonths, String(t)).toBe(12);
      expect(r.ok && r.subtotal, String(t)).toBe(45_360);
    }
  });
});

describe("renewalTerm — an annual figure in a monthly field is refused, not repaired", () => {
  it("refuses the Xyz row rather than multiplying it again", () => {
    /* mrr 32,400 for 10 seats is ₹3,240/seat/month against a ₹270 catalogue price.
       The old code would have produced 32,400 x 12 = ₹3,88,800 ex-GST — about 144x the
       correct ₹2,700 monthly charge, four days out, on auto_renew. */
    const r = renewalTerm(XYZ);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("₹3,240");
    expect(r.ok === false && r.reason).toContain("₹270");
    expect(r.ok === false && r.reason).toMatch(/yearly figure in a monthly field/i);
    expect(r.ok === false && r.reason).toMatch(/Fix the subscription's MRR/i);
  });

  it("does NOT divide by 12 to 'repair' it", () => {
    /* Dividing would produce a plausible number from data known to be untrustworthy,
       and a plausible wrong price on a customer-facing quote is the worst outcome
       available. There is no ok:true result to inspect — that IS the assertion. */
    const r = renewalTerm(XYZ);
    expect(r.ok).toBe(false);
  });

  it("lets a genuine monthly rate through even a little above catalogue", () => {
    /* The threshold is 2x, not 12x, on purpose — a real monthly rate can exceed MSRP a
       little (a bundled add-on, a rounding) but not double it. Blocking those would make
       the guard unusable and it would get removed. */
    const r = renewalTerm({ mrr: 3_000, termMonths: 12, seats: 10, catalogPerSeatMonth: 270 });
    expect(r.ok).toBe(true);
    expect(r.ok && r.subtotal).toBe(36_000);
  });

  it("catches a 3x mistake too, not only exactly 12x", () => {
    const r = renewalTerm({ mrr: 8_100, termMonths: 12, seats: 10, catalogPerSeatMonth: 270 });
    expect(r.ok).toBe(false);
  });

  it("does not block a bespoke plan that has no catalogue price", () => {
    /* JIVA holds "ANUTECH DIGITAL PVT LTD Free Support" at a catalogue msrp of 0, and
       BETACO a plan with no catalogue row at all. Refusing those would stop real
       renewals over a check that cannot apply. */
    for (const catalog of [null, undefined, 0]) {
      const r = renewalTerm({ mrr: 99_999, termMonths: 12, seats: 1, catalogPerSeatMonth: catalog });
      expect(r.ok, String(catalog)).toBe(true);
    }
  });
});

describe("renewalTerm — refuses what cannot be priced", () => {
  it("refuses zero or missing seats", () => {
    for (const seats of [0, null, -2]) {
      const r = renewalTerm({ ...BETACO, seats: seats as number | null });
      expect(r.ok, String(seats)).toBe(false);
      expect(r.ok === false && r.reason).toMatch(/seat count/i);
    }
  });

  it("refuses zero or missing mrr", () => {
    for (const mrr of [0, null, -100]) {
      const r = renewalTerm({ ...BETACO, mrr: mrr as number | null });
      expect(r.ok, String(mrr)).toBe(false);
      expect(r.ok === false && r.reason).toMatch(/monthly rate/i);
    }
  });

  it("says what to do, not just what is wrong", () => {
    /* CLAUDE.md §24 — a guard on the money path that only refuses sends the operator to
       the database. */
    const reasons = [
      renewalTerm({ ...BETACO, seats: 0 }),
      renewalTerm({ ...BETACO, mrr: 0 }),
      renewalTerm(XYZ),
    ];
    for (const r of reasons) {
      expect(r.ok).toBe(false);
      expect(r.ok === false && /Set |Fix /.test(r.reason)).toBe(true);
    }
  });
});

describe("suspectAnnualMrr", () => {
  it("is true for the Xyz row and false for the healthy ones", () => {
    expect(suspectAnnualMrr(XYZ)).toBe(true);
    expect(suspectAnnualMrr(BETACO)).toBe(false);
  });

  it("is false whenever it has nothing to compare against", () => {
    expect(suspectAnnualMrr({ mrr: 1, termMonths: 12, seats: 0, catalogPerSeatMonth: 270 })).toBe(false);
    expect(suspectAnnualMrr({ mrr: 0, termMonths: 12, seats: 10, catalogPerSeatMonth: 270 })).toBe(false);
    expect(suspectAnnualMrr({ mrr: 99_999, termMonths: 12, seats: 10, catalogPerSeatMonth: null })).toBe(false);
  });
});
