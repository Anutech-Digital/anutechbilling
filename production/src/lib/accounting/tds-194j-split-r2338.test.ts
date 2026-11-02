/**
 * R-2338 (1 Nov 2026, owner + CA): vendor TDS — 194J split into technical services 2% /
 * professional fees 10% / royalty (software licence) 10%, and each vendor remembers its section
 * only when the owner says so.
 *
 * The owner's real cases (Zoho, Apr–Oct 2026): Sidhshree / Rediff / Net2Secure = "TDS on software
 * sales" 2% (194J technical services); CA fees = 194J professional 10%; Google India = 10% —
 * royalty for a software licence, not professional fees; commission agents = 194H 2%.
 */
import { describe, it, expect } from "vitest";
import {
  TDS_PICK_SECTIONS, TDS_SECTION_RATES, normalizeTdsSection, rememberTdsOffer, sameTdsThreshold,
  tds26qSection, tdsSectionOption, tdsThresholdSection, defaultTds,
} from "./tds-rates";
import { tdsDecision, tdsRatePct } from "./tds-deductor";
import { planTds, newBillTds, payArgs, type VendorOpenItem } from "@/lib/banking/debit-pay-for";

const CO = "AAACS1234F"; // a company's PAN

describe("R-2338 — three 194J choices wherever a TDS section is picked", () => {
  it("the picker offers 194J(a) technical 2%, 194J(b) professional 10%, 194J royalty 10% — not the plain 194J", () => {
    expect(TDS_PICK_SECTIONS).toEqual(expect.arrayContaining(["194JA", "194JB", "194JR"]));
    expect(TDS_PICK_SECTIONS).not.toContain("194J");
    expect(TDS_SECTION_RATES["194JA"].ratePct).toBe(2);
    expect(TDS_SECTION_RATES["194JB"].ratePct).toBe(10);
    expect(TDS_SECTION_RATES["194JR"].ratePct).toBe(10);
  });

  it("each option reads like the CA's words, with the Income-tax Act 2025 number beside it", () => {
    expect(tdsSectionOption("194JA")).toBe("194J(a) Technical services · 2% — s.393(1) Sl. 6(iii)(a)");
    expect(tdsSectionOption("194JB")).toBe("194J(b) Professional fees · 10% — s.393(1) Sl. 6(iii)(b)");
    expect(tdsSectionOption("194JR")).toBe("194J Royalty – software licence · 10% — s.393(1) Sl. 6(iii)(d)");
    expect(tdsSectionOption("194C")).toContain("Sl. 6(i)");
    expect(tdsSectionOption("194H")).toContain("Sl. 1(ii)");
    expect(tdsSectionOption("194Q")).toContain("Sl. 8(ii)");
  });

  it("an old row that says plain 194J shows as professional 10% (no data rewrite)", () => {
    expect(normalizeTdsSection("194J")).toBe("194JB");
    expect(normalizeTdsSection(" 194j ")).toBe("194JB");
    expect(normalizeTdsSection("194JA")).toBe("194JA");
    expect(normalizeTdsSection("")).toBe("");
    expect(normalizeTdsSection(null)).toBe("");
    expect(tdsSectionOption("194J")).toBe(tdsSectionOption("194JB"));
    // the stored legacy code still works everywhere a rate is read
    expect(defaultTds("194J", 1_00_000)).toBe(10_000);
  });

  it("the three share ONE ₹50,000 yearly threshold for the same vendor", () => {
    expect(tdsThresholdSection("194JA")).toBe("194J");
    expect(tdsThresholdSection("194JR")).toBe("194J");
    expect(tdsThresholdSection("194J")).toBe("194J");
    expect(tdsThresholdSection("194C")).toBe("194C");
    expect(sameTdsThreshold("194JA", "194JB")).toBe(true);
    expect(sameTdsThreshold("194J", "194JR")).toBe(true);
    expect(sameTdsThreshold("194JA", "194C")).toBe(false);
  });

  it("Sidhshree-like: ₹40,000 earlier this year + ₹20,000 now under 194J(a) → crosses ₹50,000, 2%", () => {
    const d = tdsDecision({ section: "194JA", base: 20_000, fyBaseSoFar: 40_000, fyBaseWithoutTds: 0, pan: CO });
    expect(d.applies).toBe(true);
    expect(d.ratePct).toBe(2);
    expect(d.tds).toBe(400);
    expect(d.reason).toContain("194J(a)");
  });

  it("below ₹50,000 for the year → no TDS under any of the three", () => {
    for (const s of ["194JA", "194JB", "194JR"]) {
      expect(tdsDecision({ section: s, base: 10_000, fyBaseSoFar: 20_000, fyBaseWithoutTds: 20_000, pan: CO }).applies).toBe(false);
    }
  });

  it("Google-like royalty and CA professional fees: 10%; no PAN → 20%", () => {
    expect(tdsRatePct("194JR", CO)).toBe(10);
    expect(tdsRatePct("194JB", CO)).toBe(10);
    expect(tdsRatePct("194JA", CO)).toBe(2);
    expect(tdsRatePct("194JA", null)).toBe(20);
  });

  it("26Q shows the sub-section: (a) technical, (b) professional / royalty / old 194J", () => {
    expect(tds26qSection("194JA")).toBe("194J(a)");
    expect(tds26qSection("194JB")).toBe("194J(b)");
    expect(tds26qSection("194JR")).toBe("194J(b) royalty");
    expect(tds26qSection("194J")).toBe("194J(b)");
    expect(tds26qSection("194C")).toBe("194C");
    expect(tds26qSection(null)).toBe("");
  });
});

describe("R-2338 — Reconcile: 194J(a) 2% on a vendor's open bill", () => {
  const bill: VendorOpenItem = {
    source: "expense", doc_id: "EXP-1", bill_no: "S-1", doc_date: "2026-10-05", due_date: null, category: "Software",
    total: 1_18_000, amount_due: 1_18_000, gst: 18_000, tds_base: 1_00_000, tds_amount: 0, tds_section: null,
    can_part: true, in_run: null,
  };

  it("TDS = 2% of the value before GST once the year crosses ₹50,000", () => {
    const lines = planTds([bill], { section: "194JA", pan: CO, fyOthers: { base: 0, baseWithoutTds: 0 }, off: false });
    expect(lines[0]).toMatchObject({ tds: 2_000, section: "194JA" });
  });

  it("a new bill typed on the spot under 194J(b) → 10%", () => {
    expect(newBillTds(80_000, { section: "194JB", pan: CO, fyOthers: { base: 0, baseWithoutTds: 0 }, off: false }).tds).toBe(8_000);
  });

  it("'Remember for this vendor' reaches the server only when ticked", () => {
    const base = {
      transactionId: "t1", vendorId: "v1", newVendor: null, advance: 0, advanceCategory: null, bankCharge: 0, note: null,
      items: [{ item: bill, cash: 1_16_000, tds: 2_000, section: "194JA" }], newBill: null,
    };
    expect(payArgs(base).p_items[0]).not.toHaveProperty("remember_tds_section");
    expect(payArgs({ ...base, rememberSection: true }).p_items[0]).toMatchObject({ tds_section: "194JA", remember_tds_section: true });
  });
});

describe("R-2338 — 'Remember for this vendor' is offered, never ticked for the owner", () => {
  it("offered when the picked section is not the vendor's saved one", () => {
    expect(rememberTdsOffer(null, "194JA")).toBe(true);
    expect(rememberTdsOffer("194JB", "194JA")).toBe(true);
  });
  it("not offered when it already is (old 194J = professional), or nothing is picked", () => {
    expect(rememberTdsOffer("194JA", "194JA")).toBe(false);
    expect(rememberTdsOffer("194J", "194JB")).toBe(false);
    expect(rememberTdsOffer(null, "")).toBe(false);
  });
});

describe("R-2338 — the 26Q working shows the 194J sub-section", () => {
  it("Sidhshree 194J(a), CA 194J(b), Google royalty 194J(b) royalty, an old 194J row as 194J(b)", async () => {
    const { build26QRows } = await import("@/app/(app)/accounting/expenses/tds-26q");
    const exp = (id: string, name: string, sec: string, tds: number) =>
      ({ id, expense_date: "2026-10-05", vendor_name: name, vendor_id: `v-${id}`, amount: 1_00_000, gst_paid: 0, tds_section: sec, tds_amount: tds });
    const read = {
      exps: [exp("1", "Sidhshree", "194JA", 2_000), exp("2", "CA", "194JB", 10_000), exp("3", "Google", "194JR", 10_000), exp("4", "Old CA", "194J", 10_000)],
      vends: [], comms: [], partners: [], goods: [],
    } as unknown as Parameters<typeof build26QRows>[0];
    const { rows } = build26QRows(read);
    expect(Object.fromEntries(rows.map((r) => [r[0], r[2]]))).toEqual({
      Sidhshree: "194J(a)", CA: "194J(b)", Google: "194J(b) royalty", "Old CA": "194J(b)",
    });
  });
});
