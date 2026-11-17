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
  refreshes: [] as string[],
  targets: new Map<string, { type: "vendor_bill" | "expense" }>(),
  /* R-2704: saved paid-from choices (zoho_account_bank_map) and the maps the plans were built with. */
  saved: {} as Record<string, string>,
  savedUse: [] as string[],
  mapsSeen: [] as Array<Record<string, string>>,
  /* R-2661: the one-reader lease calls, who holds it (null = free), and what one read step answers. */
  readerRpcs: [] as Array<[string, Record<string, unknown>]>,
  readerHolder: null as string | null,
  scanSteps: 0,
  scanResult: { listed: 3, detailed: 3, listDone: true, complete: true, busy: false, calls: 2 } as Record<string, unknown>,
  /* R-2681: this company's stored Zoho account types, when they were read, the chart-of-accounts reads and saves. */
  types: {} as Record<string, string>,
  typesAt: null as string | null,
  coaReads: 0,
  coaError: null as Error | null,
  typesSaved: [] as Array<Array<{ id: string; type: string }>>,
  /* R-2915: Zoho calls one chart read makes, the by-id account reads asked for, what Zoho answers (absent = no such account) or throws. */
  coaCalls: 1,
  oneReads: [] as string[],
  one: {} as Record<string, string>,
  oneError: {} as Record<string, Error>,
}));

vi.mock("@/lib/integrations/zoho-books/fy-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/zoho-books/fy-fetch")>()),
  readChartOfAccounts: async (_o: string, _t: string, _f?: unknown, onCall?: () => void) => {
    st.coaReads += 1;
    for (let i = 0; i < st.coaCalls; i++) onCall?.();
    if (st.coaError) throw st.coaError;
    return [{ id: "A1", name: "Software", code: "", type: "expense", active: true }, { id: "A-FD", name: "Fixed Deposit", code: "", type: "other_current_asset", active: true }];
  },
  readChartAccount: async (_o: string, _t: string, id: string) => {
    st.oneReads.push(id);
    if (st.oneError[id]) throw st.oneError[id];
    return st.one[id] ? { id, name: `Zoho ${id}`, code: "", type: st.one[id], active: false } : null;
  },
}));

vi.mock("@/lib/integrations/zoho-books/fy-import/scan", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/zoho-books/fy-import/scan")>()),
  scanStep: async () => { st.scanSteps += 1; return st.scanResult; },
}));

vi.mock("@/lib/integrations/zoho-books/fy-import/account-choices", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/zoho-books/fy-import/account-choices")>()),
  readAccountChoices: async (_db: unknown, _t: string, use: string) => { st.savedUse.push(use); return st.saved; },
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : { userId: "u1", tenantId: "t1", role: st.role, canManage: true, admin: {
    rpc: async (fn: string, args: Record<string, unknown>) => { st.readerRpcs.push([fn, args]); return { data: fn === "zoho_reader_take" ? st.readerHolder : true, error: null }; },
  } }),
  readConnection: async () => ({ refreshToken: "rt", orgId: "600", orgName: "Org", connectedAt: null }),
  zohoAccessToken: async () => "access",
  dropZohoAccessToken: async () => {},
}));
vi.mock("@/lib/integrations/zoho-books/fy-import/store", () => ({
  supabaseScanStore: (_db: unknown, _t: string, kind: string) => ({
    readRun: async () => st.runs[kind] ?? null,
    counts: async () => st.counts[kind] ?? { listed: 0, detailed: 0 },
    reset: async () => { st.resets.push(kind); },
    refresh: async () => { st.refreshes.push(kind); },
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
  readPurchaseContext: async (_db: unknown, _t: string, _r: unknown, accountMap: Record<string, string>) => (st.mapsSeen.push(accountMap), {
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null,
    vendors: [{ id: "v1", name: "Test Vendor", gstin: null, zohoContactId: "VZ1" }], categoryMap: { A1: "Software" }, imported: new Set<string>(),
    bankAccounts: ACCTS, accountMap, accountTypes: st.types,
  }),
  readPaymentContext: async (_db: unknown, _t: string, _r: unknown, accountMap: Record<string, string>, bills: Array<{ zohoId: string; total: number; tdsAmount: number; tdsSection: string | null }>) => ({
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null, targets: st.targets, importedPayments: new Set<string>(),
    bills: new Map(bills.map((b) => [b.zohoId, { total: b.total, tds: b.tdsAmount, tdsSection: b.tdsSection }])), bankAccounts: ACCTS, accountMap,
  }),
  readAppPurchasesByMonth: async () => [],
  readBankAccounts: async () => ACCTS,
  readOtherPurchasesByMonth: async () => [{ month: "2025-05", count: 3, amount: 4200 }],
  readCategoryMap: async () => ({ A1: "Software" }),
  readAccountTypes: async () => ({ types: st.types }),
  readAccountTypesNewest: async () => st.typesAt,
  saveAccountTypes: async (_admin: unknown, _t: string, accounts: Array<{ id: string; type: string }>) => { st.typesSaved.push(accounts.map((a) => ({ id: a.id, type: a.type }))); return accounts.length; },
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
  st.role = "owner"; st.rpc = []; st.resets = []; st.refreshes = [];
  st.runs = { bills: done, expenses: done, vendorpayments: done };
  st.counts = { bills: { listed: 2, detailed: 2 }, expenses: { listed: 0, detailed: 0 }, vendorpayments: { listed: 1, detailed: 1 } };
  st.facts = { bills: [bill(), bill({ zohoId: "B2", status: "void" })], expenses: [], vendorpayments: [pay()] };
  st.rpcResult = { data: { dry_run: true, imported: 1 }, error: null };
  st.targets = new Map();
  st.saved = {}; st.savedUse = []; st.mapsSeen = [];
  st.readerRpcs = []; st.readerHolder = null; st.scanSteps = 0;
  st.scanResult = { listed: 3, detailed: 3, listDone: true, complete: true, busy: false, calls: 2 };
  st.types = { A1: "expense" }; st.typesAt = new Date().toISOString(); st.coaReads = 0; st.coaError = null; st.typesSaved = [];
  st.coaCalls = 1; st.oneReads = []; st.one = {}; st.oneError = {};
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
    /* R-2653: Read again keeps the scan (only new / changed documents are read); fresh forgets it. */
    await POST(req({ action: "restart", fy: "2025-26", kind: "expenses" }));
    expect(st.refreshes).toEqual(["expenses"]);
    expect(st.resets).toEqual([]);
    await POST(req({ action: "restart", fy: "2025-26", kind: "expenses", fresh: true }));
    expect(st.resets).toEqual(["expenses"]);
  });
});

describe("R-2704 purchase-import route — the paid-from choice is remembered per company", () => {
  it("preview starts from the saved choices (the dialog's own map wins) and returns the map it used", async () => {
    st.saved = { "M/S. Main Bank Co": "b2502000-0000-0000-0000-0000000000e1", "Director - Rakesh": "none" };
    const body = await (await POST(req({ action: "preview", fy: "2025-26", accounts: { "Director - Rakesh": "b2502000-0000-0000-0000-0000000000e2" } }))).json();
    expect(st.savedUse).toEqual(["purchases"]);
    const used = { "M/S. Main Bank Co": "b2502000-0000-0000-0000-0000000000e1", "Director - Rakesh": "b2502000-0000-0000-0000-0000000000e2" };
    expect(st.mapsSeen[0]).toEqual(used);
    expect(body.accountChoices).toEqual(used);
  });

  it("import maps only what the dialog sent — no saved map behind the screen (as R-2501)", async () => {
    st.saved = { "M/S. Main Bank Co": "b2502000-0000-0000-0000-0000000000e1" };
    await POST(req({ action: "import", fy: "2025-26", kind: "bills", part: 0, accounts: { "Director - Rakesh": "b2502000-0000-0000-0000-0000000000e2" } }));
    expect(st.savedUse).toEqual([]);
    expect(st.mapsSeen[0]).toEqual({ "Director - Rakesh": "b2502000-0000-0000-0000-0000000000e2" });
  });

  it("saveAccount remembers one choice (key = Zoho paid-through name) through save_zoho_account_bank_choice", async () => {
    expect((await POST(req({ action: "saveAccount", fy: "2025-26", zohoKey: "M/S. Main Bank Co", choice: "b2502000-0000-0000-0000-0000000000e1" }))).status).toBe(200);
    expect(st.rpc[0]).toEqual({ fn: "save_zoho_account_bank_choice", args: { p_use: "purchases", p_key: "M/S. Main Bank Co", p_choice: "b2502000-0000-0000-0000-0000000000e1" } });
    expect((await POST(req({ action: "saveAccount", fy: "2025-26", zohoKey: "x", choice: "HDFC" }))).status).toBe(400);
    st.rpcResult = { data: null, error: { message: "That account is not one of this company's open accounts." } };
    const res = await POST(req({ action: "saveAccount", fy: "2025-26", zohoKey: "x", choice: "none" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/open accounts/);
  });
});

describe("R-2661 purchase-import route — one Zoho reader at a time", () => {
  const readerCalls = () => st.readerRpcs.map(([fn]) => fn);
  const env = () => { vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "id"); vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "secret"); };

  it("read while another read holds the company's lease: refused 409 with its name; no read step runs", async () => {
    env();
    st.readerHolder = "FY 2025-26 receipts from Zoho";
    try {
      const res = await POST(req({ action: "read", fy: "2025-26", kind: "bills" }));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toContain("Another Zoho read is running for this company: FY 2025-26 receipts from Zoho.");
      expect(st.scanSteps).toBe(0);
      expect(readerCalls()).toEqual(["zoho_reader_take"]);
      expect(st.readerRpcs[0][1]).toMatchObject({ p_tenant: "t1", p_name: "FY 2025-26 purchases from Zoho" });
    } finally { vi.unstubAllEnvs(); }
  });

  it("bills / expenses / vendor payments are ONE read: the lease stays when bills or expenses are complete and is let go when vendor payments (the last) are; a part-read kind keeps it", async () => {
    env();
    try {
      for (const kind of ["bills", "expenses"]) {
        st.readerRpcs = [];
        const res = await POST(req({ action: "read", fy: "2025-26", kind }));
        expect((await res.json())).toMatchObject({ ok: true, kind, complete: true });
        expect(readerCalls()).toEqual(["zoho_reader_take"]);
      }
      st.readerRpcs = [];
      st.scanResult = { listed: 9, detailed: 4, listDone: true, complete: false, busy: false, calls: 5 };
      await POST(req({ action: "read", fy: "2025-26", kind: "vendorpayments" }));
      expect(readerCalls()).toEqual(["zoho_reader_take"]);
      st.readerRpcs = [];
      st.scanResult = { listed: 9, detailed: 9, listDone: true, complete: true, busy: false, calls: 5 };
      await POST(req({ action: "read", fy: "2025-26", kind: "vendorpayments" }));
      expect(readerCalls()).toEqual(["zoho_reader_take", "zoho_reader_release"]);
      expect(st.readerRpcs[1][1]).toEqual({ p_tenant: "t1", p_name: "FY 2025-26 purchases from Zoho" });
    } finally { vi.unstubAllEnvs(); }
  });
});

describe("R-2681 purchase-import route — Zoho's own account type", () => {
  const env = () => { vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "id"); vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "secret"); };

  it("preview: a bill on a mapped fixed-deposit account is 'Not an expense — needs another path'; types not read → left out; unmapped list carries the type", async () => {
    st.types = { A1: "other_current_asset" };
    let body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(body.purchases.counts.import).toBe(0);
    expect(body.purchases.skipped).toContainEqual(expect.objectContaining({ number: "VB-1",
      reason: 'Not an expense — needs another path: in Zoho, "Software" is an account of type "other current asset". Fixed deposits, loans, GST, assets and advances are never booked as an expense.' }));
    st.types = {};
    body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(body.purchases.skipped).toContainEqual(expect.objectContaining({ number: "VB-1", reason: expect.stringMatching(/^Zoho account types are not read yet/) }));
    st.types = { A1: "expense", A7: "other_current_liability" };
    st.facts.bills = [bill({ lines: [{ accountId: "A7", accountName: "Output CGST", description: "", hsn: "", qty: 1, taxable: 1000, tax: 0, itcEligible: true }] })];
    body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(body.purchases.unmapped).toEqual([expect.objectContaining({ accountId: "A7", type: "other_current_liability", notExpense: true })]);
    expect(st.rpc).toEqual([]);
  });

  it("saveMap refuses an expense category for an account Zoho types as not an expense; clearing it is allowed", async () => {
    st.types = { A1: "expense", "A-FD": "other_current_asset" };
    const res = await POST(req({ action: "saveMap", fy: "2025-26", rows: [{ zohoAccountId: "A-FD", zohoAccountName: "Fixed Deposit", category: "Rates & Taxes" }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('In Zoho, "Fixed Deposit" is an account of type "other current asset" — not an expense, it cannot get an expense category.');
    expect(st.rpc).toEqual([]);
    expect((await POST(req({ action: "saveMap", fy: "2025-26", rows: [{ zohoAccountId: "A-FD", category: "" }] }))).status).toBe(200);
    expect(st.rpc[0].fn).toBe("save_zoho_account_categories");
  });

  it("read: the chart of accounts is read and stored when no types are stored or they are over 12 h old — not on every press", async () => {
    env();
    try {
      st.typesAt = new Date().toISOString();
      await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(st.coaReads).toBe(0);
      st.typesAt = null;
      await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(st.coaReads).toBe(1);
      expect(st.typesSaved[0]).toEqual([{ id: "A1", type: "expense" }, { id: "A-FD", type: "other_current_asset" }]);
      st.typesAt = new Date(Date.now() - 13 * 3600_000).toISOString();
      await POST(req({ action: "read", fy: "2025-26", kind: "bills" }));
      expect(st.coaReads).toBe(2);
      expect(st.scanSteps).toBe(3);
    } finally { vi.unstubAllEnvs(); }
  });

  it("read: a chart-of-accounts failure with OLDER types stored keeps them and the read goes on; with NONE stored the owner sees the error", async () => {
    env();
    try {
      const { ZohoApiError } = await import("@/lib/integrations/zoho-books/api");
      st.coaError = new ZohoApiError("Zoho Books returned an error. Try again; if it repeats, disconnect and connect again.", "books_500", 500);
      st.typesAt = new Date(Date.now() - 13 * 3600_000).toISOString();
      const res = await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(res.status).toBe(200);
      expect(st.typesSaved).toEqual([]);
      expect(st.scanSteps).toBe(1);
      st.typesAt = null;
      const res2 = await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(res2.status).toBe(502);
      expect((await res2.json()).error).toMatch(/Zoho Books returned an error/);
      expect(st.scanSteps).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it("read: 'Read from Zoho again' (a new list read started after the types were read) reads them again within the 12 h", async () => {
    env();
    try {
      st.typesAt = new Date(Date.now() - 3600_000).toISOString();
      st.runs.expenses = { nextPage: 1, listDone: false, listStartedAt: new Date().toISOString() } as never;
      await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(st.coaReads).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });
});

/**
 * R-2915 — staging (Excel, 17 Nov): after two "Read from Zoho again" ~170 documents still said
 * `account type … is not read yet`. An account a scanned line uses that the chart lists did not bring
 * is read from Zoho by its id; one Zoho does not know stays out (fail closed); every call is counted.
 */
describe("R-2915 purchase-import route — an account the chart lists missed is read by its id", () => {
  const env = () => { vi.stubEnv("ZOHO_BOOKS_CLIENT_ID", "id"); vi.stubEnv("ZOHO_BOOKS_CLIENT_SECRET", "secret"); };
  const line = (accountId: string, accountName: string) => ({ accountId, accountName, description: "", hsn: "", qty: 1, taxable: 1000, tax: 0, itcEligible: true });
  const again = () => {
    st.typesAt = new Date(Date.now() - 3600_000).toISOString();
    st.runs.expenses = { nextPage: 1, listDone: false, listStartedAt: new Date().toISOString() } as never;
    st.facts.bills = [bill(), bill({ zohoId: "B3", lines: [line("OLD-PANTRY", "Pantry"), line("A1", "Software")] })];
    st.facts.expenses = [bill({ kind: "expenses", zohoId: "E1", lines: [line("OLD-LOAN", "HDFC Enfield Bike Loan")] }), bill({ kind: "expenses", zohoId: "E2", lines: [line("GONE", "Deleted in Zoho")] })];
  };

  it("missing account is read by id and stored with Zoho's own type — after the chart, each id once", async () => {
    env();
    try {
      again();
      st.one = { "OLD-PANTRY": "expense", "OLD-LOAN": "long_term_liability" };
      const res = await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(res.status).toBe(200);
      expect(st.oneReads).toEqual(["GONE", "OLD-LOAN", "OLD-PANTRY"]);
      expect(st.typesSaved).toEqual([
        [{ id: "A1", type: "expense" }, { id: "A-FD", type: "other_current_asset" }],
        [{ id: "OLD-LOAN", type: "long_term_liability" }, { id: "OLD-PANTRY", type: "expense" }],
      ]);
      expect(st.scanSteps).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it("unknown account stays refused: Zoho knows none of them → nothing stored for them, the preview still says 'not read yet'", async () => {
    env();
    try {
      again();
      const res = await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(res.status).toBe(200);
      expect(st.oneReads).toEqual(["GONE", "OLD-LOAN", "OLD-PANTRY"]);
      expect(st.typesSaved).toHaveLength(1);
      st.runs.expenses = done; st.counts.expenses = { listed: 2, detailed: 2 };
      const body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
      expect(body.purchases.skipped).toContainEqual(expect.objectContaining({
        reason: `Zoho's account type for "Deleted in Zoho" is not read yet — press Read from Zoho again, then preview again.` }));
    } finally { vi.unstubAllEnvs(); }
  });

  it("calls are counted: every chart page and every by-id read is in the request's Zoho calls", async () => {
    env();
    try {
      again();
      st.coaCalls = 4;
      st.one = { "OLD-PANTRY": "expense" };
      const body = await (await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }))).json();
      expect(body.calls).toBe(4 + 3);
    } finally { vi.unstubAllEnvs(); }
  });

  it("at most 40 accounts are read by id in one read — the rest wait for the next Read from Zoho again", async () => {
    env();
    try {
      again();
      st.facts.expenses = Array.from({ length: 55 }, (_, i) => bill({ kind: "expenses", zohoId: `E${i}`, lines: [line(`M${String(i).padStart(2, "0")}`, `Missing ${i}`)] }));
      st.facts.bills = [];
      await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(st.oneReads).toHaveLength(40);
      expect(st.oneReads[0]).toBe("M00");
    } finally { vi.unstubAllEnvs(); }
  });

  it("day limit during by-id reads: what was found is saved, the chart stays saved, the dialog gets the day-limit notice", async () => {
    env();
    try {
      const { ZohoDayLimitError } = await import("@/lib/integrations/zoho-books/api");
      again();
      st.one = { GONE: "expense" };
      st.oneError = { "OLD-LOAN": new ZohoDayLimitError({ calls: 900, budget: 900, retryAt: "2026-11-18T18:30:00.000Z", day: "2026-11-18", limitHitAt: null } as never) };
      const res = await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.dayLimit).toBeTruthy();
      expect(st.oneReads).toEqual(["GONE", "OLD-LOAN"]);
      expect(st.typesSaved).toEqual([[{ id: "A1", type: "expense" }, { id: "A-FD", type: "other_current_asset" }], [{ id: "GONE", type: "expense" }]]);
      expect(st.scanSteps).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it("a Zoho failure on a by-id read (server error) only stops those reads — the list read goes on", async () => {
    env();
    try {
      const { ZohoApiError } = await import("@/lib/integrations/zoho-books/api");
      again();
      st.oneError = { GONE: new ZohoApiError("Zoho Books returned an error.", "books_500", 500) };
      const res = await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(res.status).toBe(200);
      expect(st.oneReads).toEqual(["GONE"]);
      expect(st.scanSteps).toBe(1);
    } finally { vi.unstubAllEnvs(); }
  });

  it("types still fresh for this read → no chart read and no by-id read (no Zoho call on every request)", async () => {
    env();
    try {
      again();
      st.typesAt = new Date().toISOString();
      st.runs.expenses = { nextPage: 1, listDone: false, listStartedAt: new Date(Date.now() - 60_000).toISOString() } as never;
      await POST(req({ action: "read", fy: "2025-26", kind: "expenses" }));
      expect(st.coaReads).toBe(0);
      expect(st.oneReads).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });
});
