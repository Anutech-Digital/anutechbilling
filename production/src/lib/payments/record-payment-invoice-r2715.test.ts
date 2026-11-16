/**
 * R-2715 (Pratik audit 12 Nov, report 5 — R-2099 leftover): on Subscriptions → Payment received,
 * UNTICKING "Issue GST invoice now" was ignored — the sheet did not raise the invoice, so the
 * page raised it itself. The untick is the user's choice: no GST invoice from the page either.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pageInvoiceStep } from "./record-payment-invoice";

describe("pageInvoiceStep — what Subscriptions does after the payment sheet", () => {
  it("unticked by the user → the page does not raise the invoice", () => {
    expect(pageInvoiceStep({ isFullyPaid: true, invoiceId: null, invoiceAttempted: false, invoiceDeclined: true })).toBe("declined");
  });
  it("ticked → the sheet already raised (or tried) it, the page does not call again (R-2099)", () => {
    expect(pageInvoiceStep({ isFullyPaid: true, invoiceId: "INV-1", invoiceAttempted: true, invoiceDeclined: false })).toBe("handled");
    expect(pageInvoiceStep({ isFullyPaid: true, invoiceId: null, invoiceAttempted: true })).toBe("handled");
  });
  it("box not offered (old sheet / no box) → the page raises it as before", () => {
    expect(pageInvoiceStep({ isFullyPaid: true, invoiceId: null, invoiceAttempted: false, invoiceDeclined: false })).toBe("raise");
    expect(pageInvoiceStep({ isFullyPaid: true })).toBe("raise");
  });
  it("part payment → no invoice yet, whatever the box", () => {
    expect(pageInvoiceStep({ isFullyPaid: false, invoiceDeclined: true })).toBe("part");
    expect(pageInvoiceStep({ isFullyPaid: false })).toBe("part");
  });

  it("wiring: the sheet reports the untick, and Subscriptions checks the step before generate_invoice", () => {
    const root = join(__dirname, "..", "..");
    const dialog = readFileSync(join(root, "components/features/quotes/record-payment-dialog.tsx"), "utf8");
    expect(dialog).toMatch(/onRecorded\?\.\(\{[\s\S]*?invoiceDeclined,/);
    expect(dialog).toMatch(/invoiceDeclined = invoiceOffer\.offer && !issueInvoice && \(issueTouched \|\| invoiceOffer\.defaultOn\)/);
    const page = readFileSync(join(root, "app/(app)/subscriptions/page.tsx"), "utf8");
    const step = page.indexOf("pageInvoiceStep(res)");
    const declined = page.indexOf('"declined"');
    const rpc = page.indexOf('rpc("generate_invoice"');
    expect(step).toBeGreaterThan(0);
    expect(declined).toBeGreaterThan(step);
    expect(step).toBeLessThan(rpc);
  });
});
