/* R-2098 — one bank credit over several items: the bar, the rest, the RPC arguments, the result. */
import { describe, expect, it } from "vitest";

import {
  ROUND_OFF_LIMIT, cleanAmount, pickDefault, pickProblem, splitArgs, splitBarText, splitRest, splitStateText, splitSummary,
} from "./credit-pay-for-multi";
import { resultLines, type OpenItem, type PayForResult } from "./credit-pay-for";

const item = (o: Partial<OpenItem>): OpenItem => ({
  kind: "invoice", quote_id: "Q-1", invoice_id: "INV-1", doc_date: "2026-10-10", amount_due: 1000, taxable_value: 847,
  makes_subscription: false, subscription_id: null, plan: null, seats: null, renewal_date: null, lines: [], ...o,
});

describe("splitSummary — the staging cases (R-2094)", () => {
  it("I-XL ₹11,718 on 3 invoices, exact", () => {
    const s = splitSummary(11718, [3906, 3906, 3906]);
    expect(s).toMatchObject({ allocated: 11718, left: 0, state: { kind: "exact" } });
    expect(splitRest(s.state, "advance")).toBeNull();
    expect(splitBarText(s)).toEqual({ allocated: "₹11,718", bank: "₹11,718", left: "₹0", tone: "ok" });
  });

  it("Infotrack ₹1,15,710 on 8 invoices → ₹346 left over = advance (too big to write off)", () => {
    const eight = [14000, 14000, 14000, 14000, 14000, 14000, 14000, 17364];
    const s = splitSummary(115710, eight);
    expect(s.state).toEqual({ kind: "left", left: 346, canRoundOff: false });
    expect(splitRest(s.state, "round_off")).toBe("advance");
    expect(splitStateText(s.state, "advance")).toBe("₹346 left over — kept as the customer's advance credit, used on their next bill.");
  });

  it("Subi Exports ₹16,236 against ₹16,284 due → ₹48 short = round-off; every item still settled", () => {
    const s = splitSummary(16236, [16284]);
    expect(s.state).toEqual({ kind: "short", short: 48 });
    expect(splitRest(s.state, "advance")).toBe("round_off");
    expect(splitBarText(s).left).toBe("−₹48");
  });

  it("a little extra (≤ ₹50) may be advance or round-off — the owner's choice", () => {
    const s = splitSummary(5902, [5900]);
    expect(s.state).toEqual({ kind: "left", left: 2, canRoundOff: true });
    expect(splitRest(s.state, "advance")).toBe("advance");
    expect(splitRest(s.state, "round_off")).toBe("round_off");
  });

  it("over-allocation beyond ₹50 is refused (nothing to save)", () => {
    const s = splitSummary(11000, [11800]);
    expect(s.state).toEqual({ kind: "over", over: 800 });
    expect(splitRest(s.state, "round_off")).toBeNull();
    expect(splitBarText(s).tone).toBe("bad");
    expect(splitStateText(s.state, null)).toContain(`only up to ₹${ROUND_OFF_LIMIT} can be written off`);
  });

  it("the limit is exactly ₹50", () => {
    expect(splitSummary(1000, [1050]).state.kind).toBe("short");
    expect(splitSummary(1000, [1051]).state.kind).toBe("over");
  });

  it("nothing ticked is empty, and amounts are whole rupees, never negative", () => {
    expect(splitSummary(500, []).state.kind).toBe("empty");
    expect(cleanAmount(12.6)).toBe(13);
    expect(cleanAmount(-5)).toBe(0);
    expect(cleanAmount(Number.NaN)).toBe(0);
  });
});

describe("items", () => {
  it("ticking puts the whole due on it; more than the due or ₹0 is a problem", () => {
    const i = item({ amount_due: 3906 });
    expect(pickDefault(i)).toEqual({ key: "inv:INV-1", amount: 3906 });
    expect(pickProblem(i, 3906)).toBeNull();
    expect(pickProblem(i, 169)).toBeNull();
    expect(pickProblem(i, 3907)).toBe("More than the ₹3,906 due");
    expect(pickProblem(i, 0)).toBe("Enter an amount");
  });
});

describe("splitArgs — what reaches reconcile_bank_credit_split", () => {
  it("invoice items by invoice, quote items by quote, the sale with its amount, the rest", () => {
    expect(splitArgs({
      transactionId: "t1", customerId: "c1",
      items: [{ quote_id: "Q-9", invoice_id: "INV-9", amount: 100.4 }, { quote_id: "Q-0044", invoice_id: null, amount: 169 }],
      sale: { lines: [{ name: "Setup" }], billingCycle: "yearly", createSubscription: false, subStart: "2026-10-20", subRenewal: null, amount: 12918 },
      rest: "advance",
    })).toEqual({
      p_txn_id: "t1", p_customer_id: "c1",
      p_items: [{ invoice_id: "INV-9", amount: 100 }, { quote_id: "Q-0044", amount: 169 }],
      p_sale: { lines: [{ name: "Setup" }], billing_cycle: "yearly", create_subscription: false, sub_start: null, sub_renewal: null, amount: 12918 },
      p_rest: "advance",
    });
  });
});

describe("resultLines for a split", () => {
  const part = (o: Partial<PayForResult>): PayForResult => ({
    kind: "invoice", quote_id: "Q-1", invoice_id: "INV-1", invoice_issued: null, payment_id: "p1", receipt_voucher_no: null,
    amount: 3906, tds_amount: 0, outstanding: 0, is_fully_paid: true, overpaid_credit: 0, renewal_rolled_forward: false,
    subscription_skipped: false, already_recorded: false, subscriptions: [], ...o,
  });

  it("each part, then the advance and the round-off", () => {
    const lines = resultLines({
      ...part({}), kind: "split", amount: 115710,
      parts: [part({ invoice_id: "INV-A", quote_id: "Q-A" }), part({ invoice_id: "INV-B", quote_id: "Q-B" })],
      advance_credit: 346, customer_id: "c1", customer_name: "Infotrack", round_off: 0,
    }).map((l) => l.text);
    expect(lines).toContain("Invoice INV-A");
    expect(lines).toContain("Invoice INV-B");
    expect(lines).toContain("₹346 kept as advance for Infotrack — it will be offered when you record their next payment");
  });

  it("a round-off says which way", () => {
    const base = { ...part({}), kind: "split" as const, parts: [] };
    expect(resultLines({ ...base, round_off: 48 }).map((l) => l.text)).toEqual(["₹48 less came in — written off as round-off (Bank Charges)"]);
    expect(resultLines({ ...base, round_off: -2 }).map((l) => l.text)).toEqual(["₹2 more came in — written off as round-off (Bank Charges)"]);
  });
});
