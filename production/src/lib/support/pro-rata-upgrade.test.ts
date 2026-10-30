import { describe, it, expect } from "vitest";
import {
  proRataUpgrade, parseSupportTierSku, upgradeTargets, proRataUpgradeNote, DOWNGRADE_AT_RENEWAL,
} from "./pro-rata-upgrade";

/* A 366-day yearly term (it holds 29 Feb 2028), so "exactly half" is a whole number of days. */
const YEAR = { termStart: "2027-07-01", renewalDate: "2028-07-01" };

describe("R-2073 proRataUpgrade", () => {
  it("₹9,996 Standard yearly → ₹49,992 Enterprise yearly with half the term left = ₹19,998 ex-GST", () => {
    const r = proRataUpgrade({ fromTier: "standard", toTier: "enterprise", term: "yearly", ...YEAR, today: "2027-12-31" });
    expect(r).toEqual({
      ok: true, daysLeft: 183, daysInTerm: 366,
      newTierCharge: 24_996, oldTierCredit: 4_998, amountExGst: 19_998,
      fromPrice: 9_996, toPrice: 49_992,
    });
  });

  it("monthly: ₹999 → ₹4,999 with 15 of 30 days left = ₹2,000", () => {
    const r = proRataUpgrade({
      fromTier: "standard", toTier: "enterprise", term: "monthly",
      termStart: "2027-11-01", renewalDate: "2027-12-01", today: "2027-11-16",
    });
    expect(r.ok && [r.daysLeft, r.daysInTerm, r.newTierCharge, r.oldTierCredit, r.amountExGst])
      .toEqual([15, 30, 2_499.5, 499.5, 2_000]);
  });

  it("last day of the term charges one day, each side rounded to the paisa once", () => {
    const r = proRataUpgrade({
      fromTier: "standard", toTier: "enterprise", term: "yearly",
      termStart: "2027-01-01", renewalDate: "2028-01-01", today: "2027-12-31",
    });
    // 49,992 / 365 = 136.9643… → ₹136.96; 9,996 / 365 = 27.3863… → ₹27.39; difference ₹109.57 → ₹110.
    expect(r.ok && [r.daysLeft, r.daysInTerm, r.newTierCharge, r.oldTierCredit, r.amountExGst])
      .toEqual([1, 365, 136.96, 27.39, 110]);
  });

  it("the first day of the term charges the whole difference", () => {
    const r = proRataUpgrade({ fromTier: "standard", toTier: "enterprise", term: "yearly", ...YEAR, today: YEAR.termStart });
    expect(r.ok && r.amountExGst).toBe(49_992 - 9_996);
  });

  it("uses the catalogue's own prices when given", () => {
    const r = proRataUpgrade({
      fromTier: "standard", toTier: "enterprise", term: "yearly", ...YEAR, today: "2027-12-31",
      fromPrice: 12_000, toPrice: 60_000,
    });
    expect(r.ok && r.amountExGst).toBe(24_000);
  });

  it("free → standard credits nothing", () => {
    const r = proRataUpgrade({ fromTier: "free", toTier: "standard", term: "yearly", ...YEAR, today: "2027-12-31" });
    expect(r.ok && [r.oldTierCredit, r.amountExGst]).toEqual([0, 4_998]);
  });

  it("refuses the same tier", () => {
    const r = proRataUpgrade({ fromTier: "enterprise", toTier: "enterprise", term: "yearly", ...YEAR, today: "2027-12-31" });
    expect(r).toEqual({ ok: false, reason: "The customer is already on this plan." });
  });

  it("refuses a downgrade (D5: at renewal only)", () => {
    const r = proRataUpgrade({ fromTier: "enterprise", toTier: "standard", term: "yearly", ...YEAR, today: "2027-12-31" });
    expect(r).toEqual({ ok: false, reason: DOWNGRADE_AT_RENEWAL });
    expect(DOWNGRADE_AT_RENEWAL).toBe("Downgrades take effect at renewal");
  });

  it("refuses on or after the renewal date, and before the term starts", () => {
    expect(proRataUpgrade({ fromTier: "standard", toTier: "enterprise", term: "yearly", ...YEAR, today: YEAR.renewalDate }).ok).toBe(false);
    expect(proRataUpgrade({ fromTier: "standard", toTier: "enterprise", term: "yearly", ...YEAR, today: "2027-06-30" }).ok).toBe(false);
  });

  it("refuses when the catalogue makes the new plan no dearer", () => {
    const r = proRataUpgrade({
      fromTier: "standard", toTier: "enterprise", term: "yearly", ...YEAR, today: "2027-12-31", fromPrice: 50_000,
    });
    expect(r.ok).toBe(false);
  });
});

describe("R-2073 helpers", () => {
  it("parses tier SKUs only", () => {
    expect(parseSupportTierSku("SUP-STANDARD-YR-fbb976f1abc")).toEqual({ tier: "standard", term: "yearly" });
    expect(parseSupportTierSku("SUP-ENTERPRISE-MO")).toEqual({ tier: "enterprise", term: "monthly" });
    expect(parseSupportTierSku("SUP-GWS-STARTER-YR")).toBeNull();
    expect(parseSupportTierSku("GWS-STARTER")).toBeNull();
    expect(parseSupportTierSku(null)).toBeNull();
  });

  it("lists only dearer tiers", () => {
    expect(upgradeTargets("standard")).toEqual(["enterprise"]);
    expect(upgradeTargets("enterprise")).toEqual([]);
  });

  it("the note shows the calculation", () => {
    const r = proRataUpgrade({ fromTier: "standard", toTier: "enterprise", term: "yearly", ...YEAR, today: "2027-12-31" });
    if (!r.ok) throw new Error("expected ok");
    const note = proRataUpgradeNote({ fromLabel: "Standard", toLabel: "Enterprise", r, renewalDateText: "01 Jul 2028", fmt: (n) => `₹${n}` });
    expect(note).toContain("183 of 366 days");
    expect(note).toContain("= ₹24996");
    expect(note).toContain("= ₹4998");
    expect(note).toContain("₹19998 before GST");
    expect(note).toContain("renewal date stays 01 Jul 2028");
  });
});
