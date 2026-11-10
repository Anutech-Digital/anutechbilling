// R-2542: an FY sale imported from Zoho (invoices.zoho_invoice_id, no quote) takes a receipt on the
// invoice itself — the same rule as the SQL (R-2501) — so Record payment and the several-invoices
// sheet list it. Before: "not linked to a quote or a subscription instalment" / "No open invoices".
import { describe, it, expect } from "vitest";
import { multiPayListed, takesQuotelessReceipt } from "./quoteless-receipt";

describe("takesQuotelessReceipt (R-2542)", () => {
  it("a Zoho FY sale (tax invoice, zoho_invoice_id, no quote) → yes", () => {
    expect(takesQuotelessReceipt({ document_kind: "tax_invoice", quote_id: null, zoho_invoice_id: "460000001234" })).toBe(true);
  });
  it("a Zoho opening invoice (R-1739) → yes, as before", () => {
    expect(takesQuotelessReceipt({ document_kind: "opening_invoice", quote_id: null })).toBe(true);
  });
  it("a quote's invoice → no (its quote takes the payment)", () => {
    expect(takesQuotelessReceipt({ document_kind: "tax_invoice", quote_id: "Q-1", zoho_invoice_id: null })).toBe(false);
  });
  it("a hand-made tax invoice with no quote and no Zoho id → no (no payment path)", () => {
    expect(takesQuotelessReceipt({ document_kind: "tax_invoice", quote_id: null, zoho_invoice_id: null })).toBe(false);
    expect(takesQuotelessReceipt({ document_kind: "tax_invoice", quote_id: null })).toBe(false);
  });
  it("nothing → no", () => {
    expect(takesQuotelessReceipt(null)).toBe(false);
    expect(takesQuotelessReceipt(undefined)).toBe(false);
  });
});

describe("multiPayListed — the several-invoices sheet's list (R-2542)", () => {
  const rows = [
    { id: "INV/25-26/1913", document_kind: "tax_invoice", quote_id: null, zoho_invoice_id: "z1913" },
    { id: "ZB-OPN-1", document_kind: "opening_invoice", quote_id: null, zoho_invoice_id: null },
    { id: "INV-Q", document_kind: "tax_invoice", quote_id: "Q-1", zoho_invoice_id: null },
    { id: "INV-Q-OLD", document_kind: "tax_invoice", quote_id: "Q-2", zoho_invoice_id: null },
    { id: "INV-INST-1", document_kind: "tax_invoice", quote_id: null, zoho_invoice_id: null },
    { id: "INV-INST-2", document_kind: "tax_invoice", quote_id: null, zoho_invoice_id: null },
    { id: "INV-HAND", document_kind: "tax_invoice", quote_id: null, zoho_invoice_id: null },
  ];
  const own = new Set(["Q-1|INV-Q"]);
  const inst = new Set(["INV-INST-1"]);

  it("lists the Zoho FY sale, the opening invoice, the quote's own invoice and the oldest instalment", () => {
    const out = multiPayListed(rows, own, inst);
    expect(out.map((r) => r.id)).toEqual(["INV/25-26/1913", "ZB-OPN-1", "INV-Q", "INV-INST-1"]);
  });
  it("marks only the instalment as an instalment (its money goes through the subscription's quote)", () => {
    const out = multiPayListed(rows, own, inst);
    expect(out.find((r) => r.id === "INV-INST-1")?.instalment).toBe(true);
    expect(out.find((r) => r.id === "INV/25-26/1913")?.instalment).toBeUndefined();
  });
  it("leaves out an invoice whose quote now points at another invoice, a later instalment and a hand-made one", () => {
    const ids = multiPayListed(rows, own, inst).map((r) => r.id);
    expect(ids).not.toContain("INV-Q-OLD");
    expect(ids).not.toContain("INV-INST-2");
    expect(ids).not.toContain("INV-HAND");
  });
});
