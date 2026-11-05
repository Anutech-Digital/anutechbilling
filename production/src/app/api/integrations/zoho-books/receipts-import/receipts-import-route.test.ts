/**
 * R-2501 — POST /api/integrations/zoho-books/receipts-import. Owner / accountant only; preview and
 * import only from a COMPLETE server scan; the import sends Zoho payment ids + the app account to
 * import_zoho_fy_receipts and NO money (amounts come from the scan in SQL); dry run by default;
 * already-booked payments with no bank line yet are sent again (bank match later).
 * Supabase and the stores are mocked; Zoho is never called here. Values are made up.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ZohoReceiptFacts } from "@/lib/integrations/zoho-books/receipts-import/normalise";

const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  run: { nextPage: 3, listDone: true } as { nextPage: number; listDone: boolean } | null,
  counts: { listed: 2, detailed: 2 },
  facts: [] as unknown[],
  booked: new Map<string, { banked: boolean }>(),
  accountMapSeen: null as unknown,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: { dry_run: true, imported: 1 } as unknown, error: null as null | { message: string } },
  resets: 0,
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : { userId: "u1", tenantId: "t1", role: st.role, canManage: true, admin: {} }),
  readConnection: async () => ({ refreshToken: "rt", orgId: "600", orgName: "Org", connectedAt: null }),
  zohoAccessToken: async () => "access",
  dropZohoAccessToken: async () => {},
}));
vi.mock("@/lib/integrations/zoho-books/fy-import/store", () => ({
  supabaseScanStore: (_db: unknown, _t: string, kind: string) => {
    if (kind !== "customerpayments") throw new Error(`wrong kind ${kind}`);
    return { readRun: async () => st.run, counts: async () => st.counts, reset: async () => { st.resets += 1; } };
  },
  readScannedFacts: async () => st.facts,
  readImportBatches: async () => [],
}));
vi.mock("@/lib/integrations/zoho-books/receipts-import/store", async (orig) => ({
  parseAccountMap: (await orig<typeof import("@/lib/integrations/zoho-books/receipts-import/store")>()).parseAccountMap,
  readReceiptsContext: async (_db: unknown, _t: string, range: { dateStart: string; dateEnd: string }, accountMap: Record<string, string>) => {
    st.accountMapSeen = accountMap;
    return {
      fyStart: range.dateStart, fyEnd: range.dateEnd, booksStart: "2025-04-01", lockedUntil: null,
      invoices: [{ id: "INV/25-26/0001", zohoInvoiceId: "zi1", externalNumber: "INV/25-26/0001", documentKind: "tax_invoice", customerId: "c1", due: 5000 }],
      bankAccounts: [{ id: "11111111-1111-4111-8111-111111111111", name: "Current", bank_name: "HDFC", account_number_last4: "4523", account_type: "current", is_active: true }],
      booked: st.booked, accountMap,
    };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { st.rpc.push({ fn, args }); return st.rpcResult; } }),
}));

import { POST } from "./route";

const fact = (over: Partial<ZohoReceiptFacts>): ZohoReceiptFacts => ({
  zohoId: "p1", number: "101", date: "2025-06-10", status: "", zohoCustomerId: "zc", customerName: "Test Buyer", method: "bank_transfer",
  zohoMode: "Bank Transfer", reference: "UTR1", depositAccountId: "za", depositAccountName: "HDFC 4523", amount: 1180, receivedPaise: 118000,
  lines: [{ zohoInvoiceId: "zi1", invoiceNumber: "INV/25-26/0001", settle: 1180, tds: 0 }], excess: 0, tds: 0, problems: [], ...over,
});

function req(body: unknown) {
  return new NextRequest("http://localhost:3001/api/integrations/zoho-books/receipts-import", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  st.role = "owner"; st.run = { nextPage: 3, listDone: true }; st.counts = { listed: 2, detailed: 2 }; st.rpc = []; st.resets = 0;
  st.booked = new Map(); st.accountMapSeen = null;
  st.facts = [fact({}), fact({ zohoId: "p2", number: "102", problems: ["Zoho took bank charges off this payment — book it by hand."] })];
  st.rpcResult = { data: { dry_run: true, imported: 1 }, error: null };
});

describe("R-2501 receipts-import route", () => {
  it("a manager (or anyone not owner / accountant) is refused; not signed in → 401", async () => {
    st.role = "manager";
    expect((await POST(req({ action: "preview", fy: "2025-26" }))).status).toBe(403);
    st.role = null;
    expect((await POST(req({ action: "preview", fy: "2025-26" }))).status).toBe(401);
  });

  it("preview needs a complete scan (server-side counts, never the browser's)", async () => {
    st.counts = { listed: 2, detailed: 1 };
    expect((await POST(req({ action: "preview", fy: "2025-26", counts: { listed: 2, detailed: 2 } }))).status).toBe(409);
  });

  it("preview: counts, totals, the deposit account suggested, skip reasons; nothing sent to the database", async () => {
    const body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(body.counts).toMatchObject({ scanned: 2, import: 1, skip: 1 });
    expect(body.totals).toEqual({ cash: 1180, tds: 0, excess: 0 });
    expect(body.deposits[0]).toMatchObject({ zohoAccountId: "za", appAccountId: "11111111-1111-4111-8111-111111111111", suggested: true });
    expect(body.skipped[0].reason).toMatch(/bank charges/);
    expect(st.rpc).toEqual([]);
  });

  it("import: dry run by default, Zoho id + app account only — no amounts", async () => {
    const body = await (await POST(req({ action: "import", fy: "2025-26", part: 0, amount: 999999 }))).json();
    expect(body).toMatchObject({ ok: true, part: 0, parts: 1 });
    expect(st.rpc[0]).toEqual({ fn: "import_zoho_fy_receipts", args: { p_fy: "2025-26", p_dry_run: true,
      p_picks: [{ zoho_payment_id: "p1", bank_account_id: "11111111-1111-4111-8111-111111111111" }] } });
    expect(JSON.stringify(st.rpc[0].args)).not.toMatch(/1180|999999/);
  });

  it("booked payments are sent again (SQL: already + bank match later), so part N stays the same payments", async () => {
    st.facts = [fact({}), fact({ zohoId: "p2", number: "102" })];
    st.booked = new Map([["p1", { banked: true }], ["p2", { banked: false }]]);
    await POST(req({ action: "import", fy: "2025-26", part: 0, dryRun: false }));
    expect(st.rpc[0].args).toMatchObject({ p_dry_run: false, p_picks: [{ zoho_payment_id: "p1" }, { zoho_payment_id: "p2" }] });
  });

  it("preview offers Record payment's deposit accounts with its label", async () => {
    const body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(body.accounts).toEqual([{ id: "11111111-1111-4111-8111-111111111111", name: expect.stringContaining("Current") }]);
  });

  it("the account map is shape-checked (bad ids dropped); a part out of range is refused", async () => {
    await POST(req({ action: "preview", fy: "2025-26", accounts: { za: "not-a-uuid", zb: "22222222-2222-4222-8222-222222222222" } }));
    expect(st.accountMapSeen).toEqual({ zb: "22222222-2222-4222-8222-222222222222" });
    expect((await POST(req({ action: "import", fy: "2025-26", part: 5 }))).status).toBe(400);
  });

  it("undo calls remove_zoho_fy_receipts_import with the reason; a bad batch id is refused", async () => {
    await POST(req({ action: "undo", fy: "2025-26", batchId: "c2501000-0000-0000-0000-0000000000b1", reason: "wrong account" }));
    expect(st.rpc[0]).toEqual({ fn: "remove_zoho_fy_receipts_import", args: { p_batch_id: "c2501000-0000-0000-0000-0000000000b1", p_reason: "wrong account" } });
    expect((await POST(req({ action: "undo", fy: "2025-26", batchId: "x' or 1=1" }))).status).toBe(400);
  });

  it("the database's refusal comes back as the message; restart clears the scan", async () => {
    st.rpcResult = { data: null, error: { message: "Only the owner or an accountant can import FY receipts from Zoho. Ask one of them." } };
    const res = await POST(req({ action: "import", fy: "2025-26", part: 0 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/owner or an accountant/);
    await POST(req({ action: "restart", fy: "2025-26" }));
    expect(st.resets).toBe(1);
  });
});
