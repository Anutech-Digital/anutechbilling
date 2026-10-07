/**
 * R-371 — the Accounting "Owed to you" folder must total what customers actually owe:
 * net_payable (after credit notes / adjusted advances) minus receipts since, not amount − paid.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { receivableRows } from "./receivables";

const TODAY = "2026-10-10";
const inv = (o: Record<string, unknown>) => ({
  status: "pending", amount: 0, net_payable: null, paid_amount: 0, due_date: "2026-10-01", ...o,
}) as Parameters<typeof receivableRows>[0][number];

describe("receivableRows", () => {
  it("totals net_payable − paid (credit note, advance, old row without net_payable)", () => {
    const rows = receivableRows([
      inv({ amount: 11800, net_payable: 10620 }),                       // credit note 1,180
      inv({ amount: 50000, net_payable: 30000, paid_amount: 5000 }),    // advance 20k + receipt 5k
      inv({ amount: 2000,  net_payable: null,  paid_amount: 500 }),     // pre-0005 row
      inv({ amount: 10000, net_payable: 0 }),                            // fully covered → dropped
      inv({ amount: 9999,  status: "paid" }),                             // not a receivable
    ], TODAY);
    expect(rows.map((r) => r.amountDue)).toEqual([10620, 25000, 1500]);
    expect(rows.reduce((s, r) => s + r.amountDue, 0)).toBe(37120);
  });

  it("days overdue in IST calendar days", () => {
    expect(receivableRows([inv({ amount: 100, due_date: "2026-10-01" })], TODAY)[0].daysOverdue).toBe(9);
    expect(receivableRows([inv({ amount: 100, due_date: null })], TODAY)[0].daysOverdue).toBe(0);
  });

  it("the Accounting page uses this helper, not its own amount − paid math", () => {
    const src = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(src).toContain("receivableRows(");
    expect(src).not.toMatch(/\(i\.amount \?\? 0\) - \(i\.paid_amount/);
  });
});
