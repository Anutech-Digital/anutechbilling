/**
 * R-038 / S27 — the invoice footer may only name payment routes the seller has.
 *
 * The old line was the literal string "UPI / NEFT / Razorpay accepted", printed on
 * every invoice whatever was configured. Two failures in one sentence: it offered a
 * bank transfer with no account anywhere on the page, and it named a gateway the
 * tenant might not own. Both are AGENTS.md §2 — a gap presented as a plausible value.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { payMethods } from "./pay-methods";

const FULL_BANK = {
  bankName: "HDFC Bank", accountName: "ANUTECH DIGITAL PVT LTD",
  accountNumber: "50200012345678", ifsc: "HDFC0001234", branch: "Nehru Place",
};

describe("payMethods names only what exists", () => {
  it("says NOTHING when the tenant has configured nothing", () => {
    /* Silence is the point. An invoice with no payment-methods line sends the customer
       to the phone number in the header, which is a real answer; an invoice listing
       routes that do not open sends them to a dead end (§7). */
    const m = payMethods({});
    expect(m.line).toBeNull();
    expect(m.bank).toBeNull();
  });

  it("never names Razorpay unless the caller proved it is configured", () => {
    expect(payMethods({ upiVpa: "x@okhdfcbank" }).line).toBe("UPI accepted.");
    expect(payMethods({ upiVpa: "x@okhdfcbank" }).line).not.toMatch(/razorpay/i);
    // The default is false, not true — the whole defect was the other way round.
    expect(payMethods({ bank: FULL_BANK }).hasRazorpay).toBe(false);
    expect(payMethods({ bank: FULL_BANK, razorpayConfigured: true }).line)
      .toBe("NEFT / RTGS / Razorpay accepted.");
  });

  it("offers NEFT only with BOTH an account number and an IFSC", () => {
    /* Either alone is not a payment route, and printing it would look like one: a
       customer cannot transfer to a bank name, and cannot transfer without an IFSC. */
    expect(payMethods({ bank: { ...FULL_BANK, accountNumber: null } }).bank).toBeNull();
    expect(payMethods({ bank: { ...FULL_BANK, ifsc: null } }).bank).toBeNull();
    expect(payMethods({ bank: { ...FULL_BANK, accountNumber: "   " } }).bank).toBeNull();
    expect(payMethods({ bank: { bankName: "HDFC Bank" } }).line).toBeNull();

    const m = payMethods({ bank: FULL_BANK });
    expect(m.bank).toEqual(FULL_BANK);
    expect(m.line).toBe("NEFT / RTGS accepted.");
  });

  it("lists every configured route, in a fixed order", () => {
    const m = payMethods({ upiVpa: "x@okhdfcbank", bank: FULL_BANK, razorpayConfigured: true });
    expect(m.line).toBe("UPI / NEFT / RTGS / Razorpay accepted.");
  });

  it("treats blank strings as unset, not as set", () => {
    // A cleared Settings field arrives as "" from the form, not as null.
    expect(payMethods({ upiVpa: "  " }).hasUpi).toBe(false);
    expect(payMethods({ bank: { ...FULL_BANK, ifsc: "" } }).hasBank).toBe(false);
  });
});

/** Comments stripped: prose explaining the deleted literal must not satisfy a scan for it (L46). */
const pdf = readFileSync("src/lib/pdf/InvoicePDF.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("InvoicePDF no longer hardcodes the sentence", () => {
  it("has no fixed 'UPI / NEFT / Razorpay accepted' left", () => {
    expect(pdf).not.toContain("UPI / NEFT / Razorpay accepted");
  });

  it("renders the derived line and the bank block", () => {
    expect(pdf).toContain("payMethods?.line");
    expect(pdf).toContain("payMethods?.bank &&");
    expect(pdf).toContain("A/c no:");
    expect(pdf).toContain("IFSC:");
  });

  it("keeps the due date even when no payment method is configured", () => {
    /* The due date is a fact about the invoice, not about the seller's plumbing. It
       must not vanish with the methods sentence — that would be this fix causing a
       second, quieter defect. */
    // An invoice still owed keeps it; a settled one says "Paid in full on …" instead (3 Oct 2026,
    // lib/pdf/invoice-display.ts) — nothing is owed, so there is no date to be due by.
    expect(pdf).toContain(") : (invoice.due_date || payMethods?.line) && (");
    expect(pdf).toMatch(/paidInFull \? \(/);
  });

  it("prints the invoice number as the transfer reference", () => {
    // Without it the money lands as an unidentified credit and somebody chases it.
    expect(pdf).toMatch(/Reference: <\/Text>\s*\{invoice\.id\}/);
  });
});

describe("both PDF doors agree", () => {
  it.each([
    ["src/lib/pdf/build-props.ts",                              "server (/api/v1, email, DMS)"],
    ["src/components/features/quotes/tax-invoice-dialog.tsx",   "in-app Download PDF"],
  ])("%s (%s) builds its methods with payMethods()", (file) => {
    /* The same invoice must not download differently depending on which button
       produced it — the drift the logo comment in quotes/[id] warns about. */
    expect(readFileSync(file, "utf8")).toContain("payMethods({");
  });

  it("the in-app door asks the server for Razorpay and fails to NO", () => {
    const src = readFileSync("src/components/features/quotes/tax-invoice-dialog.tsx", "utf8");
    expect(src).toContain("/api/tenant/pay-methods");
    expect(src).toContain("let razorpayConfigured = false;");
  });
});
