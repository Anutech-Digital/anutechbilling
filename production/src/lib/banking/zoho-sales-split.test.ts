/**
 * R-2518 — one bank receipt that paid SEVERAL Zoho invoices → one app sale per Zoho invoice.
 * Staging (a client company): UPI ₹6,294 = INV/26-27/0516 ₹3,243 (15 × 180 + 1 × 48) + INV/26-27/0517 ₹3,051
 * (14 × 180 + 1 × 66). Pure rules (groups, amounts), the split RPC's arguments, the bulk "Reconcile
 * from Zoho" plan and its "Book selected" call. Zoho and the database are never called.
 */
import { describe, expect, it, vi } from "vitest";
import { zohoInvoiceGroups, zohoSalesPlan } from "./zoho-sales-split";
import { splitArgs } from "./credit-pay-for-multi";
import type { SaleLine } from "./credit-pay-for";
import type { BulkLine, PlanContext } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import { planAllWithZohoSales as planAll, type ZohoSalesSpec } from "@/lib/integrations/zoho-books/bulk-zoho-sales";
import type { ZohoMatchLine, ZohoPaymentMatch } from "@/lib/integrations/zoho-books/payment-match";
import { bookRows, type BookDeps } from "@/components/features/banking/zoho-bulk-book";

const sl = (name: string, qty: number, rate: number, zohoInvoice?: string): SaleLine =>
  ({ itemId: null, name, qty, rate, cost: 0, cycle: "one_time", perSeat: true, ...(zohoInvoice ? { zohoInvoice } : {}) });

describe("R-2518 zohoInvoiceGroups", () => {
  it("lines of two Zoho invoices → two groups in first-seen order", () => {
    const g = zohoInvoiceGroups([sl("Seat", 15, 180, "INV/26-27/0516"), sl("Seat", 14, 180, "INV/26-27/0517"), sl("Storage", 1, 48, "inv/26-27/0516 "), sl("Storage", 1, 66, "INV/26-27/0517")]);
    expect(g?.map((x) => x.externalNumber)).toEqual(["INV/26-27/0516", "INV/26-27/0517"]);
    expect(g?.[0].lines.map((l) => [l.qty, l.rate])).toEqual([[15, 180], [1, 48]]);
    expect(g?.[1].lines.map((l) => [l.qty, l.rate])).toEqual([[14, 180], [1, 66]]);
  });
  it("one invoice, an untagged (hand-added) line, or no lines → null (one sale, as before)", () => {
    expect(zohoInvoiceGroups([sl("Seat", 1, 180, "INV/1"), sl("Storage", 1, 48, "INV/1")])).toBeNull();
    expect(zohoInvoiceGroups([sl("Seat", 1, 180, "INV/1"), sl("Storage", 1, 48, "INV/2"), sl("Typed", 1, 10)])).toBeNull();
    expect(zohoInvoiceGroups([])).toBeNull();
  });
});

describe("R-2518 zohoSalesPlan (SQL twin: bank_sale_split_amounts)", () => {
  it("exact → each in full, no rest", () => {
    expect(zohoSalesPlan([3243, 3051], 6294)).toEqual({ amounts: [3243, 3051], rest: null, shortOnLast: 0, problem: null });
  });
  it("never a write-off: ₹34 short stays due on the last; any extra is advance", () => {
    expect(zohoSalesPlan([3243, 3051], 6260)).toEqual({ amounts: [3243, 3017], rest: null, shortOnLast: 34, problem: null });
    expect(zohoSalesPlan([3243, 3051], 6300)).toMatchObject({ amounts: [3243, 3051], rest: "advance" });
    expect(zohoSalesPlan([3243, 3051], 7000)).toMatchObject({ amounts: [3243, 3051], rest: "advance" });
  });
  it("short by more than ₹50 → the LAST sale part-paid, the rest stays due", () => {
    expect(zohoSalesPlan([3243, 3051], 6000)).toEqual({ amounts: [3243, 2757], rest: null, shortOnLast: 294, problem: null });
    expect(zohoSalesPlan([3243, 3051], 3000).problem).toMatch(/does not reach the last Zoho invoice/);
  });
});

describe("R-2518 splitArgs with several sales", () => {
  it("p_sale is an array, each with its own external_number; no single p_external_number", () => {
    const a = splitArgs({
      transactionId: "t", customerId: "c", items: [], rest: null, externalNumber: "IGNORED",
      sale: [
        { lines: [1], billingCycle: "yearly", createSubscription: false, subStart: null, subRenewal: null, amount: 3243, externalNumber: " INV/26-27/0516 " },
        { lines: [2], billingCycle: "yearly", createSubscription: false, subStart: null, subRenewal: null, amount: 3051, externalNumber: "INV/26-27/0517" },
      ],
    });
    expect(a.p_sale).toEqual([
      { lines: [1], billing_cycle: "yearly", create_subscription: false, sub_start: null, sub_renewal: null, amount: 3243, external_number: "INV/26-27/0516" },
      { lines: [2], billing_cycle: "yearly", create_subscription: false, sub_start: null, sub_renewal: null, amount: 3051, external_number: "INV/26-27/0517" },
    ]);
    expect(a).not.toHaveProperty("p_external_number");
  });
  it("one sale stays an object (unchanged shape)", () => {
    const a = splitArgs({ transactionId: "t", customerId: "c", items: [], rest: null, externalNumber: "INV/1",
      sale: { lines: [], billingCycle: null, createSubscription: false, subStart: null, subRenewal: null, amount: 10 } });
    expect(a.p_sale).toEqual({ lines: [], billing_cycle: null, create_subscription: false, sub_start: null, sub_renewal: null, amount: 10 });
    expect(a.p_external_number).toBe("INV/1");
  });
});

/* ── The bulk "Reconcile from Zoho" plan + Book selected ─────────────────────────────────────────── */
const ctx: PlanContext = {
  customers: [{ id: "c-kite", name: "Kite Buyer", gstin: null, state_code: "07", country: "India", domain: "kitebuyer.in" }],
  subscriptions: [], catalog: [], payers: [], ownNames: ["Our Own Company"], today: "2026-11-06",
};
const zl = (no: string, name: string, qty: number, rate: number): ZohoMatchLine =>
  ({ invoiceNumber: no, name, sku: null, qty, rate, itemTotal: qty * rate, start: null, end: null, months: 0, domain: null });
const twoInv = (tds = 0): ZohoPaymentMatch => ({
  by: "utr",
  payment: { zohoId: "pay-1", number: "9001", date: "2026-06-29", amount: 6294 - tds, reference: "UTR2518A", customerZohoId: "z-1", customerName: "Kite Buyer", taxWithheld: tds },
  customer: { zohoId: "z-1", name: "Kite Buyer", gstin: null },
  invoices: [
    { zohoId: "i1", number: "INV/26-27/0516", date: "2026-06-29", amountApplied: 3243, total: 3243, lines: [zl("INV/26-27/0516", "Seat", 15, 180), zl("INV/26-27/0516", "Storage", 1, 48)] },
    { zohoId: "i2", number: "INV/26-27/0517", date: "2026-06-29", amountApplied: 3051, total: 3051, lines: [zl("INV/26-27/0517", "Seat", 14, 180), zl("INV/26-27/0517", "Storage", 1, 66)] },
  ],
  moreInvoices: [],
});
const line = (credit: number): BulkLine => ({ id: "t-1", txnDate: "2026-06-29", credit, description: "UPI/UTR2518A/KITE BUYER", reference: "UTR2518A" });
const facts = { customerId: "c-kite", openItems: [], openings: [], receipts: [], billed: [] };

describe("R-2518 bulk plan: a Zoho payment for two invoices → two sales", () => {
  it("books two sales with their Zoho numbers and amounts — never one merged sale", () => {
    const [row] = planAll([{ line: line(6294), result: { kind: "match", match: twoInv() }, contact: null, facts, booksStart: "2025-04-01" }], ctx);
    expect(row.problems).toEqual([]);
    expect(row.book?.kind).toBe("new_sale");
    expect(row.book?.externalNumber).toBeNull();
    expect((row.book as ZohoSalesSpec | null)?.sales?.map((s) => [s.externalNumber, s.total, s.amount, s.lines.length])).toEqual([
      ["INV/26-27/0516", 3243, 3243, 2], ["INV/26-27/0517", 3051, 3051, 2],
    ]);
    expect((row.book as ZohoSalesSpec | null)?.salesRest).toBeNull();
  });
  it("Zoho TDS on a payment for two invoices → not booked, the reason says so", () => {
    const [row] = planAll([{ line: line(6000), result: { kind: "match", match: twoInv(294) }, contact: null, facts, booksStart: "2025-04-01" }], ctx);
    expect(row.book).toBeNull();
    expect(row.problems.join(" ")).toMatch(/TDS ₹294 on a payment for 2 invoices/);
  });
  it("Book selected sends ONE split call with both sales", async () => {
    const [row] = planAll([{ line: line(6294), result: { kind: "match", match: twoInv() }, contact: null, facts, booksStart: "2025-04-01" }], ctx);
    const paySplit = vi.fn(async () => ({
      kind: "split", amount: 6294, parts: [
        { kind: "one_off", quote_id: "Q-1", invoice_issued: "INV-A-1", new_quote: true, amount: 3243 },
        { kind: "one_off", quote_id: "Q-2", invoice_issued: "INV-A-2", new_quote: true, amount: 3051 },
      ],
    }));
    const newSale = vi.fn();
    const deps = {
      isReconciled: async () => false, createCustomer: vi.fn(), setPayer: vi.fn(), newSale, saleSubscriptions: async () => [],
      setSubDates: vi.fn(), payItem: vi.fn(), payOpening: vi.fn(), paySplit,
    } as unknown as BookDeps;
    const run = await bookRows([row], new Set([row.txnId]), new Set(), deps);
    expect(run.error).toBeNull();
    expect(newSale).not.toHaveBeenCalled();
    expect(paySplit).toHaveBeenCalledTimes(1);
    const arg = (paySplit.mock.calls[0] as unknown as [{ sale: Array<{ externalNumber: string; amount: number; lines: unknown[] }>; items: unknown[] }])[0];
    expect(arg.items).toEqual([]);
    expect(arg.sale.map((s) => [s.externalNumber, s.amount, s.lines.length])).toEqual([["INV/26-27/0516", 3243, 2], ["INV/26-27/0517", 3051, 2]]);
    expect(run.done[0].text).toBe("Booked 2 sales, one per Zoho invoice (INV/26-27/0516 → INV-A-1, INV/26-27/0517 → INV-A-2) — line reconciled.");
  });
});
