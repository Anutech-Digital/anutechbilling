/**
 * R-2255 (Zoho Billing audit A20): a plan change / seat cut credits the customer only up to
 * what they PAID. The unpaid share lowers what they still owe instead.
 *
 * Owner's real case (Zoho test org, 31 Oct 2026): unused part of the old plan ₹1,829.03,
 * the part's invoice ₹2,700 and NOT paid. Zoho credited ₹1,829.03 — money never received.
 */
import { describe, it, expect } from "vitest";
import { splitChangeCredit } from "./change-credit";

describe("splitChangeCredit (R-2255)", () => {
  it("unpaid invoice (Zoho's ₹1,829.03 vs ₹2,700 case): no credit, the whole unused part lowers the open amount", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: 0, invoiced: true });
    expect(s.creditPaise).toBe(0);
    expect(s.lowerOpenPaise).toBe(182903);
    expect(s.stillOwedPaise).toBe(270000 - 182903); // they still owe for the days they used
    expect(s.creditNotePaise).toBe(182903);         // the GST document still reduces the invoice by the unused value
  });

  it("fully paid invoice: the whole unused part is a credit, nothing open to lower", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: 270000, invoiced: true });
    expect(s.creditPaise).toBe(182903);
    expect(s.lowerOpenPaise).toBe(0);
    expect(s.stillOwedPaise).toBe(0);
  });

  it("part paid: the open amount is lowered first; credit = only what was received beyond the used part", () => {
    // billed 2,700, received 1,000, unused 1,829.03 → used 870.97. Open 1,700 absorbs the unused first.
    const s = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: 100000, invoiced: true });
    expect(s.lowerOpenPaise).toBe(170000);
    expect(s.creditPaise).toBe(12903);
    expect(s.stillOwedPaise).toBe(0);
    // never more back than received − used
    expect(s.creditPaise).toBe(100000 - (270000 - 182903));
  });

  it("part paid but less than the used part: no credit, they still owe the rest of the used part", () => {
    const s = splitChangeCredit({ unusedPaise: 100000, billedPaise: 270000, receivedPaise: 50000, invoiced: true });
    expect(s.creditPaise).toBe(0);
    expect(s.lowerOpenPaise).toBe(100000);
    expect(s.stillOwedPaise).toBe(270000 - 50000 - 100000);
  });

  it("the two lines always add up to the unused value — nothing lost, nothing invented", () => {
    for (const received of [0, 1, 50000, 87097, 87098, 100000, 269999, 270000]) {
      const s = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: received, invoiced: true });
      expect(s.lowerOpenPaise + s.creditPaise).toBe(182903);
      expect(s.creditPaise).toBeLessThanOrEqual(received);
      expect(s.creditPaise).toBeGreaterThanOrEqual(0);
      expect(s.stillOwedPaise).toBeGreaterThanOrEqual(0);
    }
  });

  it("no tax invoice yet (only an open payment request): no credit note — the request is lowered", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: 0, invoiced: false });
    expect(s.creditNotePaise).toBe(0);
    expect(s.lowerOpenPaise).toBe(182903);
    expect(s.creditPaise).toBe(0);
  });

  it("money received beyond the bill (overpaid) is not part of this change — capped at what was billed", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: 300000, invoiced: true });
    expect(s.creditPaise).toBe(182903);
    expect(s.lowerOpenPaise).toBe(0);
  });

  it("preview shows both lines, with the amounts, in this order", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: 100000, invoiced: true });
    expect(s.lines.map((l) => l.kind)).toEqual(["lower-open", "credit"]);
    expect(s.lines[0]).toMatchObject({ amountPaise: 170000, text: "Lowers what they still owe: ₹1,700.00" });
    expect(s.lines[1]).toMatchObject({ amountPaise: 12903, text: "Credit to customer (from money received): ₹129.03" });
  });

  it("a fully unpaid change still shows the credit line, at ₹0 — the owner sees why there is no credit", () => {
    const s = splitChangeCredit({ unusedPaise: 182903, billedPaise: 270000, receivedPaise: 0, invoiced: true });
    expect(s.lines[1].text).toBe("Credit to customer (from money received): ₹0.00 — nothing received yet");
  });

  it("refuses bad input instead of guessing money", () => {
    expect(() => splitChangeCredit({ unusedPaise: 300000, billedPaise: 270000, receivedPaise: 0, invoiced: true }))
      .toThrow(/more than was billed/);
    expect(() => splitChangeCredit({ unusedPaise: -1, billedPaise: 270000, receivedPaise: 0, invoiced: true })).toThrow();
    expect(() => splitChangeCredit({ unusedPaise: 1.5, billedPaise: 270000, receivedPaise: 0, invoiced: true })).toThrow();
    expect(() => splitChangeCredit({ unusedPaise: 1, billedPaise: 270000, receivedPaise: -5, invoiced: true })).toThrow();
  });
});
