/**
 * R-2540 — the buyer an invoice PRINTS (and the IRN rule reads) is the one frozen on the invoice,
 * never today's customer, once the invoice carries a snapshot. Owner's real case (R-2536): Zoho FY
 * 2025-26 sales filed as B2C on a customer who is registered today, and same-PAN branch invoices
 * (Haryana GSTIN) on a Delhi customer.
 */
import { describe, it, expect } from "vitest";
import { invoiceBuyer, invoiceIrnGstin, type LiveBuyer } from "./invoice-buyer";

const delhiCustomer: LiveBuyer = {
  gstin: "07AAHCB0569M1ZD", address: "12 Nehru Place", city: "New Delhi",
  state: "Delhi", state_code: "07", country: "India",
};

describe("invoiceBuyer (R-2540)", () => {
  it("B2C import: a Zoho sale filed with no GSTIN prints no GSTIN, even though the customer is registered", () => {
    const b = invoiceBuyer({
      party_from_source: true, customer_gstin: null, pos_state_code: "07", seller_state_code: "07",
      billing_address: "12 Nehru Place, New Delhi, Delhi 110019", customer_country: "India",
    }, delhiCustomer);
    expect(b.gstin).toBeNull();
    expect(b.address).toBe("12 Nehru Place, New Delhi, Delhi 110019");
    expect(b.state).toBe("Delhi");
  });

  it("branch: a same-PAN Haryana invoice prints its own GSTIN, Zoho's address and Haryana — never the Delhi address", () => {
    const b = invoiceBuyer({
      party_from_source: true, customer_gstin: "06AAHCB0569M1ZB", pos_state_code: "06", seller_state_code: "07",
      billing_address: "Plot 4, Sector 18, Gurugram, Haryana 122015", customer_country: "India",
    }, delhiCustomer);
    expect(b.gstin).toBe("06AAHCB0569M1ZB");
    expect(b.address).toBe("Plot 4, Sector 18, Gurugram, Haryana 122015");
    expect(b.state).toBe("Haryana");
    expect(b.stateCode).toBe("06");
  });

  it("no address on party_from_source: a branch sale from an old scan prints no address rather than the other branch's", () => {
    const b = invoiceBuyer({
      party_from_source: true, customer_gstin: "06AAHCB0569M1ZB", pos_state_code: "06", seller_state_code: "07",
      billing_address: null, customer_country: null,
    }, delhiCustomer);
    expect(b.address).toBeNull();
    expect(b.state).toBe("Haryana");
  });

  it("snapshot wins: an app invoice prints what it was issued with, not the customer's later edit", () => {
    const b = invoiceBuyer({
      customer_gstin: "29AAGCB1286Q1Z0", pos_state_code: "29", seller_state_code: "07",
      billing_address: "MG Road, Bengaluru, Karnataka 560001", customer_country: "India",
    }, delhiCustomer);
    expect(b.gstin).toBe("29AAGCB1286Q1Z0");
    expect(b.address).toBe("MG Road, Bengaluru, Karnataka 560001");
    expect(b.state).toBe("Karnataka");
  });

  it("unregistered at issue: snapshot GSTIN NULL is not filled from today's registered customer", () => {
    const b = invoiceBuyer({ customer_gstin: null, pos_state_code: "07", seller_state_code: "07", billing_address: "x" }, delhiCustomer);
    expect(b.gstin).toBeNull();
  });

  it("legacy: an invoice with no snapshot at all reads the customer as before", () => {
    const b = invoiceBuyer({ customer_gstin: null, pos_state_code: null, seller_state_code: null, billing_address: null }, delhiCustomer);
    expect(b).toEqual({
      gstin: "07AAHCB0569M1ZD", address: "12 Nehru Place, New Delhi", state: "Delhi", stateCode: "07", country: "India",
    });
  });

  it("legacy with no customer: all empty, never invented", () => {
    expect(invoiceBuyer({}, null)).toEqual({ gstin: null, address: null, state: null, stateCode: null, country: null });
  });

  it("export: place of supply 96 prints no Indian state; country from the snapshot", () => {
    const b = invoiceBuyer({
      customer_gstin: null, pos_state_code: "96", seller_state_code: "07",
      billing_address: "1 Main St, Austin, United States", customer_country: "United States",
    }, { ...delhiCustomer, gstin: null, country: "India" });
    expect(b.state).toBeNull();
    expect(b.stateCode).toBe("96");
    expect(b.country).toBe("United States");
  });

  it("as-filed branch sale with no country of its own is never an export because the customer moved abroad", () => {
    const b = invoiceBuyer({ party_from_source: true, customer_gstin: "06AAHCB0569M1ZB", pos_state_code: "06", seller_state_code: "07" },
      { ...delhiCustomer, country: "United States" });
    expect(b.country).toBeNull();
  });

  it("same 'has a snapshot' test as frozenParty (GSTR-1): no snapshot columns → the live customer", async () => {
    const { frozenParty } = await import("@/lib/gst/place-of-supply");
    const row = { party_from_source: true, customer_gstin: null, pos_state_code: null, seller_state_code: null, billing_address: null };
    expect(invoiceBuyer(row, delhiCustomer).gstin).toBe(frozenParty(row, { gstin: delhiCustomer.gstin!, stateCode: "07", state: "Delhi", country: "India" }).gstin);
  });

  it("snapshot with no place of supply (backfill left it unknown) keeps today's state, as the tax dialog does", () => {
    const b = invoiceBuyer({ customer_gstin: "07AAHCB0569M1ZD", pos_state_code: null, seller_state_code: "07", billing_address: "a" }, delhiCustomer);
    expect(b.state).toBe("Delhi");
    expect(b.stateCode).toBe("07");
  });
});

describe("invoiceIrnGstin (R-2540 — IRN notice + list ageing)", () => {
  const live = "07AAHCB0569M1ZD";
  it("B2C import (party_from_source, NULL GSTIN) → no GSTIN → no IRN warning", () => {
    expect(invoiceIrnGstin({ party_from_source: true, customer_gstin: null, seller_state_code: "07" }, live)).toBeNull();
  });
  it("app invoice with snapshot, NULL GSTIN → unregistered at issue", () => {
    expect(invoiceIrnGstin({ customer_gstin: null, seller_state_code: "07", pos_state_code: "07" }, live)).toBeNull();
  });
  it("invoice GSTIN set → that GSTIN", () => {
    expect(invoiceIrnGstin({ customer_gstin: "06AAHCB0569M1ZB", seller_state_code: "07" }, live)).toBe("06AAHCB0569M1ZB");
  });
  it("legacy row with no snapshot → falls back to the customer's GSTIN as before", () => {
    expect(invoiceIrnGstin({ customer_gstin: null }, live)).toBe(live);
    expect(invoiceIrnGstin({ customer_gstin: null }, null)).toBeNull();
  });
});
