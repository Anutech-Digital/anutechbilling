/**
 * R-2099 — a Razorpay settlement bank credit broken back into its payments, fee + GST, refunds.
 * The owner's case: "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-…".
 */
import { describe, it, expect } from "vitest";
import {
  buildSettlementPlan, isRazorpaySettlementLine, pickSettlement,
  type AppPayment, type BankLine, type RzpReconItem, type RzpSettlement,
} from "./settlement-match";

const line: BankLine = {
  id: "L1", credit: 9251, txn_date: "2026-10-20", reference: "AXISCN0012345",
  description: "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-ACME TRADERS-A",
};
const setl: RzpSettlement = { id: "setl_A", amount: 925100, fees: 18900, tax: 2900, utr: "AXISCN0012345", created_at: 1792474200 };

const pay = (id: string, amount: number, fee: number, tax: number, extra: Partial<RzpReconItem> = {}): RzpReconItem => ({
  entity_id: id, type: "payment", amount, credit: amount - fee, debit: 0, fee, tax, settlement_id: "setl_A", order_id: null, created_at: 1792300000, ...extra,
});
const app = (id: string, ref: string | null, amount: number, extra: Partial<AppPayment> = {}): AppPayment => ({
  id, reference: ref, amount, credit_applied: 0, status: "received", received_at: "2026-10-18T10:00:00Z",
  quote_id: `Q-${id}`, customer_name: `Cust ${id}`, banked: false, ...extra,
});

const items = [pay("pay_1", 118000, 2400, 400), pay("pay_2", 236000, 4700, 700), pay("pay_3", 590000, 11800, 1800)];
const appPays = [app("a1", "pay_1", 1180), app("a2", "pay_2", 2360), app("a3", "pay_3", 5900)];

describe("isRazorpaySettlementLine", () => {
  it("money in with Razorpay in the narration", () => {
    expect(isRazorpaySettlementLine(line)).toBe(true);
    expect(isRazorpaySettlementLine({ credit: 0, description: line.description })).toBe(false);
    expect(isRazorpaySettlementLine({ credit: 500, description: "NEFT ACME LTD" })).toBe(false);
  });
});

describe("pickSettlement", () => {
  it("by UTR in the line, else by exact amount; none; many", () => {
    const other = { ...setl, id: "setl_B", utr: "AXISCN999", amount: 925100 };
    expect(pickSettlement(line, [other, setl])).toMatchObject({ kind: "found", by: "utr", settlement: { id: "setl_A" } });
    const noUtr = { ...line, reference: null, description: "RAZORPAY PAYMENTS" };
    expect(pickSettlement(noUtr, [setl, { ...setl, id: "setl_C", amount: 1 }])).toMatchObject({ kind: "found", by: "amount" });
    expect(pickSettlement(noUtr, [other, setl]).kind).toBe("many");
    expect(pickSettlement(noUtr, [{ ...setl, amount: 1 }]).kind).toBe("none");
  });
});

describe("buildSettlementPlan", () => {
  it("found: every payment matched by reference; fee + GST add up to the bank line", () => {
    const plan = buildSettlementPlan({ line, settlement: setl, items, byReference: appPays, byOrder: {}, pool: [] });
    expect(plan.blockers).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.totals).toMatchObject({ gross: 9440, refunds: 0, fee: 189, feeGst: 29, net: 9251, bank: 9251 });
    expect(plan.totals.gross - plan.totals.refunds - plan.totals.fee).toBe(plan.totals.bank);
    expect(plan.payments.map((p) => [p.rzpId, p.paymentIds, p.matchedBy])).toEqual([
      ["pay_1", ["a1"], "reference"], ["pay_2", ["a2"], "reference"], ["pay_3", ["a3"], "reference"],
    ]);
    expect(plan.rpcArg).toEqual({
      id: "setl_A", utr: "AXISCN0012345", fee_paise: 18900, tax_paise: 2900,
      payments: [
        { rzp_id: "pay_1", amount_paise: 118000, payment_ids: ["a1"] },
        { rzp_id: "pay_2", amount_paise: 236000, payment_ids: ["a2"] },
        { rzp_id: "pay_3", amount_paise: 590000, payment_ids: ["a3"] },
      ],
      refunds: [],
    });
  });

  it("ignores rows of another settlement in the same day's report", () => {
    const plan = buildSettlementPlan({ line, settlement: setl, items: [...items, pay("pay_x", 50000, 1000, 100, { settlement_id: "setl_Z" })], byReference: appPays, byOrder: {}, pool: [] });
    expect(plan.payments).toHaveLength(3);
    expect(plan.ready).toBe(true);
  });

  it("refund: payment − refund − fee = bank; the app must already show it refunded", () => {
    const s = { ...setl, amount: 113300 };
    const l = { ...line, credit: 1133 };
    const its: RzpReconItem[] = [
      pay("pay_5", 236000, 4700, 700),
      { entity_id: "rfnd_4", type: "refund", amount: 118000, credit: 0, debit: 118000, fee: 0, tax: 0, settlement_id: "setl_A", payment_id: "pay_4" },
    ];
    const ok = buildSettlementPlan({ line: l, settlement: s, items: its, byReference: [app("a5", "pay_5", 2360), app("a4", "pay_4", 1180, { status: "refunded" })], byOrder: {}, pool: [] });
    expect(ok.ready).toBe(true);
    expect(ok.totals).toMatchObject({ gross: 2360, refunds: 1180, fee: 47, net: 1133 });
    expect(ok.rpcArg?.refunds).toEqual([{ rzp_id: "rfnd_4", amount_paise: 118000, payment_ids: ["a4"] }]);

    const notYet = buildSettlementPlan({ line: l, settlement: s, items: its, byReference: [app("a5", "pay_5", 2360), app("a4", "pay_4", 1180)], byOrder: {}, pool: [] });
    expect(notYet.ready).toBe(false);
    expect(notYet.blockers.join(" ")).toMatch(/still shows it as received\. Use Refund on that payment/);

    const partial = buildSettlementPlan({ line: l, settlement: s, items: [its[0], { ...its[1], amount: 50000, debit: 50000 }], byReference: [app("a5", "pay_5", 2360), app("a4", "pay_4", 1180)], byOrder: {}, pool: [] });
    expect(partial.blockers.join(" ")).toMatch(/refunded part/);
  });

  it("unmatched payment: listed with same-amount candidates; ready only once picked", () => {
    const pool = [app("p9", "UTR999", 2360), app("p8", null, 999)];
    const plan = buildSettlementPlan({ line, settlement: setl, items, byReference: [appPays[0], appPays[2]], byOrder: {}, pool });
    expect(plan.ready).toBe(false);
    const p2 = plan.payments.find((p) => p.rzpId === "pay_2")!;
    expect(p2.paymentIds).toEqual([]);
    expect(p2.candidates.map((c) => c.id)).toEqual(["p9"]);
    expect(plan.blockers).toEqual([expect.stringContaining("pay_2 (₹2,360) is not in the app")]);

    const picked = buildSettlementPlan({ line, settlement: setl, items, byReference: [appPays[0], appPays[2]], byOrder: {}, pool, picks: { pay_2: "p9" } });
    expect(picked.ready).toBe(true);
    expect(picked.payments[1]).toMatchObject({ paymentIds: ["p9"], matchedBy: "picked" });
  });

  /* R-2918 — the owner's case (18 Nov, HDFC 4523): a settlement blocked only by a ₹1 test payment. */
  describe("R-2918 Book as Other income", () => {
    const test1 = pay("pay_TEST1", 100, 2, 0);                 // ₹1, fee 2 paise
    const withTest = [...items, test1];
    const setlT: RzpSettlement = { ...setl, amount: 925100 + 98, fees: 18902 };
    const lineT: BankLine = { ...line, credit: 9252 };
    const base = { line: lineT, settlement: setlT, items: withTest, byReference: appPays, byOrder: {}, pool: [] as AppPayment[] };

    it("without the pick the line stays blocked — nothing is Other income; ₹200 or less is only SUGGESTED", () => {
      const plan = buildSettlementPlan(base);
      expect(plan.ready).toBe(false);
      expect(plan.rpcArg).toBeNull();
      expect(plan.totals.otherIncome).toBeUndefined();
      expect(plan.blockers).toEqual([expect.stringContaining("pay_TEST1 (₹1) is not in the app")]);
      expect(plan.blockers[0]).toContain(`pick "Book as Other income"`);
      const row = plan.payments.find((p) => p.rzpId === "pay_TEST1")!;
      expect(row).toMatchObject({ paymentIds: [], suggestOtherIncome: true });
      expect(row.otherIncome).toBeFalsy();
    });

    it("with the pick the line is Ready: customer payments as before, the ₹1 goes as other_income, the fee is untouched", () => {
      const plan = buildSettlementPlan({ ...base, otherIncome: ["pay_TEST1"] });
      expect(plan.blockers).toEqual([]);
      expect(plan.ready).toBe(true);
      expect(plan.totals).toMatchObject({ gross: 9441, otherIncome: 1, fee: 189, bank: 9252 });
      expect(plan.payments.find((p) => p.rzpId === "pay_TEST1")).toMatchObject({ otherIncome: true, paymentIds: [], customer: null, problem: null });
      expect(plan.rpcArg).toMatchObject({
        fee_paise: 18902,
        payments: [
          { rzp_id: "pay_1", amount_paise: 118000, payment_ids: ["a1"] },
          { rzp_id: "pay_2", amount_paise: 236000, payment_ids: ["a2"] },
          { rzp_id: "pay_3", amount_paise: 590000, payment_ids: ["a3"] },
        ],
        other_income: [{ rzp_id: "pay_TEST1", amount_paise: 100 }],
      });
    });

    it("a bigger payment (above ₹200) is not suggested and needs the explicit pick too", () => {
      const big = [...items, pay("pay_BIG", 50000, 1000, 100)];
      const s: RzpSettlement = { ...setl, amount: 925100 + 49000 };
      const l: BankLine = { ...line, credit: 9741 };
      const none = buildSettlementPlan({ line: l, settlement: s, items: big, byReference: appPays, byOrder: {}, pool: [] });
      expect(none.ready).toBe(false);
      expect(none.payments.find((p) => p.rzpId === "pay_BIG")).toMatchObject({ suggestOtherIncome: false });
      const picked = buildSettlementPlan({ line: l, settlement: s, items: big, byReference: appPays, byOrder: {}, pool: [], otherIncome: ["pay_BIG"] });
      expect(picked.ready).toBe(true);
      expect(picked.rpcArg?.other_income).toEqual([{ rzp_id: "pay_BIG", amount_paise: 50000, order_id: null }]);
    });

    it("review: a small payment the app MAY have (a same-amount unbanked receipt) is not suggested; the month batch never takes the pick for it", () => {
      const pool = [app("p9", null, 1)];                                    // a ₹1 receipt recorded by hand, no pay_ reference
      const plan = buildSettlementPlan({ ...base, pool });
      const row = plan.payments.find((p) => p.rzpId === "pay_TEST1")!;
      expect(row.candidates.map((c) => c.id)).toEqual(["p9"]);
      expect(row).toMatchObject({ canOtherIncome: true, suggestOtherIncome: false });
      /* one line at a time the owner sees the receipt in the same list and may still choose Other income */
      expect(buildSettlementPlan({ ...base, pool, otherIncome: ["pay_TEST1"] }).ready).toBe(true);
      /* the month batch (no list to choose from) leaves it blocked */
      const batch = buildSettlementPlan({ ...base, pool, otherIncome: ["pay_TEST1"], otherIncomeOnlyWithoutCandidates: true });
      expect(batch.ready).toBe(false);
      expect(batch.rpcArg).toBeNull();
    });

    it("review: a payment made on a quote's Razorpay order in the app is the customer's money — the pick is ignored and not offered", () => {
      const onOrder = [...items, pay("pay_TEST1", 100, 2, 0, { order_id: "order_Q7" })];
      const plan = buildSettlementPlan({ ...base, items: onOrder, byOrder: { order_Q7: [] }, otherIncome: ["pay_TEST1"] });
      expect(plan.ready).toBe(false);
      expect(plan.totals.otherIncome).toBeUndefined();
      const row = plan.payments.find((p) => p.rzpId === "pay_TEST1")!;
      expect(row).toMatchObject({ canOtherIncome: false, suggestOtherIncome: false });
      expect(row.problem).toContain("paid on a quote's payment link (order order_Q7)");
      expect(row.problem).not.toContain("Other income");
      /* an order the app does not know is passed on for the database's own check */
      const unknown = buildSettlementPlan({ ...base, items: onOrder, otherIncome: ["pay_TEST1"] });
      expect(unknown.rpcArg?.other_income).toEqual([{ rzp_id: "pay_TEST1", amount_paise: 100, order_id: "order_Q7" }]);
    });

    it("review: a payment under 50 paise (₹0 in whole rupees) cannot be picked and is not offered", () => {
      const tiny = [...items, pay("pay_TINY", 40, 1, 0)];
      const s: RzpSettlement = { ...setl, amount: 925100 + 39 };
      const plan = buildSettlementPlan({ line, settlement: s, items: tiny, byReference: appPays, byOrder: {}, pool: [], otherIncome: ["pay_TINY"] });
      expect(plan.ready).toBe(false);
      const row = plan.payments.find((p) => p.rzpId === "pay_TINY")!;
      expect(row).toMatchObject({ canOtherIncome: false, suggestOtherIncome: false });
      expect(row.problem).not.toContain("Other income");
    });

    it("the pick never overrides a payment the app HAS (reference, or the owner's app-payment pick) — no customer money becomes income", () => {
      const plan = buildSettlementPlan({ line, settlement: setl, items, byReference: appPays, byOrder: {}, pool: [], otherIncome: ["pay_1", "pay_2", "pay_3"] });
      expect(plan.ready).toBe(true);
      expect(plan.totals.otherIncome).toBeUndefined();
      expect(plan.rpcArg?.other_income).toBeUndefined();
      expect(plan.rpcArg?.payments).toHaveLength(3);
      const pool = [app("p9", null, 1)];
      const both = buildSettlementPlan({ ...base, pool, picks: { pay_TEST1: "p9" }, otherIncome: ["pay_TEST1"] });
      expect(both.payments.find((p) => p.rzpId === "pay_TEST1")).toMatchObject({ paymentIds: ["p9"], matchedBy: "picked" });
      expect(both.rpcArg?.other_income).toBeUndefined();
    });

    it("other blockers stay: a pick does not make a wrong-amount settlement Ready", () => {
      const plan = buildSettlementPlan({ ...base, line: { ...lineT, credit: 9000 }, otherIncome: ["pay_TEST1"] });
      expect(plan.ready).toBe(false);
      expect(plan.rpcArg).toBeNull();
    });

    it("a settlement of only not-in-the-app payments is Ready once every one is picked (no app payment at all)", () => {
      const only = [pay("pay_T1", 10000, 236, 36), pay("pay_T2", 12500, 295, 45)];
      const s: RzpSettlement = { ...setl, amount: 22500 - 531, fees: 531, tax: 81 };
      const l: BankLine = { ...line, credit: 220 };
      const one = buildSettlementPlan({ line: l, settlement: s, items: only, byReference: [], byOrder: {}, pool: [], otherIncome: ["pay_T1"] });
      expect(one.ready).toBe(false);
      const all = buildSettlementPlan({ line: l, settlement: s, items: only, byReference: [], byOrder: {}, pool: [], otherIncome: ["pay_T1", "pay_T2"] });
      expect(all.ready).toBe(true);
      expect(all.rpcArg).toMatchObject({ payments: [], other_income: [{ rzp_id: "pay_T1", amount_paise: 10000 }, { rzp_id: "pay_T2", amount_paise: 12500 }] });
      expect(all.totals).toMatchObject({ gross: 225, otherIncome: 225, fee: 5 });
    });
  });

  it("matched by Razorpay order id when the reference is missing", () => {
    const plan = buildSettlementPlan({
      line, settlement: setl,
      items: [items[0], pay("pay_2", 236000, 4700, 700, { order_id: "order_2" }), items[2]],
      byReference: [appPays[0], appPays[2]], byOrder: { order_2: [app("o2", "manual", 2360)] }, pool: [],
    });
    expect(plan.ready).toBe(true);
    expect(plan.payments[1]).toMatchObject({ paymentIds: ["o2"], matchedBy: "order" });
  });

  it("blocks: amount differs, already banked, wrong settlement amount, adjustments, empty report", () => {
    const diff = buildSettlementPlan({ line, settlement: setl, items, byReference: [app("a1", "pay_1", 1200), appPays[1], appPays[2]], byOrder: {}, pool: [] });
    expect(diff.blockers.join(" ")).toMatch(/Razorpay says ₹1,180 for pay_1 but the app recorded ₹1,200/);

    const banked = buildSettlementPlan({ line, settlement: setl, items, byReference: [app("a1", "pay_1", 1180, { banked: true }), appPays[1], appPays[2]], byOrder: {}, pool: [] });
    expect(banked.blockers.join(" ")).toMatch(/already reconciled to another bank line/);

    const wrong = buildSettlementPlan({ line: { ...line, credit: 9000 }, settlement: setl, items, byReference: appPays, byOrder: {}, pool: [] });
    expect(wrong.blockers.join(" ")).toMatch(/not the right settlement/);

    const adj = buildSettlementPlan({
      line: { ...line, credit: 9151 }, settlement: { ...setl, amount: 915100 },
      items: [...items, { entity_id: "adj_1", type: "adjustment", amount: 10000, credit: 0, debit: 10000, fee: 0, tax: 0, settlement_id: "setl_A" }],
      byReference: appPays, byOrder: {}, pool: [],
    });
    expect(adj.ready).toBe(false);
    expect(adj.blockers.join(" ")).toMatch(/adjustment/);

    const empty = buildSettlementPlan({ line, settlement: setl, items: [], byReference: [], byOrder: {}, pool: [] });
    expect(empty.ready).toBe(false);
    expect(empty.rpcArg).toBeNull();
  });

  it("one Razorpay payment the app split into two rows (R-1985) is one match", () => {
    const plan = buildSettlementPlan({
      line, settlement: setl, items,
      byReference: [appPays[0], app("a2a", "pay_2", 1000), app("a2b", "pay_2", 1360), appPays[2]], byOrder: {}, pool: [],
    });
    expect(plan.ready).toBe(true);
    expect(plan.payments[1].paymentIds).toEqual(["a2a", "a2b"]);
  });
});

/* R-2099 staging bug (30 Oct 2026): every real line said "The settlement is ₹2,535 but this bank
   line is ₹2,535. This is not the right settlement". Razorpay's fee is 2% + 18% GST, so a real
   settlement carries paise (₹2,534.73 here), while the bank import stores whole rupees
   (statement-parse parseAmount rounds) — the line was ₹2,535 and the paise compare never met. */
describe("real-shaped settlement with paise vs a whole-rupee bank line", () => {
  // Razorpay JSON shapes: every amount in paise; fee includes its GST.
  const settlementJson = { id: "setl_RealP4ise", entity: "settlement", amount: 253473, status: "processed", fees: 6127, tax: 935, utr: "AXISCN0099887", created_at: 1792474200 };
  const reconJson = [
    { entity_id: "pay_Real1", type: "payment", amount: 118000, fee: 2785, tax: 425, debit: 0, credit: 115215, settlement_id: "setl_RealP4ise", order_id: "order_R1", method: "upi", created_at: 1792300000 },
    { entity_id: "pay_Real2", type: "payment", amount: 141600, fee: 3342, tax: 510, debit: 0, credit: 138258, settlement_id: "setl_RealP4ise", order_id: "order_R2", method: "card", created_at: 1792300500 },
  ];
  const s: RzpSettlement = { id: settlementJson.id, amount: settlementJson.amount, fees: settlementJson.fees, tax: settlementJson.tax, utr: settlementJson.utr, status: settlementJson.status, created_at: settlementJson.created_at };
  const its = reconJson.map((r) => ({ ...r, payment_id: null, description: null })) as RzpReconItem[];
  const bank: BankLine = {
    id: "L9", credit: 2535, txn_date: "2026-10-20", reference: null,
    description: "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-AXISCN0099887",
  };
  const apps = [app("r1", "pay_Real1", 1180), app("r2", "pay_Real2", 1416)];

  it("the whole-rupee bank line is the right settlement — ready, no blocker", () => {
    const plan = buildSettlementPlan({ line: bank, settlement: s, items: its, byReference: apps, byOrder: {}, pool: [] });
    expect(plan.blockers).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(plan.totals).toMatchObject({ gross: 2596, fee: 61, feeGst: 9, net: 2535, bank: 2535 });
  });

  it("fee + GST go to the database in Razorpay's paise, untouched", () => {
    const plan = buildSettlementPlan({ line: bank, settlement: s, items: its, byReference: apps, byOrder: {}, pool: [] });
    expect(plan.rpcArg).toMatchObject({ fee_paise: 6127, tax_paise: 935 });
    expect(plan.rpcArg?.payments.map((p) => p.amount_paise)).toEqual([118000, 141600]);
    // what reconcile_razorpay_settlement derives: cash − bank = the fee, within its tolerance
    expect(plan.totals.gross - plan.totals.bank).toBe(Math.round(6127 / 100));
  });

  it("found by amount too when the line carries no UTR, and with the statement's paise", () => {
    expect(pickSettlement({ ...bank, description: "RAZORPAY PAYMENTS PVT LTD" }, [s])).toMatchObject({ kind: "found", by: "amount" });
    expect(pickSettlement({ ...bank, credit: 2534.73, description: "RAZORPAY" }, [s])).toMatchObject({ kind: "found", by: "amount" });
    const exact = buildSettlementPlan({ line: { ...bank, credit: 2534.73 }, settlement: s, items: its, byReference: apps, byOrder: {}, pool: [] });
    expect(exact.ready).toBe(true);
  });

  it("a rupee off is still the wrong settlement", () => {
    const off = buildSettlementPlan({ line: { ...bank, credit: 2534 }, settlement: s, items: its, byReference: apps, byOrder: {}, pool: [] });
    expect(off.ready).toBe(false);
    expect(off.blockers.join(" ")).toMatch(/not the right settlement/);
    expect(pickSettlement({ ...bank, credit: 2534, description: "RAZORPAY" }, [s])).toEqual({ kind: "none" });
  });
});
