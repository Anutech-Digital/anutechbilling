/**
 * R-2499 — POST /api/integrations/zoho-books/sales-import. Owner / accountant only; preview and
 * import only from a COMPLETE server scan; the import sends Zoho ids + matched customer / items to
 * import_zoho_fy_sales and NO money (amounts come from the scan in SQL); dry run by default.
 * Supabase and the scan store are mocked; Zoho is never called here. Values are made up.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ZohoSaleFacts } from "@/lib/integrations/zoho-books/sales-import/normalise";

const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  run: { nextPage: 3, listDone: true } as { nextPage: number; listDone: boolean } | null,
  counts: { listed: 2, detailed: 2 },
  facts: [] as unknown[],
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
  supabaseScanStore: () => ({
    readRun: async () => st.run,
    counts: async () => st.counts,
    reset: async () => { st.resets += 1; },
  }),
  readScannedFacts: async () => st.facts,
  readImportBatches: async () => [],
}));
vi.mock("@/lib/integrations/zoho-books/sales-import/store", () => ({
  readPlanContext: async () => ({
    fyStart: "2025-04-01", fyEnd: "2026-03-31", booksStart: "2025-04-01", lockedUntil: null, sellerStateCode: "07",
    customers: [{ id: "cust-1", name: "Test Buyer", gstin: "29ABCDE1234F1Z5" }], items: [], invoices: [],
  }),
  readImportedByMonth: async () => [],
  readSellerState: async () => "07",
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { st.rpc.push({ fn, args }); return st.rpcResult; } }),
}));

import { POST } from "./route";

const fact = (over: Partial<ZohoSaleFacts>): ZohoSaleFacts => ({
  zohoId: "z1", number: "INV/25-26/0001", date: "2025-05-10", dueDate: null, status: "paid", zohoCustomerId: "c", customerName: "Test Buyer",
  gstin: "29ABCDE1234F1Z5", gstTreatment: "business_gst", appGstTreatment: "registered_regular", posStateCode: "29", currency: "INR", fxRate: null,
  taxable: 1000, tax: 180, amount: 1180, taxRate: 18, head: "igst", lines: [], problems: [], notes: [], ...over,
});

function req(body: unknown) {
  return new NextRequest("http://localhost:3001/api/integrations/zoho-books/sales-import", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  st.role = "owner"; st.run = { nextPage: 3, listDone: true }; st.counts = { listed: 2, detailed: 2 }; st.rpc = []; st.resets = 0;
  st.facts = [fact({}), fact({ zohoId: "z2", number: "INV/25-26/0002", status: "void", problems: ["Void in Zoho — not a sale, not in revenue or GST."] })];
  st.rpcResult = { data: { dry_run: true, imported: 1 }, error: null };
});

describe("R-2499 sales-import route", () => {
  it("a manager (or anyone not owner / accountant) is refused", async () => {
    st.role = "manager";
    const res = await POST(req({ action: "preview", fy: "2025-26" }));
    expect(res.status).toBe(403);
    st.role = null;
    expect((await POST(req({ action: "preview", fy: "2025-26" }))).status).toBe(401);
  });

  it("refuses a bad financial year", async () => {
    expect((await POST(req({ action: "preview", fy: "2025" }))).status).toBe(400);
  });

  it("preview needs a complete scan (server-side counts, never the browser's)", async () => {
    st.counts = { listed: 2, detailed: 1 };
    const res = await POST(req({ action: "preview", fy: "2025-26", counts: { listed: 2, detailed: 2 } }));
    expect(res.status).toBe(409);
  });

  it("preview: void skipped with its reason; Zoho months exclude it", async () => {
    const body = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(body.ok).toBe(true);
    expect(body.counts).toMatchObject({ scanned: 2, import: 1, skip: 1, voidOrDraft: 1 });
    expect(body.skipped[0]).toMatchObject({ number: "INV/25-26/0002", reason: expect.stringMatching(/Void in Zoho/) });
    expect(body.zohoByMonth).toEqual([{ month: "2025-05", count: 1, taxable: 1000, igst: 180, cgst: 0, sgst: 0, amount: 1180 }]);
    expect(st.rpc).toEqual([]);
  });

  it("import: a dry run by default, sends Zoho ids + customer only — no amounts", async () => {
    const body = await (await POST(req({ action: "import", fy: "2025-26", part: 0, amount: 999999 }))).json();
    expect(body).toMatchObject({ ok: true, part: 0, parts: 1 });
    expect(st.rpc).toHaveLength(1);
    expect(st.rpc[0].fn).toBe("import_zoho_fy_sales");
    expect(st.rpc[0].args).toEqual({ p_fy: "2025-26", p_dry_run: true, p_picks: [{ zoho_invoice_id: "z1", customer_id: "cust-1", item_ids: [] }] });
    expect(JSON.stringify(st.rpc[0].args)).not.toMatch(/1180|999999/);
  });

  it("import for real only when dryRun is false; a part out of range is refused", async () => {
    await POST(req({ action: "import", fy: "2025-26", part: 0, dryRun: false }));
    expect(st.rpc[0].args.p_dry_run).toBe(false);
    expect((await POST(req({ action: "import", fy: "2025-26", part: 5 }))).status).toBe(400);
  });

  it("the database's refusal comes back as the message", async () => {
    st.rpcResult = { data: null, error: { message: "Only the owner or an accountant can import FY sales from Zoho. Ask one of them." } };
    const res = await POST(req({ action: "import", fy: "2025-26", part: 0 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/owner or an accountant/);
  });

  /* R-2530: same name, another PAN → the owner's "Use this customer anyway" tick travels with
     preview AND import (the server rebuilds the plan, so part N is the same invoices). */
  it("R-2530: a name match with another PAN is a choice in the preview; imported only with the tick", async () => {
    st.facts = [fact({ gstin: "29ZZZZZ9999Z1Z5" })];
    const pre = await (await POST(req({ action: "preview", fy: "2025-26" }))).json();
    expect(pre.counts).toMatchObject({ import: 0, skip: 1 });
    expect(pre.skipped[0].reason).toMatch(/^Name matches "Test Buyer" but the GSTIN differs/);
    expect(pre.gstinChoices).toEqual([expect.objectContaining({ key: "test buyer", customerId: "cust-1", chosen: false, count: 1 })]);
    expect((await POST(req({ action: "import", fy: "2025-26", part: 0 }))).status).toBe(409);

    const ticked = await (await POST(req({ action: "preview", fy: "2025-26", useAnyway: { "test buyer": "cust-1" } }))).json();
    expect(ticked.counts).toMatchObject({ import: 1, skip: 0 });
    expect(ticked.gstinChoices[0].chosen).toBe(true);
    await POST(req({ action: "import", fy: "2025-26", part: 0, useAnyway: { "test buyer": "cust-1" } }));
    expect(st.rpc[0].args.p_picks).toEqual([{ zoho_invoice_id: "z1", customer_id: "cust-1", item_ids: [] }]);
  });

  it("R-2530: a malformed useAnyway is ignored, never trusted", async () => {
    st.facts = [fact({ gstin: "29ZZZZZ9999Z1Z5" })];
    for (const useAnyway of [["cust-1"], "cust-1", { "test buyer": 5 }, { "test buyer": "someone-else" }]) {
      const body = await (await POST(req({ action: "preview", fy: "2025-26", useAnyway }))).json();
      expect(body.counts).toMatchObject({ import: 0, skip: 1 });
    }
  });

  it("undo calls remove_zoho_fy_sales_import with the reason; restart clears the scan", async () => {
    await POST(req({ action: "undo", fy: "2025-26", batchId: "b2499000-0000-0000-0000-0000000000b1", reason: "test batch" }));
    expect(st.rpc[0]).toEqual({ fn: "remove_zoho_fy_sales_import", args: { p_batch_id: "b2499000-0000-0000-0000-0000000000b1", p_reason: "test batch" } });
    await POST(req({ action: "restart", fy: "2025-26" }));
    expect(st.resets).toBe(1);
  });
});
