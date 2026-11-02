/**
 * R-2359 — the Zoho match → the Reconcile sheet's existing "A new sale" form: who (app customer by
 * GSTIN, then name), which products (catalogue by sku, then name), seats, rate and period.
 * Owner's example: SUPREME MEDIA & STUDIOS PRIVATE LIMITED, INV/26-27/0613, gptalents.in.
 */
import { describe, it, expect } from "vitest";
import { mapZohoCustomer, matchCatalogItem, normCompanyName, zohoPrefill } from "./payment-prefill";
import type { ZohoPaymentMatch } from "./payment-match";

const customers = [
  { id: "c-supreme", name: "Supreme Media and Studios Pvt. Ltd.", gstin: null },
  { id: "c-gst", name: "Some Other Name", gstin: "07AAACS0000A1Z5" },
  { id: "c-acme", name: "Acme Traders", gstin: "29AAAAA0000A1Z5" },
];

const catalog = [
  { id: "it-bs", name: "Google Workspace Business Starter", sku: "GWS-BS", vendor: "Google", msrp: 2100, wholesale: 1700, prices: null, is_active: true, item_type: null },
  { id: "it-dom", name: ".in Domain", sku: "DOM-IN", vendor: "Domain", msrp: 800, wholesale: 600, prices: null, is_active: true, item_type: null },
] as const;

function match(over: Partial<ZohoPaymentMatch> = {}): ZohoPaymentMatch {
  return {
    by: "utr",
    payment: { zohoId: "pay-0613", number: "7801", date: "2026-07-21", amount: 27081, reference: "IDFB6202M2890149", customerZohoId: "cust-supreme", customerName: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED" },
    customer: { zohoId: "cust-supreme", name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED", gstin: null },
    invoices: [{
      zohoId: "inv-0613", number: "INV/26-27/0613", date: "2026-07-21", amountApplied: 27081, total: 27081,
      lines: [{
        invoiceNumber: "INV/26-27/0613", name: "Google Workspace Business Starter", sku: "gws-bs", qty: 9, rate: 2550, itemTotal: 22950,
        start: "2026-07-21", end: "2027-07-20", months: 12, domain: "gptalents.in",
      }],
    }],
    moreInvoices: [],
    ...over,
  };
}

describe("R-2359 customer mapping", () => {
  it("GSTIN first — even when the name differs", () => {
    expect(mapZohoCustomer({ name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED", gstin: "07aaacs0000a1z5" }, customers))
      .toEqual({ id: "c-gst", name: "Some Other Name", by: "gstin" });
  });
  it("then the normalised name (& = and, Pvt Ltd = Private Limited)", () => {
    expect(normCompanyName("SUPREME MEDIA & STUDIOS PRIVATE LIMITED")).toBe(normCompanyName("Supreme Media and Studios Pvt. Ltd."));
    expect(mapZohoCustomer({ name: "SUPREME MEDIA & STUDIOS PRIVATE LIMITED", gstin: null }, customers))
      .toEqual({ id: "c-supreme", name: "Supreme Media and Studios Pvt. Ltd.", by: "name" });
  });
  it("no match → null (the sheet offers New customer)", () => {
    expect(mapZohoCustomer({ name: "Brand New Pvt Ltd", gstin: "07ZZZZZ0000Z1Z5" }, customers)).toBeNull();
  });
  it("two app customers with the same name → null, never a guess", () => {
    expect(mapZohoCustomer({ name: "Acme Traders", gstin: null }, [...customers, { id: "c-acme2", name: "ACME TRADERS", gstin: null }])).toBeNull();
  });
});

describe("R-2359 product mapping", () => {
  it("sku first (case ignored), then the exact name", () => {
    expect(matchCatalogItem({ name: "whatever", sku: "GWS-bs" }, catalog)?.id).toBe("it-bs");
    expect(matchCatalogItem({ name: ".IN domain", sku: null }, catalog)?.id).toBe("it-dom");
    expect(matchCatalogItem({ name: "Zoho Mail Lite", sku: null }, catalog)).toBeNull();
  });
});

describe("R-2359 pre-fill of the new sale", () => {
  it("Supreme Media: customer, product, 9 seats at ₹2,550/yr, 21 Jul 2026 → renews 21 Jul 2027, Zoho invoice no.", () => {
    const p = zohoPrefill(match(), { customers, catalog, txnDate: "2026-07-21" });
    expect(p.customer).toEqual({ id: "c-supreme", name: "Supreme Media and Studios Pvt. Ltd.", by: "name" });
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({
      itemId: "it-bs", name: "Google Workspace Business Starter", qty: 9, rate: 2550, cycle: "annual_yearly",
      priceTyped: true, typedFor: "annual_yearly", domain: "gptalents.in",
    });
    expect(p.subStart).toBe("2026-07-21");
    expect(p.subRenewal).toBe("2027-07-21");
    expect(p.invoiceNumbers).toEqual(["INV/26-27/0613"]);
    expect(p.unmatched).toEqual([]);
  });

  it("a product not in the catalogue stays as a typed line and is listed", () => {
    const m = match();
    m.invoices[0].lines.push({ invoiceNumber: "INV/26-27/0613", name: "Setup charges", sku: null, qty: 1, rate: 1000, itemTotal: 1000, start: null, end: null, months: 0, domain: null });
    const p = zohoPrefill(m, { customers, catalog, txnDate: "2026-07-21" });
    expect(p.lines[1]).toMatchObject({ itemId: null, name: "Setup charges", qty: 1, rate: 1000, cycle: "one_time" });
    expect(p.unmatched).toEqual(["Setup charges"]);
  });

  it("a monthly Zoho line → Monthly flex; no period → dates left to the sheet", () => {
    const m = match();
    m.invoices[0].lines[0] = { ...m.invoices[0].lines[0], months: 1, start: null, end: null };
    const p = zohoPrefill(m, { customers, catalog, txnDate: "2026-07-21" });
    expect(p.lines[0].cycle).toBe("monthly");
    expect(p.subStart).toBeNull();
    expect(p.subRenewal).toBeNull();
  });
});
