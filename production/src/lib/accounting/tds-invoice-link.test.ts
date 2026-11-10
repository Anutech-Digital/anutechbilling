/* R-1670 (1) — a TDS entry recorded before its invoice existed still names that invoice. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fillTdsInvoiceIds, fillTdsPartInvoiceIds, partInvoiceForPayment, paymentIdsMissingInvoice } from "./tds-invoice-link";

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

describe("R-2558 TDS entry on a sale billed in parts → that part's invoice", () => {
  /* R-2538 card test: half-yearly sale, part 1 invoice INV-80 (₹92,925, quote_id NULL — the link is
     on subscription_billings), receipt ₹92,925 (₹89,775 + ₹3,150 TDS). */
  const parts = [
    { quote_id: "Q-87", invoice_id: "INV-80", term_start: "2026-11-06", period_index: 1, amount: 92925, status: "paid" },
  ];
  const pays = [{ id: "p1", quote_id: "Q-87", amount: 92925, received_at: "2026-11-06", created_at: "2026-11-07T11:17:03Z" }];

  it("part 1's receipt → part 1's invoice (the Invoice column showed '—')", () => {
    expect(partInvoiceForPayment("p1", "Q-87", parts, pays)).toBe("INV-80");
    const out = fillTdsPartInvoiceIds([row({ payment_id: "p1" })], new Map([["p1", "Q-87"]]), parts, pays);
    expect(out[0].invoice_id).toBe("INV-80");
  });

  it("part 2's receipt → part 2's invoice; before part 2 is invoiced → blank (never part 1's)", () => {
    const both = [...pays, { id: "p2", quote_id: "Q-87", amount: 92925, received_at: "2027-05-06", created_at: "2027-05-06T10:00:00Z" }];
    expect(partInvoiceForPayment("p2", "Q-87", parts, both)).toBeNull();
    const two = [...parts, { quote_id: "Q-87", invoice_id: "INV-95", term_start: "2026-11-06", period_index: 2, amount: 92925, status: "pending" }];
    expect(partInvoiceForPayment("p2", "Q-87", two, both)).toBe("INV-95");
    expect(partInvoiceForPayment("p1", "Q-87", two, both)).toBe("INV-80");
  });

  it("parts sharing one invoice count once; a void part invoice is skipped; an unknown payment → blank", () => {
    const shared = [
      { quote_id: "Q-9", invoice_id: "INV-1", term_start: "2026-04-01", period_index: 2, amount: 2000, status: "paid" },
      { quote_id: "Q-9", invoice_id: "INV-1", term_start: "2026-04-01", period_index: 1, amount: 2000, status: "paid" },
      { quote_id: "Q-9", invoice_id: "INV-V", term_start: "2026-04-01", period_index: 3, amount: 1000, status: "void" },
      { quote_id: "Q-9", invoice_id: "INV-2", term_start: "2026-04-01", period_index: 4, amount: 1000, status: "pending" },
    ];
    const p = [
      { id: "a", quote_id: "Q-9", amount: 2000, received_at: "2026-04-01", created_at: null },
      { id: "b", quote_id: "Q-9", amount: 1000, received_at: "2026-07-01", created_at: null },
    ];
    expect(partInvoiceForPayment("a", "Q-9", shared, p)).toBe("INV-1");
    expect(partInvoiceForPayment("b", "Q-9", shared, p)).toBe("INV-2");
    expect(partInvoiceForPayment("zz", "Q-9", shared, p)).toBeNull();
  });

  it("an entry that already names an invoice is kept", () => {
    const out = fillTdsPartInvoiceIds([row({ invoice_id: "INV-X", payment_id: "p1" })], new Map([["p1", "Q-87"]]), parts, pays);
    expect(out[0].invoice_id).toBe("INV-X");
  });

  it("the TDS list query also fills part invoices", () => {
    const q = fs.readFileSync(path.join(process.cwd(), "src/lib/queries/tds-receivable.ts"), "utf8");
    expect(q).toMatch(/fillTdsPartInvoiceIds\(/);
  });
});
