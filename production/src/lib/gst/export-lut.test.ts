import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXPORT_LUT_ENDORSEMENT, exportEndorsement, lutMissingWarning, isZeroRatedExport,
  exportLutFix, exportLutRefusal, legacyLutRows, lutFor, lutFyLabel, lutFyStart, readLutArnFor, type TenantLut,
} from "./export-lut";

describe("R-334 export endorsement (CGST Rule 46)", () => {
  it("is the exact statutory wording", () => {
    expect(EXPORT_LUT_ENDORSEMENT).toBe(
      "SUPPLY MEANT FOR EXPORT UNDER LETTER OF UNDERTAKING WITHOUT PAYMENT OF INTEGRATED TAX",
    );
  });

  it("prints endorsement + LUT ARN on a zero-rated export", () => {
    expect(exportEndorsement({ isExport: true, tax: 0, lutNumber: " AD290425000000X " })).toEqual({
      text: EXPORT_LUT_ENDORSEMENT, lutArn: "AD290425000000X",
    });
  });

  it("prints the endorsement but no invented ARN when none is saved", () => {
    expect(exportEndorsement({ isExport: true, tax: 0, lutNumber: "" })).toEqual({
      text: EXPORT_LUT_ENDORSEMENT, lutArn: null,
    });
  });

  it("prints nothing on a domestic invoice or an export with IGST paid", () => {
    expect(exportEndorsement({ isExport: false, tax: 0, lutNumber: "X" })).toBeNull();
    expect(exportEndorsement({ isExport: true, tax: 1800, lutNumber: "X" })).toBeNull();
    expect(isZeroRatedExport({ isExport: false, tax: 1800 })).toBe(false);
  });
});

describe("R-334 LUT-missing warning on issue", () => {
  it("warns for a 0% export with no LUT", () => {
    expect(lutMissingWarning({ taxRate: 0, lutNumber: null })).toMatch(/no LUT number/);
    expect(lutMissingWarning({ taxRate: 0, lutNumber: "   " })).toMatch(/RFD-11/);
  });
  it("is silent when an LUT is saved or the invoice carries GST", () => {
    expect(lutMissingWarning({ taxRate: 0, lutNumber: "AD290425000000X" })).toBeNull();
    expect(lutMissingWarning({ taxRate: 18, lutNumber: null })).toBeNull();
    expect(lutMissingWarning({ taxRate: null, lutNumber: null })).toBeNull();
  });
});

describe("R-334 wiring", () => {
  const pdf = readFileSync("src/lib/pdf/InvoicePDF.tsx", "utf8");
  it("InvoicePDF renders the endorsement from the helper", () => {
    expect(pdf).toMatch(/exportEndorsement\(/);
    expect(pdf).toMatch(/LUT ARN/);
  });
  it("both invoice PDF paths pass the seller's LUT", () => {
    expect(readFileSync("src/lib/pdf/build-props.ts", "utf8")).toMatch(/lutNumber:\s+tenant\.lut_number/);
    expect(readFileSync("src/app/api/v1/documents/invoice/[id]/pdf/route.ts", "utf8")).toMatch(/lut_number/);
    /* R-2444: the in-app PDF prints the ARN of the invoice's own FY, and so does the server route. */
    expect(readFileSync("src/components/features/quotes/tax-invoice-dialog.tsx", "utf8")).toMatch(/lutNumber:\s*invoice\.invoice_date \? lutFor\(lutRows, invoice\.invoice_date\)/);
    expect(readFileSync("src/app/api/v1/documents/invoice/[id]/pdf/route.ts", "utf8")).toMatch(/readLutArnFor\(/);
  });
  it("issuing an invoice warns (not blocks) when the LUT is missing", () => {
    const q = readFileSync("src/lib/queries/invoices.ts", "utf8");
    expect(q).toMatch(/lutMissingWarning\(/);
    expect(q).toMatch(/toast\.warning/);
  });
});

/* R-2444: one LUT per financial year — the TS twin of lut_for / export_lut_refusal (migration
   20261104014038_r2444_lut_per_fy). Owner's case: the Zoho backlog has FY 2025-26 receipts while
   Settings held only the FY 2026-27 LUT. */
describe("R-2444 LUT per financial year", () => {
  const fy2526: TenantLut = { fyStart: "2025-04-01", arn: "AD070425000999X", validFrom: "2025-04-01", validUpto: "2026-03-31" };
  const fy2627: TenantLut = { fyStart: "2026-04-01", arn: "AD070426000123X", validFrom: "2026-04-01", validUpto: "2027-03-31" };

  it("FY of a date: 1 April to 31 March", () => {
    expect(lutFyStart("2026-03-31")).toBe("2025-04-01");
    expect(lutFyStart("2026-04-01")).toBe("2026-04-01");
    expect(lutFyLabel("2026-03-20")).toBe("2025-26");
    expect(lutFyLabel("2099-12-31")).toBe("2099-00");
  });

  it("an FY 2025-26 receipt uses the FY 2025-26 LUT, an FY 2026-27 one the FY 2026-27 LUT", () => {
    expect(lutFor([fy2627, fy2526], "2026-03-20")?.arn).toBe("AD070425000999X");
    expect(lutFor([fy2627, fy2526], "2026-08-07")?.arn).toBe("AD070426000123X");
    expect(exportLutRefusal([fy2627, fy2526], "2026-03-20")).toBeNull();
  });

  it("no LUT for that FY → refused with the FY and both next steps", () => {
    const why = exportLutRefusal([fy2627], "2026-03-20");
    expect(why).toMatch(/^No LUT for FY 2025-26 on file\./);
    expect(why).toContain("Settings → Company → LUT");
    expect(why).toContain("bill this sale with IGST");
    expect(exportLutRefusal([], "2026-08-07")).toMatch(/^No LUT for FY 2026-27 on file/);
    expect(exportLutRefusal(null, "2026-08-07")).toMatch(/^No LUT for FY 2026-27 on file/);
  });

  it("an LUT filed mid-year does not cover sales before its valid-from date", () => {
    const late: TenantLut = { ...fy2627, validFrom: "2026-06-15" };
    expect(lutFor([late], "2026-06-01")).toBeNull();
    expect(exportLutRefusal([late], "2026-06-01")).toBe(
      "No LUT for FY 2026-27 covers 01 Jun 2026: the LUT saved for that year runs 15 Jun 2026 – 31 Mar 2027. "
      + "An export at 0% GST needs a Letter of Undertaking on its date: correct the LUT dates in Settings → Company → LUT, or bill this sale with IGST.");
    expect(lutFor([late], "2026-06-15")?.arn).toBe("AD070426000123X");
  });

  it("a blank ARN never covers a sale", () => {
    expect(lutFor([{ ...fy2627, arn: "  " }], "2026-08-07")).toBeNull();
  });

  it("the old single LUT reads as the LUT of its valid-up-to FY", () => {
    expect(legacyLutRows("AD070426000123X", "2027-03-31")).toEqual([fy2627]);
    expect(legacyLutRows(" ", "2027-03-31")).toEqual([]);
    expect(legacyLutRows("AD070426000123X", null)).toEqual([]);
  });

  it("the SQL refusal says the same words", () => {
    const sql = readFileSync("supabase/migrations/20261104014038_r2444_lut_per_fy.sql", "utf8");
    expect(sql).toContain("No LUT for FY %s on file. An export sale at 0%% GST needs your Letter of Undertaking for that year: add its ARN in Settings → Company → LUT, then try again — or bill this sale with IGST.");
    expect(sql).toContain("An export at 0%% GST needs a Letter of Undertaking on its date: correct the LUT dates in Settings → Company → LUT, or bill this sale with IGST.");
  });

  it("the PDF reads the ARN of the invoice's FY; no table yet → the old LUT; other errors → none", async () => {
    const reader = (data: unknown[] | null, error: { message: string } | null) => ({
      from: () => ({ select: () => ({ eq: async () => ({ data, error }) }) }),
    });
    const rows = [
      { fy_start: "2026-04-01", arn: "AD070426000123X", valid_from: "2026-04-01", valid_upto: "2027-03-31" },
      { fy_start: "2025-04-01", arn: "AD070425000999X", valid_from: "2025-04-01", valid_upto: "2026-03-31" },
    ];
    expect(await readLutArnFor(reader(rows, null), "t1", "2026-03-20", "AD070426000123X")).toBe("AD070425000999X");
    expect(await readLutArnFor(reader([rows[0]], null), "t1", "2026-03-20", "AD070426000123X")).toBeNull();
    expect(await readLutArnFor(reader(null, { message: 'relation "public.tenant_luts" does not exist' }), "t1", "2026-03-20", "OLD1")).toBe("OLD1");
    expect(await readLutArnFor(reader(null, { message: "timeout" }), "t1", "2026-03-20", "OLD1")).toBeNull();
    expect(await readLutArnFor(reader(rows, null), "t1", null, "OLD1")).toBeNull();
  });
});

describe("R-2444 the refusal opens the LUT card", () => {
  it("any LUT refusal → 'Add LUT' to Settings → Company → LUT; other errors → none", () => {
    expect(exportLutFix(new Error(exportLutRefusal([], "2026-08-07")!))).toEqual({ label: "Add LUT", href: "/settings?tab=company#lut" });
    expect(exportLutFix({ message: "No LUT for FY 2026-27 covers 01 Jun 2026: …" })?.href).toBe("/settings?tab=company#lut");
    expect(exportLutFix(new Error("Invoice not found"))).toBeNull();
  });
  it("issuing an invoice shows that button", () => {
    expect(readFileSync("src/lib/queries/invoices.ts", "utf8")).toMatch(/invoiceIssueFix\(err\) \?\? exportLutFix\(err\)/);
  });
  it("Settings → Company has the LUT card with the #lut anchor", () => {
    expect(readFileSync("src/components/features/settings/lut-list.tsx", "utf8")).toMatch(/id="lut"/);
    expect(readFileSync("src/app/(app)/settings/page.tsx", "utf8")).toMatch(/<LutListCard /);
  });
});
