/* R-1670 (1) — a TDS entry recorded before its invoice existed still names that invoice. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fillTdsInvoiceIds, paymentIdsMissingInvoice } from "./tds-invoice-link";

const row = (over: Partial<{ id: string; invoice_id: string | null; payment_id: string | null }>) =>
  ({ id: "t", invoice_id: null, payment_id: null, ...over });

describe("TDS entry → invoice (R-1670 item 1)", () => {
  it("T-2: paid on the quote, invoice generated after → the invoice raised from that quote", () => {
    const out = fillTdsInvoiceIds(
      [row({ id: "t2", payment_id: "p1" })],
      [{ id: "p1", quote_id: "Q-2" }],
      [{ id: "ANU/26-27/014", quote_id: "Q-2", status: "paid" }],
    );
    expect(out[0].invoice_id).toBe("ANU/26-27/014");
  });

  it("keeps an invoice the entry already names", () => {
    const out = fillTdsInvoiceIds(
      [row({ invoice_id: "INV-1", payment_id: "p1" })],
      [{ id: "p1", quote_id: "Q-2" }],
      [{ id: "INV-9", quote_id: "Q-2", status: "paid" }],
    );
    expect(out[0].invoice_id).toBe("INV-1");
  });

  it("ignores a void invoice, and leaves a quote with two live invoices blank (no guessing)", () => {
    const voided = fillTdsInvoiceIds(
      [row({ payment_id: "p1" })],
      [{ id: "p1", quote_id: "Q-2" }],
      [{ id: "INV-OLD", quote_id: "Q-2", status: "void" }, { id: "INV-NEW", quote_id: "Q-2", status: "pending" }],
    );
    expect(voided[0].invoice_id).toBe("INV-NEW");
    const two = fillTdsInvoiceIds(
      [row({ payment_id: "p1" })],
      [{ id: "p1", quote_id: "Q-2" }],
      [{ id: "INV-A", quote_id: "Q-2", status: "paid" }, { id: "INV-B", quote_id: "Q-2", status: "pending" }],
    );
    expect(two[0].invoice_id).toBeNull();
  });

  it("no invoice yet → still blank", () => {
    expect(fillTdsInvoiceIds([row({ payment_id: "p1" })], [{ id: "p1", quote_id: "Q-2" }], [])[0].invoice_id).toBeNull();
  });

  it("asks only for the payments that need it", () => {
    expect(paymentIdsMissingInvoice([row({ payment_id: "p1" }), row({ payment_id: "p1" }), row({ invoice_id: "I", payment_id: "p2" }), row({})])).toEqual(["p1"]);
  });

  it("the TDS list query fills the link, and the page links the invoice", () => {
    const q = fs.readFileSync(path.join(process.cwd(), "src/lib/queries/tds-receivable.ts"), "utf8");
    expect(q).toMatch(/fillTdsInvoiceIds\(/);
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/accounting/tds-receivable/page.tsx"), "utf8");
    expect(page).toMatch(/invoiceHref\(r\.invoice_id\)/);
  });
});
