import { describe, expect, it } from "vitest";
import { effectiveDocCode, formatDocumentNumber } from "@/lib/actions/consequence";
import {
  codeTakenByOther,
  decideInvoiceCodeSave,
  fyEndYear,
  invoiceCodeProblem,
  normalizeInvoiceCode,
  previewInvoiceNumber,
  suggestInvoiceCode,
} from "./invoice-code";

const ME = "3f9a1c22-0000-4000-8000-000000000001";

describe("R-259 invoice code", () => {
  it("new tenant sets 'shrm' → first invoice INV-SHRM-27-0001", () => {
    const d = decideInvoiceCodeSave({ raw: " shrm ", currentCode: effectiveDocCode(null, ME), locked: false, takenByOther: false });
    expect(d).toEqual({ ok: true, code: "SHRM" });
    expect(previewInvoiceNumber("SHRM", "27", 1)).toBe("INV-SHRM-27-0001");
  });

  it("preview matches the shape the allocator mirror prints (R-015, ≤16 chars)", () => {
    const viaConsequence = formatDocumentNumber(
      { prefix: "INV", docCode: "SHRM", fiscalYear: "FY2627", lastNumber: 0, documentCount: 0 }, 1);
    expect(previewInvoiceNumber("SHRM", "27", 1)).toBe(viaConsequence);
    expect(previewInvoiceNumber("SHRM", "27", 1).length).toBeLessThanOrEqual(16);
  });

  it("after the first invoice the code is locked — a change is refused", () => {
    const d = decideInvoiceCodeSave({ raw: "ABCD", currentCode: "SHRM", locked: true, takenByOther: false });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(409);
  });

  it("locked + same code is a no-op, not an error", () => {
    expect(decideInvoiceCodeSave({ raw: "shrm", currentCode: "SHRM", locked: true, takenByOther: false }))
      .toEqual({ ok: true, code: "SHRM" });
  });

  it("2–4 letters only", () => {
    expect(invoiceCodeProblem("S")).not.toBeNull();
    expect(invoiceCodeProblem("SHRMA")).not.toBeNull();
    expect(invoiceCodeProblem("SH1")).not.toBeNull();
    expect(invoiceCodeProblem("")).not.toBeNull();
    expect(invoiceCodeProblem("ab")).toBeNull();
    expect(normalizeInvoiceCode(" s h ")).toBe("SH");
    expect(decideInvoiceCodeSave({ raw: "S-1", currentCode: "3F9A", locked: false, takenByOther: false }).ok).toBe(false);
  });

  it("a code another tenant prints is refused — invoices.id is global", () => {
    const others = [
      { id: "aaaa0000-0000-4000-8000-000000000000", doc_code: "shrm" },          // own code, lower-case
      { id: "face1111-0000-4000-8000-000000000000", doc_code: null },            // hex fallback FACE
    ];
    expect(codeTakenByOther("SHRM", ME, others)).toBe(true);
    expect(codeTakenByOther("FACE", ME, others)).toBe(true);
    expect(codeTakenByOther("ANUT", ME, others)).toBe(false);
    expect(codeTakenByOther("SHRM", "aaaa0000-0000-4000-8000-000000000000", others)).toBe(false); // own row ignored
    const d = decideInvoiceCodeSave({ raw: "SHRM", currentCode: "3F9A", locked: false, takenByOther: true });
    expect(d.ok).toBe(false);
  });

  it("FY end year in IST", () => {
    expect(fyEndYear(new Date("2026-10-07T02:00:00Z"))).toBe("27");
    expect(fyEndYear(new Date("2027-03-31T18:00:00Z"))).toBe("27");   // 23:30 IST, 31 Mar
    expect(fyEndYear(new Date("2027-03-31T18:31:00Z"))).toBe("28");   // 00:01 IST, 1 Apr
  });

  it("suggests initials from the company name", () => {
    expect(suggestInvoiceCode("Sharma Cloud Solutions Pvt Ltd")).toBe("SCS");
    expect(suggestInvoiceCode("Anutech")).toBe("ANUT");
    expect(suggestInvoiceCode("")).toBe("");
  });
});
