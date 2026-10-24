/* R-1670 (2) — the invoice (PDF + dialog) shows an advance paid with TDS as bank money + TDS,
   not one gross "Bank transfer ₹1,52,928" that the bank statement (₹1,50,336) never matches. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { advanceLinesWithTds, advanceMethodLabel } from "@/lib/accounting/tds-receipt";

const adv = { payment_id: "p1", voucher_no: "RV-7", received_at: "2026-10-19", method: "bank_transfer", amount: 152928 };

describe("advance with TDS on the invoice (R-1670 item 2)", () => {
  it("T-2: ₹1,52,928 settled = ₹1,50,336 in the bank + ₹2,592 TDS", () => {
    const lines = advanceLinesWithTds([adv], { p1: 2592 });
    expect(lines.map((l) => [advanceMethodLabel(l.method), l.amount])).toEqual([
      ["Bank transfer", 150336],
      ["TDS deducted by customer", 2592],
    ]);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(152928);
    expect(lines[1].voucherNo).toBeNull();
  });

  it("no TDS on the payment → one line, as before", () => {
    expect(advanceLinesWithTds([adv], {})).toHaveLength(1);
    expect(advanceLinesWithTds([adv], null)[0].amount).toBe(152928);
  });

  it("the PDF, the dialog and the server PDF route all use the split", () => {
    const root = process.cwd();
    const pdf = fs.readFileSync(path.join(root, "src/lib/pdf/InvoicePDF.tsx"), "utf8");
    expect(pdf).toMatch(/advanceLinesWithTds\(advances, advanceTds\)/);
    const dialog = fs.readFileSync(path.join(root, "src/components/features/quotes/tax-invoice-dialog.tsx"), "utf8");
    expect(dialog).toMatch(/advanceLinesWithTds\(/);
    expect(dialog).toMatch(/advanceTds/);
    const route = fs.readFileSync(path.join(root, "src/app/api/v1/documents/invoice/[id]/pdf/route.ts"), "utf8");
    expect(route).toMatch(/advanceTds/);
  });
});
