/**
 * R-2397 — a new sale booked from a bank credit at a below-cost price waits for the owner's
 * approval (same rule as R-2213 / R-2344). Staging 3 Nov: Manage-seats quotes stopped at
 * "Needs approval" while the same below-cost price saved straight through from the drawer.
 * The server side is proven by supabase/tests/r2397_bank_sale_below_cost_approval.test.sql;
 * this pins the drawer's message and that its rule is the server's.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BANK_SALE_BELOW_COST_TEXT, approvalWaitLines, resultLines, saleLinesBelowCost, type PayForResult, type SaleLine,
} from "./credit-pay-for";

const line = (p: Partial<SaleLine>): SaleLine => ({
  itemId: null, name: "Google Workspace Business Starter", qty: 1, rate: 1000, cost: 0,
  cycle: "annual_yearly", perSeat: true, ...p,
});

const MIG_DIR = join(__dirname, "../../../supabase/migrations");
const migration = () => {
  const f = readdirSync(MIG_DIR).find((n) => n.endsWith("_r2397_bank_sale_below_cost_approval.sql"));
  if (!f) throw new Error("R-2397 migration missing");
  return readFileSync(join(MIG_DIR, f), "utf8");
};

describe("R-2397 saleLinesBelowCost — the server's rule (bank_sale_lines_below_cost)", () => {
  it("owner's case: sold ₹800/seat on a ₹1,000 cost → below cost", () => {
    expect(saleLinesBelowCost([line({ qty: 10, rate: 800, cost: 1000 })])).toBe(true);
  });
  it("at cost or above → not below cost (unchanged path)", () => {
    expect(saleLinesBelowCost([line({ qty: 10, rate: 1000, cost: 1000 })])).toBe(false);
    expect(saleLinesBelowCost([line({ qty: 10, rate: 1200, cost: 1000 })])).toBe(false);
  });
  it("unknown cost (₹0 on a vendor line) is not below cost", () => {
    expect(saleLinesBelowCost([line({ rate: 500, cost: 600, qty: 2 }), line({ rate: 300, cost: 0 })])).toBe(false);
  });
  it("our own SUP- support plan at ₹0 is a known cost", () => {
    expect(saleLinesBelowCost([line({ rate: 500, cost: 600, qty: 2 }), line({ itemId: "SUP-STD-YR", rate: 100, cost: 0 })])).toBe(true);
  });
  it("rounds like marginBps: −0.49 bps is 0, −2 bps is below", () => {
    expect(saleLinesBelowCost([line({ rate: 10000.5, cost: 10001 })])).toBe(false);
    expect(saleLinesBelowCost([line({ rate: 9998, cost: 10000 })])).toBe(true);
  });
});

describe("R-2397 drawer message after Save", () => {
  const waiting: PayForResult = {
    kind: "new", quote_id: "Q-A378-27-0901", invoice_id: null, invoice_issued: null, payment_id: "",
    receipt_voucher_no: null, amount: 0, tds_amount: 0, outstanding: 0, is_fully_paid: false, overpaid_credit: 0,
    renewal_rolled_forward: false, subscription_skipped: false, already_recorded: false, subscriptions: [],
    needs_approval: true, reconciled: false,
    reason: "This price is below cost, so the sale waits for the owner's approval. Quote Q-A378-27-0901 is in Needs approval and the bank line stays unmatched. Approve it (Quotes → Q-A378-27-0901 → Approve), then open this bank line again and pick Q-A378-27-0901.",
  };

  it("says why, links the quote, and never says paid / reconciled", () => {
    const lines = resultLines(waiting);
    expect(lines[0]).toMatchObject({ text: waiting.reason, tone: "warn" });
    expect(lines[1]).toEqual({ text: "Open quote Q-A378-27-0901 (Needs approval)", href: "/quotes/Q-A378-27-0901" });
    expect(lines.map((l) => l.text).join(" ")).not.toMatch(/paid|reconciled →/i);
  });

  it("a split that waits shows the same message (not its parts)", () => {
    expect(resultLines({ ...waiting, kind: "split", parts: [] })).toEqual(resultLines(waiting));
  });

  it("falls back to the plain sentence when the server sent no reason; keeps the Zoho number in view", () => {
    const l = approvalWaitLines({ ...waiting, reason: null, external_number: "INV/26-27/2397" } as PayForResult & { external_number: string });
    expect(l[0].text).toBe(BANK_SALE_BELOW_COST_TEXT);
    expect(l[2].text).toContain("INV/26-27/2397");
  });

  it("the drawer's sentence is the server's word for word", () => {
    const sql = migration().replace(/''/g, "'");
    expect(sql).toContain(`then '${BANK_SALE_BELOW_COST_TEXT}'`);
  });
});
