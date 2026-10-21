/**
 * R-1706 — accepting a PROSPECT quote (no lead, no customer) creates the customer.
 *
 * The database half (accept_quote → customer_from_prospect_quote) is proven by
 * supabase/tests/r1706_accept_prospect_creates_customer.test.sql. This file pins the words and
 * the Invoice now pre-flight the owner meets on the quote page.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptHint, customerBeforeInvoice } from "./quote-page-actions";
import { customerCreditEligibility } from "@/lib/credit/activate-on-credit";

const SRC = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/* The owner's real record: New quote → New prospect without email, place of supply Delhi. */
const prospectQuote = { customer_id: null, lead_id: null, is_renewal: false, is_add_seats: false, is_extension: false };

describe("R-1706: the Mark accepted sentence on a prospect quote", () => {
  it("does not talk about a lead that does not exist", () => {
    const hint = acceptHint(prospectQuote);
    expect(hint).not.toMatch(/lead/i);
    expect(hint).toBe("Customer accepted? Mark accepted to create their customer record.");
  });
  it("a lead quote still converts the lead", () => {
    expect(acceptHint({ ...prospectQuote, lead_id: "L1" })).toContain("convert the lead into a customer");
  });
});

describe("R-1706: Invoice now checks for a customer before generate_invoice", () => {
  it("a quote with a customer is issued as before", () => {
    expect(customerBeforeInvoice({ customer_id: "C1", status: "accepted" })).toEqual({ kind: "ready" });
  });
  it("an accepted quote with no customer (accepted before R-1706) is accepted again, which creates it", () => {
    expect(customerBeforeInvoice({ customer_id: null, status: "accepted" })).toEqual({ kind: "accept_first" });
  });
  it("a quote not yet accepted says the real next step — never 'Customers → <name> → Edit'", () => {
    const step = customerBeforeInvoice({ customer_id: null, status: "sent" });
    expect(step.kind).toBe("refuse");
    if (step.kind === "refuse") {
      expect(step.message).toContain("Mark it accepted first");
      expect(step.message).not.toMatch(/Customers →/);
    }
  });
  it("useGenerateInvoice runs the check (and the mark-accepted route) before the RPC", () => {
    const src = read("lib/queries/invoices.ts");
    const check = src.indexOf("customerBeforeInvoice(");
    const accept = src.indexOf("/mark-accepted`");
    const rpc = src.indexOf('rpc("generate_invoice"');
    expect(check).toBeGreaterThan(0);
    expect(accept).toBeGreaterThan(check);
    expect(rpc).toBeGreaterThan(accept);
  });
});

describe("R-1706: Activate now, pay later with no customer says a true next step", () => {
  it("no longer tells the owner to accept an already-accepted quote", () => {
    const r = customerCreditEligibility(null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toMatch(/Accept it/);
      expect(r.reason).toMatch(/Invoice now|Record payment/);
    }
  });
});
