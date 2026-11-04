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
