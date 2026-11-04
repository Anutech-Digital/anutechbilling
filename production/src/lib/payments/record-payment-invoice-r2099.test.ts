/**
 * R-2099 (30 Oct 2026, staging): saving a Razorpay payment from Subscriptions showed
 * "GST invoice could not be raised — INV-0088 already exists" next to "Paid in full · GST invoice
 * INV-0088 issued". The sheet issued it, then the page called generate_invoice again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sheetHandledInvoice } from "./record-payment-invoice";

describe("sheetHandledInvoice", () => {
  it("issued or tried by the sheet → the caller does not call generate_invoice again", () => {
    expect(sheetHandledInvoice({ invoiceId: "INV-0088", invoiceAttempted: true })).toBe(true);
    expect(sheetHandledInvoice({ invoiceId: null, invoiceAttempted: true })).toBe(true);
    expect(sheetHandledInvoice({ invoiceId: null, invoiceAttempted: false })).toBe(false);
    expect(sheetHandledInvoice({})).toBe(false);
  });

  it("the sheet hands its invoice result to onRecorded, and Subscriptions checks it before generate_invoice", () => {
    const root = join(__dirname, "..", "..");
    const dialog = readFileSync(join(root, "components/features/quotes/record-payment-dialog.tsx"), "utf8");
    expect(dialog).toMatch(/onRecorded\?\.\(\{[\s\S]*?invoiceId: issuedInvoiceId,[\s\S]*?invoiceAttempted,/);
    const page = readFileSync(join(root, "app/(app)/subscriptions/page.tsx"), "utf8");
    const guard = page.indexOf("sheetHandledInvoice(res)");
    const rpc = page.indexOf('rpc("generate_invoice"');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(rpc);
  });
});
