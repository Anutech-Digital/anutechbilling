/**
 * R-1974 (26 Oct 2026) — a paid online order must never end with no GST invoice and no word.
 *
 * Owner's path (localhost audit, Q-1111-27-0009): /buy/workspace, Standard × 2, Monthly (flex),
 * ₹3,068 simulated payment. The quote carries billing_cycle 'monthly', record_payment makes a
 * monthly subscription (term 1 month), and the invoice is that subscription's first instalment
 * (raise_subscription_billing) — quote_id NULL on the invoice by design (the
 * invoices_reject_full_term_when_split_billed trigger refuses a whole-term invoice for a
 * monthly subscription, and quote.invoice_id set would stop every later month:
 * instalmentSkip → term_already_invoiced).
 *
 * The gap: on the split/flex path, when nothing was raised and nothing failed, the function
 * returned "not_fully_paid" — no invoice, no note, no error — even with the money received.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const raise = vi.fn();
vi.mock("@/lib/billing/sync-instalments.server", () => ({
  raiseDueInstalmentsForQuote: (...a: unknown[]) => raise(...a),
}));
const captured: unknown[] = [];
vi.mock("@/lib/sentry", () => ({
  Sentry: { captureException: (e: unknown) => { captured.push(e); } },
}));

import { issueInvoiceForOnlinePayment } from "./online-invoice.server";

type Rows = Record<string, Record<string, unknown>[]>;

function fakeAdmin(rows: Rows) {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const rpcs: string[] = [];
  const from = (table: string) => {
    const result = { data: rows[table] ?? [], error: null };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "is", "neq", "order", "limit", "or"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null });
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    q.insert = async (row: Record<string, unknown>) => { inserts.push({ table, row }); return { error: null }; };
    q.update = () => q;
    return q;
  };
  const rpc = vi.fn(async (name: string) => { rpcs.push(name); return { data: null, error: { message: "should not be called", code: "XX000" } }; });
  return { client: { from: vi.fn(from), rpc } as never, inserts, rpcs };
}

const FLEX_QUOTE = {
  id: "Q-1111-27-0009", invoice_id: null, payment_status: "received",
  lead_id: "L1", customer_id: "C1", billing_cycle: "monthly",
};
const args = { quoteId: "Q-1111-27-0009", tenantId: "T1", logTag: "[t]" };

beforeEach(() => {
  raise.mockReset();
  captured.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("R-1974: monthly (flex) online order is invoiced, never silently not", () => {
  it("owner's path: the flex order's first month is invoiced as its instalment — generate_invoice is not called", async () => {
    raise.mockResolvedValue({ raised: [{ subscription_id: "S1", period_index: 1, invoice_id: "INV-1111-27-0006", gross: 3068 }], errors: [], splitBilled: true });
    const a = fakeAdmin({ quotes: [FLEX_QUOTE], customers: [{ state_code: "07" }] });
    const out = await issueInvoiceForOnlinePayment(a.client, args);
    expect(out).toEqual({ status: "issued", invoiceId: "INV-1111-27-0006" });
    expect(a.rpcs).not.toContain("generate_invoice");
    expect(a.inserts).toEqual([]);
  });

  it("a second delivery (webhook retry) finds the month's invoice already raised → 'exists', no note", async () => {
    raise.mockResolvedValue({ raised: [], errors: [], splitBilled: true });
    const a = fakeAdmin({
      quotes: [FLEX_QUOTE], customers: [{ state_code: "07" }],
      subscriptions: [{ id: "S1" }],
      subscription_billings: [{ invoice_id: "INV-1111-27-0006" }],
    });
    const out = await issueInvoiceForOnlinePayment(a.client, args);
    expect(out).toEqual({ status: "exists", invoiceId: "INV-1111-27-0006" });
    expect(a.inserts).toEqual([]);
    expect(captured).toEqual([]);
  });

  it("PAID but nothing raised and nothing failed → lead note + console.error + Sentry, status failed (was: silent not_fully_paid)", async () => {
    raise.mockResolvedValue({ raised: [], errors: [], splitBilled: true });
    const a = fakeAdmin({
      quotes: [FLEX_QUOTE], customers: [{ state_code: "07" }],
      subscriptions: [{ id: "S1" }], subscription_billings: [],
    });
    const out = await issueInvoiceForOnlinePayment(a.client, args);
    expect(out.status).toBe("failed");
    const notes = a.inserts.filter((i) => i.table === "lead_activities");
    expect(notes).toHaveLength(1);
    expect(notes[0].row).toMatchObject({ tenant_id: "T1", lead_id: "L1", kind: "note" });
    expect(String(notes[0].row.detail)).toMatch(/Paid online, but no GST invoice/);
    expect(console.error).toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(a.rpcs).not.toContain("generate_invoice");
  });

  it("a part-paid split quote with nothing due yet stays not_fully_paid only when no money was received", async () => {
    raise.mockResolvedValue({ raised: [], errors: [], splitBilled: true });
    const a = fakeAdmin({
      quotes: [{ ...FLEX_QUOTE, payment_status: "awaiting" }], customers: [{ state_code: "07" }],
      subscriptions: [{ id: "S1" }], subscription_billings: [],
    });
    const out = await issueInvoiceForOnlinePayment(a.client, args);
    expect(out).toEqual({ status: "not_fully_paid" });
    expect(a.inserts).toEqual([]);
    expect(captured).toEqual([]);
  });

  it("the instalment refusal branch (unchanged) now also reaches Sentry", async () => {
    raise.mockResolvedValue({ raised: [], errors: [{ subscription_id: "S1", message: "no state on record." }], splitBilled: true });
    const a = fakeAdmin({ quotes: [FLEX_QUOTE], customers: [{ state_code: "07" }] });
    const out = await issueInvoiceForOnlinePayment(a.client, args);
    expect(out).toEqual({ status: "failed", reason: "no state on record." });
    expect(a.inserts.filter((i) => i.table === "lead_activities")).toHaveLength(1);
    expect(captured).toHaveLength(1);
  });

  it("annual order (no billing_cycle) still goes the whole-invoice generate_invoice path, unchanged", async () => {
    const a = fakeAdmin({ quotes: [{ ...FLEX_QUOTE, billing_cycle: null }], customers: [{ state_code: "07" }] });
    (a.client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc.mockImplementation(async (name: string) => {
      a.rpcs.push(name);
      return { data: [{ invoice_id: "INV-A" }], error: null };
    });
    const out = await issueInvoiceForOnlinePayment(a.client, args);
    expect(out).toEqual({ status: "issued", invoiceId: "INV-A" });
    expect(a.rpcs).toEqual(["generate_invoice"]);
    expect(raise).not.toHaveBeenCalled();
  });

  it("generate_invoice returning no invoice is no longer silent: note + Sentry", async () => {
    const a = fakeAdmin({ quotes: [{ ...FLEX_QUOTE, billing_cycle: null }], customers: [{ state_code: "07" }] });
    (a.client as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc.mockImplementation(async () => ({ data: [], error: null }));
    const out = await issueInvoiceForOnlinePayment(a.client, args);
    expect(out.status).toBe("failed");
    expect(a.inserts.filter((i) => i.table === "lead_activities")).toHaveLength(1);
    expect(captured).toHaveLength(1);
  });
});
