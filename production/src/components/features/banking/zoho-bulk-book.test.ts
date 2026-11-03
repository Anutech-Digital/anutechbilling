/**
 * R-2402 — "Book selected": one row at a time through the sheet's own steps; a line is never booked
 * twice (re-run skips it); the first error stops the run; a new Zoho customer is created once (with
 * its email / phone); a UTR-matched payer is recorded on the customer's behalf; each extra new
 * subscription gets its own renewal date. All database calls are fakes.
 */
import { describe, it, expect, vi } from "vitest";
import { bookRows, matchDateFixes, newCustomerPayload, type BookDeps } from "./zoho-bulk-book";
import { planRow, type PlanContext } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import type { ZohoMatchLine, ZohoPaymentMatch } from "@/lib/integrations/zoho-books/payment-match";
import type { PayForResult } from "@/lib/banking/credit-pay-for";

const ctx: PlanContext = {
  customers: [{ id: "c-zuna", name: "Zuna Private Limited", gstin: null, state_code: "06", country: "India", domain: "zuna.one" }],
  subscriptions: [], catalog: [], payers: [], ownNames: ["Our Own Company"],
};
const zl = (over: Partial<ZohoMatchLine>): ZohoMatchLine => ({
  invoiceNumber: "INV/26-27/1", name: "Workspace", sku: null, qty: 1, rate: 1000, itemTotal: null,
  start: "2026-10-29", end: "2027-10-28", months: 12, domain: "zuna.store", ...over,
});
function m(name: string, lines: ZohoMatchLine[], gstin: string | null = null): ZohoPaymentMatch {
  const amt = Math.round(lines.reduce((s, l) => s + l.qty * (l.rate ?? 0), 0) * 1.18);
  return {
    by: "utr", payment: { zohoId: "p", number: "1", date: "2026-10-29", amount: amt, reference: "", customerZohoId: `z-${name}`, customerName: name },
    customer: { zohoId: `z-${name}`, name, gstin }, invoices: [{ zohoId: "i", number: "INV/26-27/1", date: null, amountApplied: amt, total: amt, lines }], moreInvoices: [],
  };
}
const row = (id: string, match: ZohoPaymentMatch, desc = "IMPS-1-ZUNA PRIVATE LIMITED-x", contact: Parameters<typeof planRow>[2] = null) =>
  planRow({ id, txnDate: "2026-10-29", credit: match.payment.amount, description: desc, reference: null }, match, contact, ctx);

const result = (over: Partial<PayForResult> = {}): PayForResult => ({
  kind: "new", quote_id: "Q-1", invoice_id: null, invoice_issued: "INV-1", payment_id: "pay", receipt_voucher_no: null, amount: 0, tds_amount: 0,
  outstanding: 0, is_fully_paid: true, overpaid_credit: 0, renewal_rolled_forward: false, subscription_skipped: false, already_recorded: false,
  subscriptions: [], ...over,
});

function deps(over: Partial<BookDeps> = {}): BookDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isReconciled: vi.fn(async (id: string) => { calls.push(`check ${id}`); return false; }),
    createCustomer: vi.fn(async (p) => { calls.push(`customer ${p.name} ${p.contact_email ?? "-"}`); return "c-new"; }),
    setPayer: vi.fn(async (a) => { calls.push(`payer ${a.transactionId} ${a.relation}`); }),
    newSale: vi.fn(async (i) => { calls.push(`sale ${i.transactionId} ${i.customerId} sub=${i.createSubscription} ${i.subStart}->${i.subRenewal}`); return result(); }),
    saleSubscriptions: vi.fn(async () => []),
    setSubDates: vi.fn(async (id, s, r) => { calls.push(`dates ${id} ${s}->${r}`); }),
    ...over,
  };
}

describe("R-2402 Book selected", () => {
  it("books ticked rows one at a time; a line reconciled meanwhile is skipped, never booked twice", async () => {
    const a = row("t-a", m("Zuna Private Limited", [zl({})]));
    const b = row("t-b", m("Zuna Private Limited", [zl({})]));
    const d = deps({ isReconciled: vi.fn(async (id: string) => id === "t-b") });
    const run = await bookRows([a, b], new Set(["t-a", "t-b"]), new Set(), d);
    expect(run.error).toBeNull();
    expect(run.done.map((r) => [r.txnId, r.outcome])).toEqual([["t-a", "booked"], ["t-b", "skipped"]]);
    expect(d.newSale).toHaveBeenCalledTimes(1);
  });

  it("re-run: lines booked in an earlier run are not sent again", async () => {
    const a = row("t-a", m("Zuna Private Limited", [zl({})]));
    const d = deps();
    const run = await bookRows([a], new Set(["t-a"]), new Set(["t-a"]), d);
    expect(run.done).toEqual([]);
    expect(d.newSale).not.toHaveBeenCalled();
  });

  it("stops on the first error and reports it; later rows are not booked", async () => {
    const a = row("t-a", m("Zuna Private Limited", [zl({})]));
    const b = row("t-b", m("Zuna Private Limited", [zl({})]));
    const d = deps({ newSale: vi.fn(async () => { throw new Error("Zuna Private Limited has no state on record"); }) });
    const run = await bookRows([a, b], new Set(["t-a", "t-b"]), new Set(), d);
    expect(run.error).toMatchObject({ txnId: "t-a", reason: "Zuna Private Limited has no state on record" });
    expect(d.newSale).toHaveBeenCalledTimes(1);
  });

  it("a new Zoho customer on two lines is created once, with Zoho's email", async () => {
    const contact = { zohoId: "z-Sangat", name: "SANGAT PRINTERS", gstin: "06AAACS1688R2ZO", stateCode: "06", country: "India", email: "a@sangat.example", phone: null, personName: null, gstTreatment: "business_gst", customerType: "business" as const };
    const a = row("t-a", m("SANGAT PRINTERS", [zl({ domain: "sangat.in" })], "06AAACS1688R2ZO"), "NEFT CR-X-SANGAT PRINTERS-UTR1", contact);
    const b = row("t-b", m("SANGAT PRINTERS", [zl({ domain: "sangat.in" })], "06AAACS1688R2ZO"), "NEFT CR-X-SANGAT PRINTERS-UTR2", contact);
    const d = deps();
    await bookRows([a, b], new Set(["t-a", "t-b"]), new Set(), d);
    expect(d.calls.filter((c) => c.startsWith("customer"))).toEqual(["customer SANGAT PRINTERS a@sangat.example"]);
    expect(d.calls.filter((c) => c.startsWith("sale")).every((c) => c.includes(" c-new "))).toBe(true);
    expect(newCustomerPayload(a.customer as never)).toMatchObject({ state_code: "06", state: "Haryana", gst_treatment: "registered_regular", pan: "AAACS1688R", contact_name: "SANGAT PRINTERS" });
  });

  it("payer differs, matched by UTR → recorded as on the customer's behalf BEFORE the sale", async () => {
    const r = row("t-a", m("Zuna Private Limited", [zl({})]), "UPI-NAVAS K-navas@oksbi-SBIN0000001-630466843630-PAY");
    const d = deps();
    await bookRows([r], new Set(["t-a"]), new Set(), d);
    expect(d.calls.slice(1, 3)).toEqual(["payer t-a third_party", "sale t-a c-zuna sub=true 2026-10-29->2027-10-29"]);
  });

  it("each extra new subscription gets its own renewal from its Zoho line", async () => {
    const r = row("t-a", m("Zuna Private Limited", [
      zl({ qty: 9, domain: "zuna.store", start: "2026-09-18", end: "2027-09-17" }),
      zl({ qty: 1, domain: "dharasa.com", start: "2026-10-20", end: "2027-10-19" }),
    ]));
    const d = deps({ saleSubscriptions: vi.fn(async () => [
      { id: "s1", plan: "Workspace", seats: 9, domain: "zuna.store", start_date: "2026-09-18", renewal_date: "2027-09-18" },
      { id: "s2", plan: "Workspace", seats: 1, domain: "dharasa.com", start_date: "2026-09-18", renewal_date: "2027-09-18" },
    ]) });
    const run = await bookRows([r], new Set(["t-a"]), new Set(), d);
    expect(d.calls).toContain("sale t-a c-zuna sub=true 2026-09-18->2027-09-18");
    expect(d.calls).toContain("dates s2 2026-10-20->2027-10-20");
    expect(run.done[0].todo.filter((t) => t.startsWith("Renewal"))).toEqual([]);
  });

  it("matchDateFixes: domain + seats, the product breaks a tie; none → null", () => {
    const fixes = [{ name: "B", qty: 1, domain: "x.com", start: "2026-01-01", renewal: "2027-01-01" }];
    expect(matchDateFixes([
      { id: "a", plan: "A", seats: 1, domain: "x.com", start_date: null, renewal_date: null },
      { id: "b", plan: "B", seats: 1, domain: "x.com", start_date: null, renewal_date: null },
    ], fixes)[0].subId).toBe("b");
    expect(matchDateFixes([], fixes)[0].subId).toBeNull();
  });
});
