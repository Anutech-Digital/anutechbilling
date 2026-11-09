/**
 * R-2173 — who sees "Correct date" on an invoice, and the date picker's range (the invoice's own FY,
 * never after today). The server (correct_invoice_date, SQL test r2173) decides the rest.
 */
import { describe, expect, it } from "vitest";
import { canCorrectInvoiceDate, correctDateBounds, correctDateHint, type CorrectableInvoice } from "./correct-invoice-date-dialog";

const inv = (over: Partial<CorrectableInvoice> = {}): CorrectableInvoice => ({
  id: "INV-T-2026-27-0001", invoice_date: "2026-10-30", status: "pending", document_kind: "tax_invoice",
  gst_irn: null, zoho_invoice_id: null, currency: "INR", fx_rate: null, ...over,
});

describe("R-2173 canCorrectInvoiceDate", () => {
  it("owner and accountant see it on an issued INR invoice (pending, paid, overdue)", () => {
    for (const role of ["owner", "accountant"]) {
      for (const status of ["pending", "paid", "overdue"]) expect(canCorrectInvoiceDate(inv({ status }), role)).toBe(true);
    }
  });
  it("sales, manager, billing, support and no role do not", () => {
    for (const role of ["sales", "manager", "billing", "support", null, undefined]) {
      expect(canCorrectInvoiceDate(inv(), role)).toBe(false);
    }
  });
  it("hidden for draft, void, opening balance, IRN, Zoho-imported and foreign-currency invoices", () => {
    expect(canCorrectInvoiceDate(inv({ status: "draft" }), "owner")).toBe(false);
    expect(canCorrectInvoiceDate(inv({ status: "void" }), "owner")).toBe(false);
    expect(canCorrectInvoiceDate(inv({ document_kind: "opening_invoice" }), "owner")).toBe(false);
    expect(canCorrectInvoiceDate(inv({ gst_irn: "IRN123" }), "owner")).toBe(false);
    expect(canCorrectInvoiceDate(inv({ zoho_invoice_id: "z1" }), "owner")).toBe(false);
    expect(canCorrectInvoiceDate(inv({ currency: "USD", fx_rate: 83.5 }), "owner")).toBe(false);
    expect(canCorrectInvoiceDate(inv({ invoice_date: null }), "owner")).toBe(false);
  });
  it("a blank IRN or a bill of supply still shows it", () => {
    expect(canCorrectInvoiceDate(inv({ gst_irn: "  " }), "owner")).toBe(true);
    expect(canCorrectInvoiceDate(inv({ document_kind: "bill_of_supply" }), "owner")).toBe(true);
  });
});

describe("R-2173 correctDateBounds", () => {
  it("Oct 2026 invoice, today 9 Nov 2026 → 1 Apr 2026 .. today", () => {
    expect(correctDateBounds("2026-10-30", "2026-11-09")).toEqual({ min: "2026-04-01", max: "2026-11-09" });
  });
  it("Feb 2026 invoice (FY 2025-26), today later → 1 Apr 2025 .. 31 Mar 2026", () => {
    expect(correctDateBounds("2026-02-10", "2026-11-09")).toEqual({ min: "2025-04-01", max: "2026-03-31" });
  });
  it("1 Apr belongs to the new FY", () => {
    expect(correctDateBounds("2026-04-01", "2026-04-20")).toEqual({ min: "2026-04-01", max: "2026-04-20" });
  });
});

describe("R-2173 review: notes / network / hint", () => {
  it("hidden when the invoice has a credit/debit note or a live network copy, or came from the Zoho FY import", () => {
    expect(canCorrectInvoiceDate(inv(), "owner", { hasNotes: true })).toBe(false);
    expect(canCorrectInvoiceDate(inv(), "owner", { onNetwork: true })).toBe(false);
    expect(canCorrectInvoiceDate(inv({ sale_import_batch_id: "b1" }), "owner")).toBe(false);
    expect(canCorrectInvoiceDate(inv(), "owner", { hasNotes: false, onNetwork: false })).toBe(true);
  });
  it("Save says what is missing", () => {
    const b = { min: "2026-04-01", max: "2026-11-09" };
    expect(correctDateHint("2026-10-30", "2026-10-30", "Money came earlier", b)).toMatch(/different/);
    expect(correctDateHint("2026-10-30", "2026-03-30", "Money came earlier", b)).toMatch(/between 1 Apr 2026 and 9 Nov 2026/);
    expect(correctDateHint("2026-10-30", "2026-09-15", "late", b)).toMatch(/at least 5 characters/);
    expect(correctDateHint("2026-10-30", "", "Money came earlier", b)).toMatch(/Pick the correct date/);
    expect(correctDateHint("2026-10-30", "2026-09-15", "Money came earlier", b)).toBeNull();
  });
});
