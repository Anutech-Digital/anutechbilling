/**
 * R-2363 — Find in Zoho → "Create customer" must carry WHERE the Zoho customer is.
 * Staging, 2 Nov 2026: Ranz International LLC (Dubai; Zoho: GST treatment "overseas", billing
 * country U.A.E) was created as India / Delhi / unregistered because the match carried only the
 * name + GSTIN. Every id below is made up for this test; Zoho is never called (fake fetch).
 */
import { describe, it, expect } from "vitest";
import { readZohoPaymentMatch, zohoCustomerPlace } from "./payment-match";

describe("R-2363 zohoCustomerPlace", () => {
  it("overseas contact → its billing country, Overseas, its own state; no Indian state", () => {
    expect(zohoCustomerPlace({ gst_treatment: "overseas", billing_address: { country: "U.A.E", state: "Dubai" } }, null))
      .toEqual({ country: "United Arab Emirates", gstTreatment: "overseas", state: "Dubai" });
  });
  it("overseas with no country in Zoho → country left empty (the owner picks), never India", () => {
    expect(zohoCustomerPlace({ gst_treatment: "overseas" }, null)).toEqual({ country: "", gstTreatment: "overseas", state: null });
  });
  it("Indian contact → India, Zoho's treatment, the state from place of contact, else the GSTIN", () => {
    expect(zohoCustomerPlace({ gst_treatment: "business_none", place_of_contact: "MH" }, null))
      .toEqual({ country: "India", gstTreatment: "unregistered_business", state: "Maharashtra" });
    expect(zohoCustomerPlace({ gst_treatment: "business_gst" }, "27AAPFU0939F1ZV"))
      .toEqual({ country: "India", gstTreatment: "registered_regular", state: "Maharashtra" });
  });
  it("Indian with nothing known → no state (never a guessed Delhi)", () => {
    expect(zohoCustomerPlace({}, null)).toEqual({ country: "India", gstTreatment: null, state: null });
  });
});

describe("R-2363 readZohoPaymentMatch — overseas customer", () => {
  it("no GSTIN on the invoice → the contact is read and its country / treatment come back", async () => {
    const calls: string[] = [];
    const json = (b: unknown) => new Response(JSON.stringify({ code: 0, ...(b as object) }), { status: 200 });
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/books/v3", "");
      calls.push(path);
      if (path === "/customerpayments/pay-ranz") {
        return json({ payment: { payment_id: "pay-ranz", payment_number: "9001", date: "2026-10-20", amount: 1024, currency_code: "USD", exchange_rate: 93.6,
          reference_number: "INW123", customer_id: "c-ranz", customer_name: "Ranz International LLC",
          invoices: [{ invoice_id: "inv-r", invoice_number: "INV/26-27/0901", amount_applied: 1024 }] } });
      }
      if (path === "/invoices/inv-r") return json({ invoice: { invoice_id: "inv-r", invoice_number: "INV/26-27/0901", total: 1024, line_items: [] } });
      if (path === "/contacts/c-ranz") return json({ contact: { contact_id: "c-ranz", gst_treatment: "overseas", billing_address: { country: "U.A.E", state: "Dubai" } } });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const m = await readZohoPaymentMatch("pay-ranz", "picked", { orgId: "60000000001", token: "test-only-access", fetch: f });
    expect(m.customer).toEqual({
      zohoId: "c-ranz", name: "Ranz International LLC", gstin: null,
      country: "United Arab Emirates", gstTreatment: "overseas", state: "Dubai",
    });
    expect(calls).toContain("/contacts/c-ranz");
  });
});
