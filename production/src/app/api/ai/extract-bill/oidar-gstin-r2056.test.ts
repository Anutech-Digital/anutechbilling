/**
 * R-2056 — a foreign online-service bill prints its India GST number as
 * "VAT Registration India GST: <OIDAR GSTIN>". The reader must put it in vendor_gstin,
 * and the sanitiser keeps it, without spaces or dashes. Synthetic GSTIN in the real shape.
 */
import { describe, it, expect } from "vitest";
import { BILL_PROMPT } from "@/lib/ai/read-bill";
import { sanitizeExtractedBill } from "./sanitize";
import { billBuyerMismatch } from "./buyer-check";

describe("BILL_PROMPT — vendor_gstin from the 'VAT Registration India GST' line", () => {
  it("names the line and the OIDAR shape", () => {
    expect(BILL_PROMPT).toMatch(/VAT Registration/);
    expect(BILL_PROMPT).toMatch(/India GST/);
    expect(BILL_PROMPT).toMatch(/vendor_gstin/);
    expect(BILL_PROMPT).toMatch(/OS/);
  });
});

describe("sanitizeExtractedBill — vendor_gstin", () => {
  it("keeps an OIDAR GSTIN, strips spaces/dashes, upper-cases", () => {
    expect(sanitizeExtractedBill({ vendor_name: "Foreign SaaS Inc", vendor_gstin: " 9924 usa-00001 OSX " }).vendor_gstin).toBe("9924USA00001OSX");
    expect(sanitizeExtractedBill({ vendor_name: "Delhi Vendor", vendor_gstin: "07 ABCDE 1234F1Z5" }).vendor_gstin).toBe("07ABCDE1234F1Z5");
  });
});

describe("billBuyerMismatch — a spaced buyer GSTIN equal to ours is ours", () => {
  it("no false 'addressed to another company'", () => {
    const own = { name: "Acme Digital", gstin: "09AAKCA1111A1Z5" };
    expect(billBuyerMismatch({ buyer_name: "Someone", buyer_gstin: "09 AAKCA 1111A1Z5" }, own)).toBeNull();
  });
});
