/**
 * R-2255 (Zoho Billing audit A20): a plan change / seat cut credits the customer only up to
 * what they PAID. The unpaid share lowers what they still owe instead.
 *
 * Owner's real case (Zoho test org, 31 Oct 2026): unused part of the old plan ₹1,829.03,
 * the part's invoice ₹2,700 and NOT paid. Zoho credited ₹1,829.03 — money never received.
 */
import { describe, it, expect } from "vitest";
import { openDuePaiseOf, splitChangeCredit } from "./change-credit";
import { prorate } from "./proration";

const BILL = 270000;

describe("splitChangeCredit (R-2255)", () => {
  it("unpaid invoice (Zoho's ₹1,829.03 vs ₹2,700 case): no credit, the whole unused part lowers the open amount", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, openDuePaise: BILL, receivedPaise: 0, invoiced: true });
    expect(s.creditPaise).toBe(0);
    expect(s.lowerOpenPaise).toBe(182903);
    expect(s.stillOwedPaise).toBe(BILL - 182903); // they still owe for the days they used
    expect(s.document).toBe("credit-note");       // the GST document still reduces the invoice
    expect(s.documentPaise).toBe(182903);
  });

  it("fully paid invoice: the whole unused part is a credit, nothing open to lower", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, openDuePaise: 0, receivedPaise: BILL, invoiced: true });
    expect(s.creditPaise).toBe(182903);
    expect(s.lowerOpenPaise).toBe(0);
    expect(s.stillOwedPaise).toBe(0);
    expect(s.documentPaise).toBe(182903);
  });

  it("part paid: the open amount is lowered first; credit = only what was received beyond the used part", () => {
    // billed 2,700, received 1,000 (open 1,700), unused 1,829.03 → used 870.97.
    const s = splitChangeCredit({ unusedPaise: 182903, openDuePaise: 170000, receivedPaise: 100000, invoiced: true });
    expect(s.lowerOpenPaise).toBe(170000);
    expect(s.creditPaise).toBe(12903);
    expect(s.creditPaise).toBe(100000 - (BILL - 182903)); // = received − used
    expect(s.stillOwedPaise).toBe(0);
  });

  it("part paid but less than the used part: no credit, and the preview says why", () => {
    const s = splitChangeCredit({ unusedPaise: 100000, openDuePaise: 220000, receivedPaise: 50000, invoiced: true });
    expect(s.creditPaise).toBe(0);
    expect(s.lowerOpenPaise).toBe(100000);
    expect(s.stillOwedPaise).toBe(120000);
    expect(s.lines[1].text).toBe("Credit to customer (from money received): ₹0.00 — what was received covers only the part used");
  });

  it("the lines always add up to the unused value, and credit never exceeds what was received", () => {
    for (const received of [0, 1, 50000, 87097, 87098, 100000, 269999, 270000]) {
      const s = splitChangeCredit({ unusedPaise: 182903, openDuePaise: BILL - received, receivedPaise: received, invoiced: true });
      expect(s.lowerOpenPaise + s.creditPaise + s.notGivenPaise).toBe(182903);
      expect(s.notGivenPaise).toBe(0);
      expect(s.creditPaise).toBeLessThanOrEqual(received);
      expect(s.stillOwedPaise).toBeGreaterThanOrEqual(0);
    }
  });

  it("a second change on the same invoice uses what is open NOW (after the first credit note)", () => {
    // ₹2,700 unpaid; first change gave a ₹1,000 note → open ₹1,700. Second change: unused ₹1,500.
    const s = splitChangeCredit({ unusedPaise: 150000, openDuePaise: 170000, receivedPaise: 0, invoiced: true });
    expect(s.lowerOpenPaise).toBe(150000);
    expect(s.stillOwedPaise).toBe(20000);
    // a third change of ₹500 now: only ₹200 open and nothing received → ₹300 is NOT given back, and shown
    const t = splitChangeCredit({ unusedPaise: 50000, openDuePaise: 20000, receivedPaise: 0, invoiced: true });
    expect(t.lowerOpenPaise).toBe(20000);
    expect(t.creditPaise).toBe(0);
    expect(t.notGivenPaise).toBe(30000);
    expect(t.lines.map((l) => l.kind)).toEqual(["lower-open", "credit", "not-given"]);
    expect(t.documentPaise).toBe(20000); // the credit note never exceeds what it can land on
  });

  it("credit already given back from the same money counts against what can still be credited", () => {
    const s = splitChangeCredit({ unusedPaise: 100000, openDuePaise: 0, receivedPaise: BILL, alreadyCreditedPaise: 200000, invoiced: true });
    expect(s.creditPaise).toBe(70000);
    expect(s.notGivenPaise).toBe(30000);
  });

  it("a paisa of rounding over the bill does not crash the screen — it is shown as not given back", () => {
    const s = splitChangeCredit({ unusedPaise: BILL + 1, openDuePaise: BILL, receivedPaise: 0, invoiced: true });
    expect(s.lowerOpenPaise).toBe(BILL);
    expect(s.notGivenPaise).toBe(1);
  });

  it("TDS invoice settled in full (net payable paid): nothing open, full credit", () => {
    const due = openDuePaiseOf({ id: "INV-1", status: "paid", amount: 2700, net_payable: 2430, paid_amount: 2430 });
    expect(due).toBe(0);
    const s = splitChangeCredit({ unusedPaise: 182903, openDuePaise: due, receivedPaise: BILL, invoiced: true });
    expect(s.creditPaise).toBe(182903);
  });

  it("openDuePaiseOf converts the rupee row to paise via the cancel dialog's own rule", () => {
    expect(openDuePaiseOf({ id: "INV-2", status: "pending", amount: 2700, net_payable: null, paid_amount: 1000 })).toBe(170000);
    expect(openDuePaiseOf({ id: "INV-3", status: "pending", amount: 2700, net_payable: null, paid_amount: 0, written_off_at: "2026-11-01" })).toBe(0);
  });

  it("takes prorate()'s negative total for a seat cut as it is", () => {
    const p = prorate({ annualPerSeatPaise: 228800, seats: -1, remainingDays: 292, termDays: 365, taxRatePct: 18 });
    expect(p.totalPaise).toBeLessThan(0);
    const s = splitChangeCredit({ unusedPaise: p.totalPaise, openDuePaise: BILL, receivedPaise: 0, invoiced: true });
    expect(s.lowerOpenPaise).toBe(-p.totalPaise);
  });

  it("no tax invoice yet, request unpaid: no document — the request is lowered", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, openDuePaise: BILL, receivedPaise: 0, invoiced: false });
    expect(s.document).toBe("none");
    expect(s.lowerOpenPaise).toBe(182903);
  });

  it("no tax invoice yet but an advance was received: the credit goes back by refund voucher", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, openDuePaise: 0, receivedPaise: BILL, invoiced: false });
    expect(s.document).toBe("refund-voucher");
    expect(s.documentPaise).toBe(182903);
  });

  it("preview shows both lines, with the amounts, in this order", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, openDuePaise: 170000, receivedPaise: 100000, invoiced: true });
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]).toMatchObject({ kind: "lower-open", amountPaise: 170000, text: "Lowers what they still owe: ₹1,700.00" });
    expect(s.lines[1]).toMatchObject({ kind: "credit", amountPaise: 12903, text: "Credit to customer (from money received): ₹129.03" });
  });

  it("a fully unpaid change still shows the credit line, at ₹0 — the owner sees why there is no credit", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, openDuePaise: BILL, receivedPaise: 0, invoiced: true });
    expect(s.lines[1].text).toBe("Credit to customer (from money received): ₹0.00 — nothing received yet");
  });

  it("refuses bad input instead of guessing money", () => {
    expect(() => splitChangeCredit({ unusedPaise: 1.5, openDuePaise: BILL, receivedPaise: 0, invoiced: true })).toThrow();
    expect(() => splitChangeCredit({ unusedPaise: 1, openDuePaise: -1, receivedPaise: 0, invoiced: true })).toThrow();
    expect(() => splitChangeCredit({ unusedPaise: 1, openDuePaise: BILL, receivedPaise: -5, invoiced: true })).toThrow();
    expect(() => splitChangeCredit({ unusedPaise: 1, openDuePaise: 2700.5, receivedPaise: 0, invoiced: true })).toThrow();
  });
});
