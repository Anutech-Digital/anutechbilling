import { describe, it, expect } from "vitest";
import {
  OBLIGATIONS, obligationsFor, buildComplianceRows, UNKNOWN_PROFILE, toBusinessType, toGstFiling,
  type ComplianceProfile,
} from "./obligations";
import { profileFromRow, isMissingColumnError } from "./profile";

/**
 * R-262: the calendar assumed every tenant was a Pvt Ltd filing GST monthly — a
 * proprietor was told to file AOC-4 / MGT-7, and a QRMP filer saw GSTR-1 on the 11th
 * every month. Business type + GST filing mode now narrow it; unknown keeps today's list.
 */

const keys = (p: ComplianceProfile) => obligationsFor(p).map((o) => o.key);
const P = (businessType: ComplianceProfile["businessType"], gstFiling: ComplianceProfile["gstFiling"] = null) =>
  ({ businessType, gstFiling });
const COMPANY_ROC = ["roc_aoc4", "roc_mgt7", "roc_dpt3", "roc_adt1", "roc_agm"];

describe("unknown profile = today's behaviour", () => {
  it("returns OBLIGATIONS unchanged, same order", () => {
    expect(obligationsFor()).toEqual(OBLIGATIONS);
    expect(obligationsFor(UNKNOWN_PROFILE)).toEqual(OBLIGATIONS);
  });

  it("buildComplianceRows without a profile matches an unknown profile", () => {
    const d = new Date("2026-10-07T12:00:00+05:30");
    const a = buildComplianceRows(d, new Map()).map((r) => `${r.ob.key}|${r.inst.dueDate}`);
    const b = buildComplianceRows(d, new Map(), undefined, undefined, UNKNOWN_PROFILE).map((r) => `${r.ob.key}|${r.inst.dueDate}`);
    expect(b).toEqual(a);
  });

  it("an explicit Pvt Ltd on monthly GST is the same list", () => {
    expect(keys(P("pvt_ltd", "monthly"))).toEqual(OBLIGATIONS.map((o) => o.key));
  });
});

describe("business type", () => {
  it("a proprietor gets no AOC-4, MGT-7 or any ROC filing", () => {
    const k = keys(P("proprietor"));
    for (const roc of [...COMPANY_ROC, "roc_dir3kyc", "llp_form11", "llp_form8"]) expect(k).not.toContain(roc);
    expect(obligationsFor(P("proprietor")).some((o) => o.category === "roc")).toBe(false);
  });

  it("a proprietor files a business ITR, not the company ITR-6", () => {
    const k = keys(P("proprietor"));
    expect(k).not.toContain("it_itr6");
    expect(k).toContain("it_itr_business");
    // GST, TDS, payroll still apply to everyone
    for (const x of ["gst_gstr1", "gst_gstr3b", "tds_payment", "tds_return", "pf_ecr", "it_advance_tax"]) expect(k).toContain(x);
  });

  it("a partnership is like a proprietor for ROC", () => {
    const k = keys(P("partnership"));
    expect(obligationsFor(P("partnership")).some((o) => o.category === "roc")).toBe(false);
    expect(k).toContain("it_itr_business");
  });

  it("an LLP files Form 11 + Form 8 and DIR-3 KYC, not AOC-4/MGT-7", () => {
    const k = keys(P("llp"));
    for (const roc of COMPANY_ROC) expect(k).not.toContain(roc);
    expect(k).toEqual(expect.arrayContaining(["llp_form11", "llp_form8", "roc_dir3kyc", "it_itr_business"]));
    expect(k).not.toContain("it_itr6");
  });

  it("LLP forms report on the FY that ended", () => {
    const d = new Date("2026-04-10T12:00:00+05:30");
    const rows = buildComplianceRows(d, new Map(), ["roc"], undefined, P("llp"));
    const f11 = rows.find((r) => r.ob.key === "llp_form11")!;
    expect(f11.inst.dueDate).toBe("2026-05-30");
    expect(f11.inst.periodLabel).toBe("FY 2025-26");
    const f8 = rows.find((r) => r.ob.key === "llp_form8")!;
    expect(f8.inst.dueDate).toBe("2026-10-30");
  });

  it("the ROC page for a proprietor is empty", () => {
    expect(buildComplianceRows(new Date(2026, 9, 7), new Map(), ["roc"], undefined, P("proprietor"))).toEqual([]);
  });
});

describe("GST filing: QRMP", () => {
  const q = P("pvt_ltd", "qrmp");

  it("GSTR-1 is quarterly, due on the 13th after the quarter", () => {
    // 7 Oct 2026: Q2 (Jul–Sep) GSTR-1 is due 13 Oct.
    const rows = buildComplianceRows(new Date("2026-10-07T12:00:00+05:30"), new Map(), ["gst"], undefined, q);
    const g1 = rows.find((r) => r.ob.key === "gst_gstr1")!;
    expect(g1.ob.freq).toBe("quarterly");
    expect(g1.inst.dueDate).toBe("2026-10-13");
    expect(g1.inst.periodKey).toBe("2026-q2");
    expect(g1.inst.periodLabel).toContain("Q2");
  });

  it("every quarter lands on the 13th, Q4 in April of the next year", () => {
    const g1 = obligationsFor(q).find((o) => o.key === "gst_gstr1")!;
    expect(g1.next(new Date(2026, 5, 1)).dueDate).toBe("2026-07-13");
    expect(g1.next(new Date(2026, 11, 1)).dueDate).toBe("2027-01-13");
    expect(g1.next(new Date(2027, 2, 1)).dueDate).toBe("2027-04-13");
  });

  it("advances to the next quarter once filed", () => {
    const filed = new Map([["gst_gstr1|2026-q2", "2026-10-10"]]);
    const g1 = buildComplianceRows(new Date("2026-10-11T12:00:00+05:30"), filed, ["gst"], undefined, q)
      .find((r) => r.ob.key === "gst_gstr1")!;
    expect(g1.inst.dueDate).toBe("2027-01-13");
  });

  it("GSTR-3B is quarterly too, and PMT-06 appears only for QRMP", () => {
    const g3 = obligationsFor(q).find((o) => o.key === "gst_gstr3b")!;
    expect(g3.freq).toBe("quarterly");
    expect(g3.next(new Date(2026, 9, 7)).dueDate).toBe("2026-10-22");
    expect(keys(q)).toContain("gst_pmt06");
    expect(keys(P("pvt_ltd", "monthly"))).not.toContain("gst_pmt06");
  });

  it("PMT-06 is due on the 25th only after months 1 and 2 of a quarter", () => {
    const pmt = obligationsFor(q).find((o) => o.key === "gst_pmt06")!;
    // After Aug (month 2 of Q2) → 25 Sep. Sep is month 3: no PMT-06 on 25 Oct.
    expect(pmt.next(new Date(2026, 8, 20), (k) => k <= "2026-07")).toMatchObject({ dueDate: "2026-09-25", periodKey: "2026-08" });
    const filedUpTo = (last: string) => (k: string) => k <= last;
    expect(pmt.next(new Date(2026, 8, 26), filedUpTo("2026-08")).dueDate).toBe("2026-11-25"); // Oct → 25 Nov
    expect(pmt.next(new Date(2027, 1, 26), filedUpTo("2027-01")).dueDate).toBe("2027-03-25");  // Feb → 25 Mar
  });

  it("the monthly catalog itself is not mutated by a QRMP lookup", () => {
    obligationsFor(q);
    expect(OBLIGATIONS.find((o) => o.key === "gst_gstr1")!.freq).toBe("monthly");
  });

  it("keys stay unique for every profile — the filed-log is keyed on them", () => {
    for (const t of ["proprietor", "partnership", "llp", "pvt_ltd", null] as const) {
      for (const g of ["monthly", "qrmp", null] as const) {
        const k = keys(P(t, g));
        expect(new Set(k).size).toBe(k.length);
      }
    }
  });
});

describe("reading the profile when the columns may not exist yet", () => {
  it("a missing column reads as unknown, not as an error", () => {
    expect(profileFromRow(null, { code: "42703", message: 'column tenants.business_type does not exist' }))
      .toEqual({ businessType: null, gstFiling: null, columnsMissing: true });
    expect(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'gst_filing' column" })).toBe(true);
  });

  it("other errors still throw", () => {
    expect(() => profileFromRow(null, { code: "500", message: "boom" })).toThrow("boom");
  });

  it("unknown values in the row are treated as not set", () => {
    expect(profileFromRow({ business_type: "trust", gst_filing: "yearly" }, null))
      .toEqual({ businessType: null, gstFiling: null, columnsMissing: false });
    expect(profileFromRow({ business_type: "llp", gst_filing: "qrmp" }, null))
      .toEqual({ businessType: "llp", gstFiling: "qrmp", columnsMissing: false });
    expect(toBusinessType(undefined)).toBeNull();
    expect(toGstFiling("monthly")).toBe("monthly");
  });
});
