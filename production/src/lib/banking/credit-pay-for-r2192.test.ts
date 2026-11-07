/**
 * R-2192 (G-ZOHO audit: sales.md rows 24 + 30): on the Reconcile sheet
 *  - a credit within ₹1 of the item's due is a round-off by default (no question asked) — ₹1 short
 *    AND ₹1 over (never a ₹1 advance);
 *  - a wire short by the bank's / SWIFT charge offers "Bank / SWIFT charge ₹__ — settled in full":
 *    saved through the split RPC with rest "bank_charge" (Bank Charges expense, invoice Paid).
 */
import { describe, it, expect } from "vitest";
import {
  shortChoices, roundOffSplit, tdsToRecord, autoShortChoice, overIsRoundOff, resultLines, preselectItem,
  type AmountCheck, type OpenItem, type PayForResult,
} from "./credit-pay-for";
import { bankChargeAllowed, BANK_CHARGE_MAX, BANK_CHARGE_MAX_PCT } from "./credit-pay-for-multi";

const short = (shortBy: number, tdsRatePct: number | null = null): AmountCheck => ({ kind: "short", shortBy, tdsRatePct });
const over = (overBy: number): AmountCheck => ({ kind: "over", overBy });

describe("R-2192 ₹1 → round-off without asking", () => {
  it("₹1 short → round_off pre-chosen", () => {
    expect(autoShortChoice(short(1))).toBe("round_off");
  });
  it("₹2 short → nothing pre-chosen by this rule", () => {
    expect(autoShortChoice(short(2))).toBeNull();
    expect(autoShortChoice({ kind: "exact" })).toBeNull();
  });
  it("₹1 over → round-off (gain), not a ₹1 advance; ₹2 over stays the advance path", () => {
    expect(overIsRoundOff(over(1))).toBe(true);
    expect(overIsRoundOff(over(2))).toBe(false);
    expect(overIsRoundOff(short(1))).toBe(false);
  });
});

describe("R-2192 bank / SWIFT charge on a wire", () => {
  it("₹500 short of ₹50,000 → Bank / SWIFT charge is offered, settled in full", () => {
    const cs = shortChoices(short(500), 50000);
    const c = cs.find((x) => x.value === "bank_charge");
    expect(c?.label).toMatch(/Bank \/ SWIFT charge ₹500 — settled in full/);
    expect(cs.map((x) => x.value)).toEqual(["tds", "part", "bank_charge"]);
  });
  it("small gaps offer round-off AND bank charge", () => {
    expect(shortChoices(short(30), 50000).map((x) => x.value)).toEqual(["tds", "part", "round_off", "bank_charge"]);
  });
  it("no due given → no bank-charge choice (old callers unchanged)", () => {
    expect(shortChoices(short(500)).map((x) => x.value)).toEqual(["tds", "part"]);
  });
  it("limits: at most 10% of the due and at most ₹5,000", () => {
    expect(BANK_CHARGE_MAX).toBe(5000);
    expect(BANK_CHARGE_MAX_PCT).toBe(10);
    expect(bankChargeAllowed(500, 50000)).toBe(true);
    expect(bankChargeAllowed(1000, 10000)).toBe(true);
    expect(bankChargeAllowed(1001, 10000)).toBe(false);
    expect(bankChargeAllowed(5001, 500000)).toBe(false);
    expect(bankChargeAllowed(0, 50000)).toBe(false);
    expect(shortChoices(short(6000), 50000).map((x) => x.value)).toEqual(["tds", "part"]);
  });
  it("bank charge records no TDS", () => {
    expect(tdsToRecord(short(500), "bank_charge")).toBe(0);
  });
  it("the save: that item for its full due, rest bank_charge", () => {
    expect(roundOffSplit({ mode: "item", item: { quote_id: null, invoice_id: "INV-1", amount_due: 50000 } }, "bank_charge"))
      .toEqual({ items: [{ quote_id: null, invoice_id: "INV-1", amount: 50000 }], saleAmount: null, rest: "bank_charge" });
    expect(roundOffSplit({ mode: "sale", saleTotal: 50000 }, "bank_charge"))
      .toEqual({ items: [], saleAmount: 50000, rest: "bank_charge" });
    // default stays round_off (R-2095 callers)
    expect(roundOffSplit({ mode: "sale", saleTotal: 100 }).rest).toBe("round_off");
  });
  it("the result says the charge was booked as Bank Charges", () => {
    const r: PayForResult = { kind: "split", parts: [], round_off: 0, bank_charge: 500 } as unknown as PayForResult;
    expect(resultLines(r).map((l) => l.text)).toContain("₹500 bank / SWIFT charge booked as Bank Charges — invoice settled in full");
  });
});

const item = (o: Partial<OpenItem>): OpenItem => ({
  kind: "invoice", quote_id: "Q-1", invoice_id: "INV-1", doc_date: "2026-10-10", amount_due: 13106,
  taxable_value: 11107, makes_subscription: false, subscription_id: null, plan: null, seats: null,
  renewal_date: null, lines: [], ...o,
} as OpenItem);

describe("R-2192 the sheet ticks the invoice ₹1 away", () => {
  it("₹13,105 in → INV ₹13,106 is pre-selected (then ₹1 round-off is pre-chosen)", () => {
    expect(preselectItem([item({}), item({ quote_id: "Q-2", invoice_id: "INV-2", amount_due: 5000 })], 13105)?.invoice_id).toBe("INV-1");
    expect(preselectItem([item({})], 13107)?.invoice_id).toBe("INV-1");
  });
  it("an exact one wins over a ₹1-off one; two ₹1-off ones → none", () => {
    expect(preselectItem([item({}), item({ quote_id: "Q-2", invoice_id: "INV-2", amount_due: 13105 })], 13105)?.invoice_id).toBe("INV-2");
    expect(preselectItem([item({}), item({ quote_id: "Q-2", invoice_id: "INV-2", amount_due: 13104 })], 13105)).toBeNull();
  });
  it("₹2 away is not pre-selected by amount", () => {
    expect(preselectItem([item({ taxable_value: 0 })], 13104)).toBeNull();
  });
});

describe("R-2192 review: a TDS-shaped gap is never offered as a bank charge", () => {
  it("₹4,237 short on ₹50,000 looks like 10% TDS → no Bank / SWIFT charge choice", () => {
    expect(shortChoices(short(4237, 10), 50000).map((x) => x.value)).toEqual(["tds", "part"]);
  });
});
