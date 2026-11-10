/**
 * R-2192: a credit ₹1 short (or over) of the invoice's due is the same money — a "certain"
 * match (the bank-list chip says "₹1 round-off"; the Reconcile sheet books it). ₹2 apart stays "short of due".
 */
import { describe, it, expect } from "vitest";
import { matchCreditToInvoices, certainInvoiceMatches, type OpenInvoice, type ChipTxn } from "./invoice-credit-match";

const inv = (o: Partial<OpenInvoice> & { id: string }): OpenInvoice => ({
  quoteId: `Q-${o.id}`, customerName: "Mukul Bhardwaj", invoiceDate: "2026-09-20",
  amountDue: 13106, taxableValue: 11107, ...o,
});
const credit = (amount: number, description = "UPI-MUKUL BHARDWAJ-9896033878-2@AXL-BARB") =>
  ({ amount, txnDate: "2026-10-01", description, reference: null });

describe("R-2192 ₹1 tolerance on the invoice match", () => {
  it("₹13,105 in for ₹13,106 due → certain, ₹1 round-off (−1); the one click (bank amount only) is not offered", () => {
    const [m] = matchCreditToInvoices(credit(13105), [inv({ id: "INV-2026-0101" })]);
    expect(m.confidence).toBe("certain");
    expect(m.exactAmount).toBe(false);
    expect(m.roundOff).toBe(-1);
    expect(m.tdsRatePct).toBeNull();
    expect(m.oneClick).toBe(false);
    expect(m.blockedReason).toMatch(/₹1 short — open Reconcile/);
    expect(m.reasons.join(" ")).toMatch(/Within ₹1 of due/);
  });
  it("₹1 more than due → round-off +1 (never a ₹1 advance)", () => {
    const [m] = matchCreditToInvoices(credit(13107), [inv({ id: "INV-2026-0101" })]);
    expect(m.roundOff).toBe(1);
    expect(m.oneClick).toBe(false);
  });
  it("paise: ₹13,105.40 rounds to ₹13,105 — ₹1 short, like the whole-rupee books", () => {
    const [m] = matchCreditToInvoices(credit(13105.4), [inv({ id: "INV-2026-0101" })]);
    expect(m.roundOff).toBe(-1);
  });
  it("exact amount → roundOff 0", () => {
    const [m] = matchCreditToInvoices(credit(13106), [inv({ id: "INV-2026-0101" })]);
    expect(m.exactAmount).toBe(true);
    expect(m.roundOff).toBe(0);
  });
  it("₹2 short → not the same money: blocked as short of due", () => {
    const [m] = matchCreditToInvoices(credit(13104), [inv({ id: "INV-2026-0101" })]);
    expect(m.roundOff).toBe(0);
    expect(m.oneClick).toBe(false);
    expect(m.blockedReason).toMatch(/₹2 short of due/);
  });
  it("two invoices, one exact and one ₹1 off, no name → neither is one-click (amount alone cannot choose)", () => {
    const out = matchCreditToInvoices(credit(13105, "IMPS-519009330625-XXXXXXX10"), [
      inv({ id: "INV-A-000001", customerName: "Alpha", amountDue: 13105 }),
      inv({ id: "INV-B-000002", customerName: "Beta", amountDue: 13106 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.every((m) => !m.oneClick)).toBe(true);
  });
  it("the bank-list chip shows a ₹1-off match", () => {
    const t: ChipTxn = { id: "t1", credit: 13105, txn_date: "2026-10-01", description: "UPI-MUKUL BHARDWAJ-9896033878-2@AXL-BARB", reference: null, matched_to_type: null };
    const chip = certainInvoiceMatches([t], [inv({ id: "INV-2026-0101" })]).get("t1");
    expect(chip?.invoiceId).toBe("INV-2026-0101");
    expect(chip?.roundOff).toBe(-1);
  });
});

