/**
 * R-2502 — POST /api/integrations/zoho-books/purchase-import. Owner / accountant only; preview and
 * import only from a COMPLETE server scan (counted on the server, never from the browser); the import
 * sends Zoho ids + matched vendor (+ the picked bank account for payments) and NO money; dry run by
 * default; the account map is saved through the RPC. Supabase and the scan store are mocked; Zoho is
 * never called here. Values are made up.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { PurchaseFacts, VendorPaymentFacts } from "@/lib/integrations/zoho-books/purchase-import/normalise";

const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  runs: {} as Record<string, { nextPage: number; listDone: boolean } | null>,
  counts: {} as Record<string, { listed: number; detailed: number }>,
  facts: {} as Record<string, unknown[]>,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: { dry_run: true, imported: 1 } as unknown, error: null as null | { message: string } },
  resets: [] as string[],
  targets: new Map<string, { type: "vendor_bill" | "expense" }>(),
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : { userId: "u1", tenantId: "t1", role: st.role, canManage: true, admin: {} }),
  readConnection: async () => ({ refreshToken: "rt", orgId: "600", orgName: "Org", connectedAt: null }),
  zohoAccessToken: async () => "access",
  dropZohoAccessToken: async () => {},
}));
vi.mock("@/lib/integrations/zoho-books/fy-import/store", () => ({
  supabaseScanStore: (_db: unknown, _t: string, kind: string) => ({
    readRun: async () => st.runs[kind] ?? null,
    counts: async () => st.counts[kind] ?? { listed: 0, detailed: 0 },
    reset: async () => { st.resets.push(kind); },
  }),
  readScannedFacts: async (_db: unknown, _t: string, kind: string) => st.facts[kind] ?? [],
  readImportBatches: async () => [],
}));
const ACCTS = vi.hoisted(() => [
  { id: "b2502000-0000-0000-0000-0000000000e1", name: "HDFC Current", bank_name: "HDFC", account_number_last4: "4523", account_type: "current", is_active: true, is_default_petty_cash: false },
  { id: "b2502000-0000-0000-0000-0000000000e2", name: "Petty Cash", bank_name: "Cash", account_number_last4: null, account_type: "cash", is_active: true, is_default_petty_cash: true },
]);
vi.mock("@/lib/integrations/zoho-books/purchase-import/store", async (orig) => ({
  parseAccountMap: ((await orig()) as { parseAccountMap: unknown }).parseAccountMap,
  readPurchaseContext: async (_db: unknown, _t: string, _r: unknown, accountMap: Record<string, string>) => ({
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    vendors: [{ id: "v1", name: "Test Vendor", gstin: null, zohoContactId: "VZ1" }], categoryMap: { A1: "Software" }, imported: new Set<string>(),
    bankAccounts: ACCTS, accountMap,
  }),
  readPaymentContext: async (_db: unknown, _t: string, _r: unknown, accountMap: Record<string, string>, bills: Array<{ zohoId: string; total: number; tdsAmount: number; tdsSection: string | null }>) => ({
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null, targets: st.targets, importedPayments: new Set<string>(),
    bills: new Map(bills.map((b) => [b.zohoId, { total: b.total, tds: b.tdsAmount, tdsSection: b.tdsSection }])), bankAccounts: ACCTS, accountMap,
  }),
  readAppPurchasesByMonth: async () => [],
  readBankAccounts: async () => ACCTS,
  readOtherPurchasesByMonth: async () => [{ month: "2025-05", count: 3, amount: 4200 }],
  readCategoryMap: async () => ({ A1: "Software" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { st.rpc.push({ fn, args }); return st.rpcResult; } }),
}));

import { POST } from "./route";

const bill = (over: Partial<PurchaseFacts> = {}): PurchaseFacts => ({
  kind: "bills", zohoId: "B1", number: "VB-1", date: "2025-05-10", dueDate: null, status: "open", vendorZohoId: "VZ1", vendorName: "Test Vendor",
  gstin: "", gstTreatment: "", currency: "INR", taxable: 1000, igst: 180, cgst: 0, sgst: 0, tax: 180, total: 1180, rcm: false, rcmTax: 0,
  tdsAmount: 0, tdsSection: null, lines: [{ accountId: "A1", accountName: "Software", description: "", hsn: "", qty: 1, taxable: 1000, tax: 180, itcEligible: true }],
  paidThrough: "", problems: [], ...over,
});
const pay = (over: Partial<VendorPaymentFacts> = {}): VendorPaymentFacts => ({
  kind: "vendorpayments", zohoId: "P1", number: "1", date: "2025-06-01", status: "", vendorZohoId: "VZ1", vendorName: "Test Vendor", currency: "INR",
  amount: 1180, unapplied: 0, paidThrough: "HDFC 4523", mode: "NEFT", reference: "", applied: [{ billZohoId: "B1", billNumber: "VB-1", amount: 1180 }], problems: [], ...over,
});

function req(body: unknown) {
  return new NextRequest("http://localhost:3001/api/integrations/zoho-books/purchase-import", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
}
const done = { nextPage: 2, listDone: true };

beforeEach(() => {
  st.role = "owner"; st.rpc = []; st.resets = [];
  st.runs = { bills: done, expenses: done, vendorpayments: done };
  st.counts = { bills: { listed: 2, detailed: 2 }, expenses: { listed: 0, detailed: 0 }, vendorpayments: { listed: 1, detailed: 1 } };
  st.facts = { bills: [bill(), bill({ zohoId: "B2", status: "void" })], expenses: [], vendorpayments: [pay()] };
  st.rpcResult = { data: { dry_run: true, imported: 1 }, error: null };
  st.targets = new Map();
});

describe("R-2502 purchase-import route", () => {
  it("only owner / accountant; not signed in → 401; bad FY → 400", async () => {
    st.role = "manager";
    expect((await POST(req({ action: "preview", fy: "2025-26" }))).status).toBe(403);
    st.role = null;
    expect((await POST(req({ action: "preview", fy: "2025-26" }))).status).toBe(401);
    st.role = "accountant";
    expect((await POST(req({ action: "preview", fy: "2025" }))).status).toBe(400);
  });

  it("preview needs bills and expenses read completely (server counts, not the browser's)", async () => {
    st.counts.bills = { listed: 2, detailed: 1 };
    const res = await POST(req({ action: "preview", fy: "2025-26", counts: { listed: 2, detailed: 2 } }));
    expect(res.status).toBe(409);
  });

  it("preview: void left out; months, unmapped accounts, categories and bank accounts", async () => {
    const body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(body.ok).toBe(true);
    expect(body.purchases.counts).toMatchObject({ scanned: 2, import: 1, skip: 1, voidOrDraft: 1 });
    expect(body.purchases.skipped[0]).toMatchObject({ number: "VB-1", reason: expect.stringMatching(/Void/) });
    expect(body.purchases.zohoByMonth[0]).toMatchObject({ month: "2025-05", count: 1, taxable: 1000, igst: 180 });
    expect(body.categories).toContain("Software");
    expect(body.payments.counts.skip).toBe(1);
    expect(st.rpc).toEqual([]);
  });

  it("import bills: dry run by default, Zoho id + vendor only — no money", async () => {
    const body = await (await POST(req({ action: "import", fy: "2025-26", kind: "bills", part: 0, amount: 999999 }))).json();
    expect(body).toMatchObject({ ok: true, part: 0, parts: 1 });
    expect(st.rpc[0]).toEqual({ fn: "import_zoho_fy_purchases", args: { p_kind: "bills", p_fy: "2025-26", p_dry_run: true, p_picks: [{ kind: "bills", zoho_id: "B1", vendor_id: "v1" }] } });
    expect(JSON.stringify(st.rpc[0].args)).not.toMatch(/1180|999999/);
  });

  it("import for real only when dryRun is false; a part out of range / unknown kind refused", async () => {
    await POST(req({ action: "import", fy: "2025-26", kind: "bills", part: 0, dryRun: false }));
    expect(st.rpc[0].args.p_dry_run).toBe(false);
    expect((await POST(req({ action: "import", fy: "2025-26", kind: "bills", part: 3 }))).status).toBe(400);
    expect((await POST(req({ action: "import", fy: "2025-26", kind: "invoices", part: 0 }))).status).toBe(400);
  });

  it("payments: Zoho id + the app account its paid-through account maps to (suggested by last 4 digits) — no money", async () => {
    st.targets = new Map([["B1", { type: "expense" as const }]]);
    await POST(req({ action: "import", fy: "2025-26", kind: "vendorpayments", part: 0 }));
    expect(st.rpc[0]).toEqual({ fn: "import_zoho_fy_vendor_payments", args: { p_fy: "2025-26", p_dry_run: true,
      p_picks: [{ zoho_id: "P1", account_id: "b2502000-0000-0000-0000-0000000000e1" }] } });
  });

  it("a Zoho expense goes with the account the owner chose for its paid-through account (R-2502c)", async () => {
    st.facts.expenses = [bill({ kind: "expenses", zohoId: "E1", number: "", paidThrough: "Director - Rakesh" })];
    st.counts.expenses = { listed: 1, detailed: 1 };
    expect((await POST(req({ action: "import", fy: "2025-26", kind: "expenses", part: 0 }))).status).toBe(409);
    await POST(req({ action: "import", fy: "2025-26", kind: "expenses", part: 0, accounts: { "Director - Rakesh": "b2502000-0000-0000-0000-0000000000e2" } }));
    expect(st.rpc[0].args.p_picks).toEqual([{ kind: "expenses", zoho_id: "E1", vendor_id: "v1", account_id: "b2502000-0000-0000-0000-0000000000e2" }]);
    const body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(body.purchases.accounts).toEqual([expect.objectContaining({ zohoName: "Director - Rakesh", appAccountId: null })]);
    expect(body.purchases.otherByMonth).toEqual([{ month: "2025-05", count: 3, amount: 4200 }]);
    expect(body.bankAccounts.map((a: { id: string }) => a.id)).toContain("b2502000-0000-0000-0000-0000000000e2");
  });

  it("payments only on COGS bills: nothing to import here — listed for Reconcile in the preview", async () => {
    st.targets = new Map([["B1", { type: "vendor_bill" as const }]]);
    expect((await POST(req({ action: "import", fy: "2025-26", kind: "vendorpayments", part: 0 }))).status).toBe(409);
    const body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(body.payments.toReconcile).toEqual([expect.objectContaining({ why: "cogs", bill: "VB-1", amount: 1180 })]);
    expect(st.rpc).toEqual([]);
  });

  it("saveMap goes through save_zoho_account_categories; a category not offered is refused", async () => {
    await POST(req({ action: "saveMap", fy: "2025-26", rows: [{ zohoAccountId: "A9", zohoAccountName: "Rent", category: "Office Rent" }] }));
    expect(st.rpc[0]).toEqual({ fn: "save_zoho_account_categories", args: { p_rows: [{ zoho_account_id: "A9", zoho_account_name: "Rent", category: "Office Rent" }] } });
    expect((await POST(req({ action: "saveMap", fy: "2025-26", rows: [{ zohoAccountId: "A9", category: "Salaries" }] }))).status).toBe(400);
  });

  it("the database's refusal comes back as the message; undo + restart", async () => {
    st.rpcResult = { data: null, error: { message: "Only the owner or an accountant can import FY purchases from Zoho. Ask one of them." } };
    const res = await POST(req({ action: "import", fy: "2025-26", kind: "bills", part: 0 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/owner or an accountant/);
    st.rpcResult = { data: { removed: 1 }, error: null };
    await POST(req({ action: "undo", fy: "2025-26", batchId: "b2502000-0000-0000-0000-0000000000b1", reason: "test" }));
    expect(st.rpc[1]).toEqual({ fn: "remove_zoho_fy_purchase_import", args: { p_batch_id: "b2502000-0000-0000-0000-0000000000b1", p_reason: "test" } });
    await POST(req({ action: "restart", fy: "2025-26", kind: "expenses" }));
    expect(st.resets).toEqual(["expenses"]);
  });
});
