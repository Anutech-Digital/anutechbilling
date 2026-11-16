/**
 * R-2658 — the narration forms of a foreign inward remittance, as HDFC writes them on a current
 * account ("INW <ref> USD<amount>@<rate>"). Shapes are the bank's own; the figures are examples.
 */
import { describe, it, expect } from "vitest";
import { parseInwardRemittance, remittanceFitsCredit, remittanceInr } from "./inward-remittance";

/** narration → [currency, foreign amount, rate, the ₹ the bank credited] or null (not a remittance). */
const CASES: Array<[string, [string, number, number, number] | null]> = [
  ["INW 110926I049908171 USD56.0@93.99", ["USD", 56, 93.99, 5263]],
  ["INW 010926I049904753 USD29.0@92.81", ["USD", 29, 92.81, 2691]],
  ["INW 020926I049900498 USD4000.99@92.81", ["USD", 4000.99, 92.81, 371332]],
  ["INW 070826I049902623 USD1024.0@93.6", ["USD", 1024, 93.6, 95846]],
  ["INW 290526I049900512 USD19621.46@94.1", ["USD", 19621.46, 94.1, 1846379]],
  ["INW 290526I049903583 USD23539.87@94.1", ["USD", 23539.87, 94.1, 2215102]],
  ["INW 020326I049905059 USD1416.65@89.74", ["USD", 1416.65, 89.74, 127130]],
  ["INW 231025I049920531 USD730.5@86.3", ["USD", 730.5, 86.3, 63042]],
  ["INW 280825I049903078 USD247.16@86.59", ["USD", 247.16, 86.59, 21402]],
  ["INW 130726I049902871 USD1691.0@94.0", ["USD", 1691, 94, 158954]],
  ["INW 060625I049903969 EUR102.21@95.73", ["EUR", 102.21, 95.73, 9785]],
  /* The same money written other ways (other banks / hand-typed statements). */
  ["INW 070826I049902623 USD1,024.50@93.6", ["USD", 1024.5, 93.6, 95893]],
  ["inw 070826i049902623 usd1024.0@93.6", ["USD", 1024, 93.6, 95846]],
  ["INWARD REMITTANCE USD 1024 @ 93.60 REF 0701", ["USD", 1024, 93.6, 95846]],
  ["INW 070826I049902623 GBP500@118.25", ["GBP", 500, 118.25, 59125]],
  /* Not a remittance: no foreign amount + rate. */
  ["NEFT CR-CITI0100000-PAYPAL PAYMENTS PL-OPGSP COLL AC-DEEPAK SHARMA-CITIN26647287397", null],
  ["INW 070826I049902623", null],
  ["INW 070826I049902623 USD1024.0", null],
  ["INW 070826I049902623 USD0@93.6", null],
  ["INW 070826I049902623 USD1024.0@0", null],
  ["INW 070826I049902623 USD-50@93.6", null],
  ["UPI/CUSD1024@okaxis/payment", null],
  ["", null],
];

describe("R-2658 inward remittance narrations", () => {
  it.each(CASES)("%s", (narration, want) => {
    const r = parseInwardRemittance(narration);
    if (!want) {
      expect(r).toBeNull();
      return;
    }
    expect(r).toEqual({ currency: want[0], amount: want[1], rate: want[2] });
    /* amount × rate is the bank's credit (whole rupees on the statement, ±₹1). */
    expect(Math.abs(remittanceInr(r!) - want[3])).toBeLessThanOrEqual(1);
    expect(remittanceFitsCredit(r!, want[3])).toBe(true);
  });

  it("a credit that is not amount × rate does not fit (±₹1)", () => {
    const r = parseInwardRemittance("INW 070826I049902623 USD1024.0@93.6")!;
    expect(remittanceFitsCredit(r, 95846)).toBe(true);
    expect(remittanceFitsCredit(r, 95848)).toBe(false);
    expect(remittanceFitsCredit(r, 90000)).toBe(false);
  });

  it("null / undefined narration is not a remittance", () => {
    expect(parseInwardRemittance(null)).toBeNull();
    expect(parseInwardRemittance(undefined)).toBeNull();
  });
});
