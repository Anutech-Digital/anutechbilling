/**
 * R-1526 — the "Pending dues" statement: which bills, what total, and when a UPI QR is allowed.
 *
 *   • Same set + same total as /collections (buildCollectionRows) for the same rows.
 *   • >1000 invoices: the loader pages past PostgREST's 1000-row cap, and every row counts.
 *   • No QR without a UPI ID, for a non-INR bill, or when nothing is owed.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildPendingDuesStatement, pendingDuesAbout, pendingDuesEmailText, pendingDuesFileName,
  pendingDuesWhatsappText, statementQrNotice, statementUpiUri, STATEMENT_NOTICE,
  type DuesInvoiceRow, type DuesSubscriptionRow, type PendingDuesRaw,
} from "./pending-dues";
import { buildCollectionRows } from "@/lib/queries/collections";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const TODAY = "2026-10-17";
const CUST = "33333333-3333-4333-8333-333333333333";

const inv = (o: Partial<DuesInvoiceRow> & { id: string }): DuesInvoiceRow => ({
  amount: 1000, net_payable: 1000, paid_amount: 0, status: "pending",
  invoice_date: "2026-09-01", due_date: "2026-09-15", quote_id: null, currency: "INR", ...o,
});
const sub = (o: Partial<DuesSubscriptionRow> & { id: string }): DuesSubscriptionRow => ({
  plan: "Workspace", domain: "acme.in", quote_id: null, outstanding_amount: 0,
  payment_due_date: "2026-10-01", created_at: "2026-09-20T10:00:00Z", ...o,
});

function raw(over: Partial<PendingDuesRaw> = {}): PendingDuesRaw {
  return {
    customer: { id: CUST, name: "Acme Ltd", display_name: "Acme", gstin: null, address: null, city: null, state: null },
    tenant: null,
    invoices: [
      inv({ id: "INV-1", amount: 11800, net_payable: 11800, paid_amount: 1800, due_date: "2026-09-10" }),   // ₹10,000 left
      inv({ id: "INV-2", amount: 5900, net_payable: 5900, status: "overdue", due_date: "2026-08-01" }),      // ₹5,900
      inv({ id: "INV-3", amount: 2000, net_payable: 2000, paid_amount: 2000 }),                               // settled
      inv({ id: "INV-4", status: "paid" }),                                                                     // not open
      inv({ id: "INV-5", status: "draft" }),                                                                    // not issued
      inv({ id: "INV-6", amount: 3000, net_payable: 3000, quote_id: "Q-6", due_date: "2026-11-01" }),          // not yet due
    ],
    subscriptions: [
      sub({ id: "S-1", outstanding_amount: 1500, quote_id: "Q-9" }),     // counts
      sub({ id: "S-2", outstanding_amount: 4000, quote_id: "Q-6" }),     // its quote is invoiced → the invoice is the claim
    ],
    invoicedQuoteIds: new Set(["Q-6"]),
    ...over,
  };
}

describe("buildPendingDuesStatement — same rules as /collections", () => {
  it("lists only open bills, oldest due first, and totals them", () => {
    const st = buildPendingDuesStatement(raw(), TODAY);
    expect(st.lines.map((l) => l.id)).toEqual(["INV-2", "INV-1", "S-1", "INV-6"]);
    expect(st.lines.map((l) => l.amountDue)).toEqual([5900, 10000, 1500, 3000]);
    expect(st.total).toBe(20400);
    expect(st.customerName).toBe("Acme");
    const late = st.lines.find((l) => l.id === "INV-2")!;
    expect(late.daysOverdue).toBe(77);
    expect(late.date).toBe("2026-09-01");
    expect(st.lines.find((l) => l.id === "INV-6")!.daysOverdue).toBeLessThan(0);
  });

  it("total and bills equal the /collections row for the same data", () => {
    const r = raw();
    const st = buildPendingDuesStatement(r, TODAY);
    const rows = buildCollectionRows({
      invoices: r.invoices.map((i) => ({ ...i, customer_id: CUST, customer_name: "Acme", taxable_value: null, tax_amount: null, tax_rate: null })),
      subscriptions: r.subscriptions.map((s) => ({ ...s, customer_id: CUST, customer_name: "Acme" })),
      quoteSubscriptions: [],
      invoicedQuoteIds: r.invoicedQuoteIds,
      customers: [{ id: CUST, name: "Acme Ltd", display_name: "Acme", account_manager_id: null }],
      followups: [],
    }, TODAY);
    expect(rows).toHaveLength(1);
    expect(st.total).toBe(rows[0].amountDue);
    expect(new Set(st.lines.map((l) => l.id))).toEqual(new Set(rows[0].items.map((i) => i.id)));
  });

  it("1500 open invoices → 1500 lines, every rupee counted", () => {
    const many = Array.from({ length: 1500 }, (_, n) => inv({ id: `INV-${String(n).padStart(4, "0")}`, amount: 100, net_payable: 100 }));
    const st = buildPendingDuesStatement(raw({ invoices: many, subscriptions: [] }), TODAY);
    expect(st.lines).toHaveLength(1500);
    expect(st.total).toBe(150000);
  });

  it("the follow-up is about the oldest bill", () => {
    expect(pendingDuesAbout(buildPendingDuesStatement(raw(), TODAY))).toEqual({ invoiceId: "INV-2", subscriptionId: null, quoteId: null });
  });
});

describe("pay QR — only INR, only with a UPI ID, only when something is owed", () => {
  const st = buildPendingDuesStatement(raw(), TODAY);

  it("UPI ID + all INR → one QR for the whole total", () => {
    expect(statementQrNotice({ upiVpa: "acme@okhdfcbank", allInr: true, total: st.total })).toBeNull();
    const uri = statementUpiUri({ vpa: "acme@okhdfcbank", payeeName: "Demo Co", customerName: st.customerName, total: st.total, allInr: true });
    expect(uri).toMatch(/^upi:\/\/pay\?/);
    expect(uri).toContain("am=20400.00");
    expect(uri).toContain("cu=INR");
  });

  it("no UPI ID → no QR, and the §24 'add UPI ID in Settings' note with a Settings link", () => {
    const n = statementQrNotice({ upiVpa: null, allInr: true, total: st.total });
    expect(n?.reason).toBe("no-upi");
    expect(n?.text).toMatch(/Settings me UPI ID daalo/);
    expect(n?.action?.href).toMatch(/^\/settings/);
    expect(statementUpiUri({ vpa: "  ", payeeName: "Demo", customerName: "Acme", total: st.total, allInr: true })).toBeNull();
  });

  it("a non-INR invoice → no QR (UPI settles only in rupees)", () => {
    const usd = buildPendingDuesStatement(raw({ invoices: [inv({ id: "INV-USD", currency: "USD" })], subscriptions: [] }), TODAY);
    expect(usd.allInr).toBe(false);
    expect(statementQrNotice({ upiVpa: "acme@okhdfcbank", allInr: usd.allInr, total: usd.total })?.reason).toBe("non-inr");
    expect(statementUpiUri({ vpa: "acme@okhdfcbank", payeeName: "Demo", customerName: "Acme", total: usd.total, allInr: usd.allInr })).toBeNull();
  });

  it("nothing owed → no QR", () => {
    expect(statementUpiUri({ vpa: "acme@okhdfcbank", payeeName: "Demo", customerName: "Acme", total: 0, allInr: true })).toBeNull();
  });
});

describe("the words", () => {
  const st = buildPendingDuesStatement(raw(), TODAY);

  it("WhatsApp text: total, bills, and the PDF link only when a signed one exists", () => {
    const withLink = pendingDuesWhatsappText(st, { greetName: "Rahul", sellerName: "Demo Co", pdfUrl: "https://app.example/api/v1/documents/statement/x/pdf?token=t", upiLink: null });
    expect(withLink).toContain("Hi Rahul");
    expect(withLink).toContain("₹20,400");
    expect(withLink).toContain("Invoice INV-2");
    expect(withLink).toContain("token=t");
    const without = pendingDuesWhatsappText(st, { greetName: null, sellerName: "Demo Co", pdfUrl: null, upiLink: null });
    expect(without).not.toContain("Statement (PDF");
    expect(without).toContain("Hi Acme");
  });

  it("email first line names the total (it becomes the follow-up note)", () => {
    const text = pendingDuesEmailText(st, { greetName: "Rahul", sellerName: "Demo Co" });
    expect(text.split("\n")[0]).toContain("₹20,400");
    expect(text.split("\n")[0]).toContain("4 bills");
  });

  it("file name is safe; the notice says it is not a tax invoice", () => {
    expect(pendingDuesFileName("Acme & Sons / Pvt", "2026-10-17")).toBe("Pending-dues-Acme-Sons-Pvt-2026-10-17.pdf");
    expect(STATEMENT_NOTICE).toMatch(/not a tax invoice/);
  });
});

describe("loadPendingDuesRaw — pages past 1000, every read pinned to the tenant", () => {
  it("reads 2,345 invoices in three pages and filters every table by tenant_id", async () => {
    const { loadPendingDuesRaw } = await import("./pending-dues.server");
    const ALL = Array.from({ length: 2345 }, (_, n) => inv({ id: `INV-${String(n).padStart(5, "0")}`, amount: 10, net_payable: 10 }));
    const tenantFilters: string[] = [];
    const ranges: Array<[number, number]> = [];
    const db = {
      from(table: string) {
        let range: [number, number] | null = null;
        const q: Record<string, unknown> = {};
        for (const m of ["select", "in", "gt", "is", "order"]) q[m] = () => q;
        q.eq = (col: string, v: unknown) => { if (col === "tenant_id" || (table === "tenants" && col === "id")) tenantFilters.push(`${table}:${String(v)}`); return q; };
        q.range = (a: number, b: number) => { range = [a, b]; if (table === "invoices") ranges.push([a, b]); return q; };
        q.maybeSingle = async () => table === "customers"
          ? { data: { id: CUST, name: "Acme Ltd", display_name: null, gstin: null, address: null, city: null, state: null }, error: null }
          : { data: { name: "Demo Co" }, error: null };
        q.then = (ok: (v: unknown) => unknown) => {
          const rows = table === "invoices" && range ? ALL.slice(range[0], range[1] + 1) : [];
          return Promise.resolve({ data: rows, error: null }).then(ok);
        };
        return q;
      },
    };
    const out = await loadPendingDuesRaw(db as never, { customerId: CUST, tenantId: "T1" });
    expect(out?.invoices).toHaveLength(2345);
    expect(ranges.length).toBeGreaterThanOrEqual(3);
    expect(buildPendingDuesStatement(out!, TODAY).total).toBe(23450);
    for (const t of ["customers", "invoices", "subscriptions", "tenants"]) expect(tenantFilters).toContain(`${t}:T1`);
  });

  it("a customer of another company → null (nothing read)", async () => {
    const { loadPendingDuesRaw } = await import("./pending-dues.server");
    const db = {
      from() {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: null, error: null });
        return q;
      },
    };
    expect(await loadPendingDuesRaw(db as never, { customerId: CUST, tenantId: "T2" })).toBeNull();
  });
});
