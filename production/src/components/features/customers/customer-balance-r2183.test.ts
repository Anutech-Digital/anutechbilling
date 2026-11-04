/**
 * R-2183 (Zoho audit 31 Oct, ux.md task 7): ABDCA on localhost — Overview "Outstanding ₹1,632",
 * Statement "Closing balance ₹1,554 credit". Same customer, opposite answers. The subscription
 * on Q-F588-27-0068 (annual commit billed monthly, instalment ₹3,186) has no invoice yet and
 * an RV of ₹1,554 was received against it, so the truth is "₹1,632 still due".
 * One balance from one function: the statement carries the not-yet-invoiced subscription due
 * (R-1708 rule, lib/payments/receivables.ts) and the Overview reads the statement closing.
 */
import { describe, expect, it } from "vitest";
import { buildCustomerStatement, type StatementInput } from "./customer-statement";
import { deriveCustomerInsights } from "./customer-insights";

const base: StatementInput = { invoices: [], payments: [], creditNotes: [], debitNotes: [], projectPayments: [] };

const abdca: StatementInput = {
  ...base,
  payments: [{ id: "p1", quote_id: "Q-F588-27-0068", invoice_id: null, amount: 1554, status: "received", received_at: "2026-10-31T04:00:00Z", receipt_voucher_no: "RV-F588-27-0058" }],
  uninvoicedDues: [{ quoteId: "Q-F588-27-0068", date: "2026-10-31", due: 1632 }],
};

describe("R-2183 one customer balance — Overview = Statement", () => {
  it("ABDCA: the advance against an un-invoiced instalment leaves ₹1,632 owed, not ₹1,554 credit", () => {
    const s = buildCustomerStatement(abdca);
    expect(s.closing).toBe(1632);
    expect(s.rows.map((r) => [r.desc, r.debit, r.credit, r.balance])).toEqual([
      ["Instalment due · Q-F588-27-0068 (not invoiced yet)", 3186, 0, 3186],
      ["Payment received · RV-F588-27-0058", 0, 1554, 1632],
    ]);
    expect(s.advanceNotes).toEqual(["Advance ₹1,554 against Q-F588-27-0068, ₹1,632 still due"]);
  });

  it("the Overview Outstanding is the statement closing, same sign, with the advance line", () => {
    const s = buildCustomerStatement(abdca);
    const sub = { id: "s1", quote_id: "Q-F588-27-0068", status: "active", outstanding_amount: 1632, mrr: 2700 };
    const ins = deriveCustomerInsights({ name: "ABDCA" } as never, [sub] as never, [], [], [], 1554, s);
    expect(ins.outstanding).toBe(s.closing);
    expect(ins.credit).toBe(0);
    expect(ins.outstandingNote).toBe("Advance ₹1,554 against Q-F588-27-0068, ₹1,632 still due");
  });

  it("invoice + part payment + advance + credit note: Overview figure === Statement closing (credit side)", () => {
    const s = buildCustomerStatement({
      ...base,
      invoices: [{ id: "INV-1", invoice_date: "2026-10-01", amount: 5000, status: "pending", net_payable: 5000, paid_amount: 2000 }],
      payments: [
        { id: "p1", quote_id: "Q-1", invoice_id: "INV-1", amount: 2000, status: "received", received_at: "2026-10-02T00:00:00Z" },
        { id: "p2", quote_id: "Q-ADV", invoice_id: null, amount: 4000, status: "received", received_at: "2026-10-03T00:00:00Z" },
      ],
      creditNotes: [{ id: "CN-1", invoice_id: "INV-1", credit_date: "2026-10-04", amount: 1000 }],
    });
    expect(s.closing).toBe(-2000);
    const ins = deriveCustomerInsights({ name: "X" } as never, [], [], [], [], 6000, s);
    expect(ins.outstanding).toBe(0);
    expect(ins.credit).toBe(2000);
  });

  it("an invoiced quote's subscription due is not added again (the invoice is the claim)", () => {
    const s = buildCustomerStatement({
      ...base,
      invoices: [{ id: "INV-2", invoice_date: "2026-10-01", amount: 3186, status: "pending" }],
      uninvoicedDues: [],
    });
    expect(s.closing).toBe(3186);
    expect(s.advanceNotes).toEqual([]);
  });
});
