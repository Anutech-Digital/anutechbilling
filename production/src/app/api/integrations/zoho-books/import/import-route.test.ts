/**
 * R-1753 — /api/integrations/zoho-books/import: who may, which tenant, what reaches the
 * database. Zoho, the database and the session are faked; made-up T- data only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  caller: null as null | { userId: string; tenantId: string; role: string; canManage: boolean; admin: unknown },
  conn: { refreshToken: "rt", orgId: "60000001", orgName: "T-Org", connectedAt: null } as Record<string, unknown>,
  runs: { open: null as Record<string, unknown> | null, lastImport: null },
  started: [] as unknown[],
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcError: null as null | { message: string },
  tokenError: null as unknown,
  saved: [] as unknown[],
  dropped: 0,
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => h.caller,
  readConnection: async () => h.conn,
  zohoAccessToken: async () => { if (h.tokenError) throw h.tokenError; return "t-access"; },
  dropZohoAccessToken: async () => { h.dropped += 1; },
}));
vi.mock("@/lib/integrations/zoho-books/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/zoho-books/config")>()),
  zohoBooksCreds: () => ({ clientId: "id", clientSecret: "secret" }),
}));
vi.mock("@/lib/integrations/zoho-books/import-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/zoho-books/import-store")>()),
  readRuns: async () => h.runs,
  supabaseScanStore: () => ({ saveRun: async (p: unknown) => { h.saved.push(p); } }),
  startRun: async (...a: unknown[]) => { h.started.push(a); return { id: "run-new", phase: "contacts", since: a[4], months: a[5] }; },
  loadPlanInputs: async () => ({
    contacts: [{ zohoId: "c1", name: "T-Alpha Pvt Ltd", gstin: null, gstTreatment: "business_none", placeOfContact: "DL",
      paymentTermsDays: null, email: null, phone: null, personName: null, subType: "business" }],
    invoices: [{ zohoId: "i1", number: "INV-T-001", date: "2026-04-01", dueDate: "2026-04-15", zohoCustomerId: "c1", customerName: "T-Alpha Pvt Ltd",
      status: "paid", total: 10620, balance: 0, currency: "INR", gstin: null, placeOfSupply: null, subsPeriod: "Yearly", newBusiness: null, serviceExpiry: null,
      lines: [{ plan: "Google Workspace Business Starter", quantity: 5, itemTotal: 9000, rate: 1800,
        description: "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)" }] }],
    existingCustomers: [], existingSubscriptions: [], items: [], existingInvoiceNumbers: new Set(),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpc.push({ fn, args });
      return h.rpcError ? { data: null, error: h.rpcError } : { data: { batch_id: args.p_run_id ?? "x" }, error: null };
    },
  }),
}));

import { GET, POST } from "./route";
import { ZohoApiError, ZOHO_BUSY_MESSAGE } from "@/lib/integrations/zoho-books/api";

const TENANT_A = "c1753000-0000-4000-8000-0000000000a1";
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/integrations/zoho-books/import", { method: "POST", body: JSON.stringify(body) }));
const owner = () => ({ userId: "u-owner", tenantId: TENANT_A, role: "owner", canManage: true, admin: {} });

beforeEach(() => {
  h.caller = owner();
  h.conn = { refreshToken: "rt", orgId: "60000001", orgName: "T-Org", connectedAt: null };
  h.runs = { open: null, lastImport: null };
  h.started = []; h.rpc = []; h.rpcError = null; h.tokenError = null; h.saved = []; h.dropped = 0;
});

describe("import route", () => {
  it("not signed in → 401; a sales role → 403 and nothing runs", async () => {
    h.caller = null;
    expect((await GET()).status).toBe(401);
    h.caller = { ...owner(), role: "sales", canManage: false };
    expect((await post({ action: "start" })).status).toBe(403);
    expect((await post({ action: "undo", run_id: "c1753000-0000-4000-8000-0000000f0001", reason: "x" })).status).toBe(403);
    expect(h.started).toHaveLength(0);
    expect(h.rpc).toHaveLength(0);
  });

  it("start: the caller's own tenant and organization, last 24 months by default", async () => {
    const res = await post({ action: "start", tenant_id: "someone-else" });
    expect(res.status).toBe(200);
    const [, tenant, user, org, since, months] = h.started[0] as unknown[];
    expect([tenant, user, org, months]).toEqual([TENANT_A, "u-owner", "60000001", 24]);
    expect(String(since)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await post({ action: "start", months: 999 });
    expect((h.started[1] as unknown[])[5]).toBe(24);
  });

  it("import: one RPC, as the signed-in person, with the plan built on the server", async () => {
    h.runs = { open: { id: "run-1", org_id: "60000001", since: "2024-10-22", phase: "ready" }, lastImport: null };
    const res = await post({ action: "import", p_customers: [{ zoho_id: "evil" }] });
    expect(res.status).toBe(200);
    expect(h.rpc).toHaveLength(1);
    const { fn, args } = h.rpc[0];
    expect(fn).toBe("zoho_books_import_apply");
    expect(args.p_run_id).toBe("run-1");
    expect((args.p_customers as Array<{ zoho_id: string }>).map((c) => c.zoho_id)).toEqual(["c1"]);
    expect(args.p_subscriptions).toEqual([expect.objectContaining({ domain: "t-alpha.in", seats: 5, mrr: 750 })]);
  });

  it("dry run before reading finished → 409; organization changed → 409", async () => {
    h.runs = { open: { id: "run-1", org_id: "60000001", since: "2024-10-22", phase: "details" }, lastImport: null };
    expect((await post({ action: "dry_run" })).status).toBe(409);
    h.runs = { open: { id: "run-1", org_id: "OTHER", since: "2024-10-22", phase: "ready" }, lastImport: null };
    const res = await post({ action: "import" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/organization changed/);
    expect(h.rpc).toHaveLength(0);
  });

  it("undo: the database's refusal is shown as is", async () => {
    h.rpcError = { message: "This import cannot be undone: a payment (or TDS / late fee) is already recorded on INV-T-009." };
    const res = await post({ action: "undo", run_id: "c1753000-0000-4000-8000-0000000f0001", reason: "T-wrong org" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/cannot be undone/);
    expect(h.rpc[0]).toEqual({ fn: "zoho_books_import_undo", args: { p_run_id: "c1753000-0000-4000-8000-0000000f0001", p_reason: "T-wrong org" } });
  });

  it("R-1757: Zoho busy while getting access → a pause (rate_limited), cursor kept, no 'access has ended'", async () => {
    h.runs = { open: { id: "run-1", org_id: "60000001", since: "2024-10-22", phase: "details" }, lastImport: null };
    h.tokenError = new ZohoApiError(ZOHO_BUSY_MESSAGE, "busy", 429);
    const res = await post({ action: "step" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rate_limited).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/access has ended|Disconnect/);
    expect(h.saved).toEqual([{ last_error: ZOHO_BUSY_MESSAGE }]);
    expect(h.dropped).toBe(0);
  });
});
