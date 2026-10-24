/* R-1842 — one place that says what a business type means: labels, ITR form, ROC filings,
   and what changes when the stored type is corrected. Null = Pvt Ltd, as the calendar does today. */
import { describe, expect, it } from "vitest";

import { businessTypeChange, businessTypeHint, entityProfile, resolveBusinessType } from "./entity";

describe("entityProfile — words for each business type", () => {
  it("proprietor: Owner, Owner's capital, Drawings, ITR-3 on the owner's PAN, no ROC filings", () => {
    const p = entityProfile("proprietor");
    expect(p.label).toBe("Proprietor");
    expect(p.peopleLabel).toBe("Owner");
    expect(p.capitalLabel).toBe("Owner's capital");
    expect(p.drawingsLabel).toBe("Drawings");
    expect(p.itrForm).toBe("ITR-3");
    expect(p.itrText).toBe("ITR-3 on the owner's PAN");
    expect(p.rocFilings).toEqual([]);
  });

  it("partnership: Partners, Partners' capital, Partner drawings, ITR-5, no ROC filings", () => {
    const p = entityProfile("partnership");
    expect(p.peopleLabel).toBe("Partners");
    expect(p.capitalLabel).toBe("Partners' capital");
    expect(p.drawingsLabel).toBe("Partner drawings");
    expect(p.itrForm).toBe("ITR-5");
    expect(p.rocFilings).toEqual([]);
  });

  it("LLP: Designated partners, Partners' capital, ITR-5, Form 11 + Form 8 + DIR-3 KYC", () => {
    const p = entityProfile("llp");
    expect(p.peopleLabel).toBe("Designated partners");
    expect(p.capitalLabel).toBe("Partners' capital");
    expect(p.drawingsLabel).toBe("Partner drawings");
    expect(p.itrForm).toBe("ITR-5");
    expect(p.rocFilings).toEqual(expect.arrayContaining(["Form 11", "Form 8", "DIR-3 KYC Web"]));
    expect(p.rocFilings).not.toContain("AOC-4");
  });

  it("Pvt Ltd: Directors, Share capital, no drawings, ITR-6, company ROC filings", () => {
    const p = entityProfile("pvt_ltd");
    expect(p.peopleLabel).toBe("Directors");
    expect(p.capitalLabel).toBe("Share capital");
    expect(p.equityHeading).toBe("Share capital + Reserves and surplus");
    expect(p.drawingsLabel).toBeNull();
    expect(p.itrForm).toBe("ITR-6");
    expect(p.rocFilings).toEqual(expect.arrayContaining(["AOC-4", "MGT-7A", "ADT-1", "AGM", "DIR-3 KYC Web"]));
  });

  it("not set (null / undefined / junk) behaves exactly like Pvt Ltd — today's behaviour", () => {
    expect(resolveBusinessType(null)).toBe("pvt_ltd");
    expect(resolveBusinessType(undefined)).toBe("pvt_ltd");
    expect(entityProfile(null)).toEqual(entityProfile("pvt_ltd"));
  });

  it("the Settings hint is built from the same facts", () => {
    expect(businessTypeHint("proprietor")).toBe("No ROC filings. ITR-3 on the owner's PAN.");
    expect(businessTypeHint("partnership")).toBe("No ROC filings. ITR-5 for the firm.");
    expect(businessTypeHint("llp")).toBe("DIR-3 KYC Web, Form 11, Form 8. ITR-5 for the LLP.");
    expect(businessTypeHint("pvt_ltd")).toMatch(/AOC-4.*AGM.*ITR-6 for the company\.$/);
  });
});

describe("businessTypeChange — what the owner is told before saving", () => {
  it("Proprietor → Pvt Ltd: + AOC-4, MGT-7A, ADT-1, AGM; ITR-3 → ITR-6 shown once, as its own row", () => {
    const c = businessTypeChange("proprietor", "pvt_ltd")!;
    expect(c.added).toEqual(expect.arrayContaining(["AOC-4", "MGT-7A", "ADT-1", "AGM", "DIR-3 KYC Web"]));
    expect(c.added).not.toContain("ITR-6");
    expect(c.removed).toEqual([]);
    expect(c.rows).toEqual(expect.arrayContaining([
      { what: "Income-tax return", from: "ITR-3 on the owner's PAN", to: "ITR-6 for the company" },
      { what: "People", from: "Owner", to: "Directors" },
      { what: "Capital", from: "Owner's capital", to: "Share capital" },
      { what: "Drawings", from: "Drawings", to: "Not used (pay directors through payroll)" },
      { what: "Balance Sheet equity", from: "Owner's capital", to: "Share capital + Reserves and surplus" },
    ]));
  });

  it("Proprietor → Partnership: calendar unchanged, ITR-3 → ITR-5, labels change", () => {
    const c = businessTypeChange("proprietor", "partnership")!;
    expect(c.added).toEqual([]);
    expect(c.removed).toEqual([]);
    expect(c.rows.find((r) => r.what === "Income-tax return")).toEqual(
      { what: "Income-tax return", from: "ITR-3 on the owner's PAN", to: "ITR-5 for the firm" });
    expect(c.rows.find((r) => r.what === "People")?.to).toBe("Partners");
  });

  it("Partnership → LLP lists only what differs", () => {
    const c = businessTypeChange("partnership", "llp")!;
    expect(c.added).toEqual(expect.arrayContaining(["Form 11", "Form 8", "DIR-3 KYC Web"]));
    expect(c.rows.map((r) => r.what)).not.toContain("Capital");
  });

  it("no change: same type, or not set → Pvt Ltd (null already means Pvt Ltd)", () => {
    expect(businessTypeChange("llp", "llp")).toBeNull();
    expect(businessTypeChange(null, "pvt_ltd")).toBeNull();
  });

  it("not set → Proprietor shows the company filings going away", () => {
    const c = businessTypeChange(null, "proprietor")!;
    expect(c.removed).toEqual(expect.arrayContaining(["AOC-4", "MGT-7A", "AGM"]));
    expect(c.added).toEqual([]);
    expect(c.rows[0]).toEqual({ what: "Income-tax return", from: "ITR-6 for the company", to: "ITR-3 on the owner's PAN" });
  });
});
