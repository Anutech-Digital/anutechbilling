/**
 * R-2949 — POST /api/integrations/zoho-books/sales-import: the owner's "Left out by you" list is
 * enforced by the SERVER. A left-out invoice is not in the preview's to-import list, and a direct
 * call with action "import" (dry run or real) never sends it to import_zoho_fy_sales. The list is
 * kept per company; only the roles that may import may read or change it.
 * Supabase, the scan store and the list's table are mocked; Zoho is never called. Values are made up.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ZohoSaleFacts } from "@/lib/integrations/zoho-books/sales-import/normalise";

type Rule = { rule: "doc" | "prefix"; value: string; number?: string };
const st = vi.hoisted(() => ({
  role: "owner" as string | null,
  tenantId: "t1",
  facts: [] as unknown[],
  /* tenant → that company's rules (the table). */
  left: new Map<string, Array<{ rule: string; value: string; number?: string }>>(),
  /* tenant → zoho id → number (that company's Zoho read). */
  scan: new Map<string, Record<string, string>>(),
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@/lib/integrations/zoho-books/store", () => ({
  resolveZohoCaller: async () => (st.role === null ? null : { userId: "u1", tenantId: st.tenantId, role: st.role, canManage: true, admin: {} }),
  readConnection: async () => ({ refreshToken: "rt", orgId: "600", orgName: "Org", connectedAt: null }),
  zohoAccessToken: async () => "access",
  dropZohoAccessToken: async () => {},
}));
vi.mock("@/lib/integrations/zoho-books/fy-import/store", () => ({
  supabaseScanStore: () => ({ readRun: async () => ({ nextPage: 3, listDone: true }), counts: async () => ({ listed: 4, detailed: 4 }) }),
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
vi.mock("@/lib/integrations/zoho-books/sales-import/left-out-store", () => {
  const of = (t: string) => { if (!st.left.has(t)) st.left.set(t, []); return st.left.get(t)!; };
  return {
    LEFT_OUT_MAX: { doc: 3, prefix: 2 },
    readLeftOut: async (_db: unknown, tenantId: string) => ({
      docs: of(tenantId).filter((r) => r.rule === "doc").map((r) => ({ zohoId: r.value, number: r.number ?? "" })),
      prefixes: of(tenantId).filter((r) => r.rule === "prefix").map((r) => r.value),
    }),
    addLeftOut: async (_db: unknown, tenantId: string, _user: string, r: Rule) => {
      if (!of(tenantId).some((x) => x.rule === r.rule && x.value === r.value)) of(tenantId).push(r);
    },
    removeLeftOut: async (_db: unknown, tenantId: string, rule: string, value: string) => {
      st.left.set(tenantId, of(tenantId).filter((x) => !(x.rule === rule && x.value === value)));
    },
    scannedInvoiceNumber: async (_db: unknown, tenantId: string, zohoId: string) => st.scan.get(tenantId)?.[zohoId] ?? null,
  };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { st.rpc.push({ fn, args }); return { data: { imported: 0, already: 0, skipped: [] }, error: null }; } }),
}));

import { POST } from "./route";

const fact = (over: Partial<ZohoSaleFacts>): ZohoSaleFacts => ({
  zohoId: "z1", number: "INV/25-26/0001", date: "2025-05-10", dueDate: null, status: "paid", zohoCustomerId: "c", customerName: "Test Buyer",
  gstin: "29ABCDE1234F1Z5", gstTreatment: "business_gst", appGstTreatment: "registered_regular", posStateCode: "29", currency: "INR", fxRate: null,
  taxable: 1000, tax: 180, amount: 1180, taxRate: 18, head: "igst", lines: [], problems: [], notes: [], ...over,
});
const post = async (body: Record<string, unknown>) => {
  const res = await POST(new NextRequest("http://localhost:3001/api/integrations/zoho-books/sales-import", {
    method: "POST", body: JSON.stringify({ fy: "2025-26", ...body }), headers: { "content-type": "application/json" },
  }));
  return { status: res.status, body: await res.json() };
};
const pickedIds = () => st.rpc.flatMap((c) => (c.args.p_picks as Array<{ zoho_invoice_id: string }>).map((p) => p.zoho_invoice_id));

beforeEach(() => {
  st.role = "owner"; st.tenantId = "t1"; st.rpc = []; st.left = new Map();
  st.facts = [
    fact({}),
    fact({ zohoId: "z2", number: "INV/25-26/0002", date: "2025-06-02", taxable: 20000, tax: 3600, amount: 23600, tds: 2000, tdsSection: "194J" }),
    fact({ zohoId: "z3", number: "LSINV/25-26/0132", date: "2025-06-20", taxable: 1346, tax: 242, amount: 1588 }),
  ];
  const numbers = { z1: "INV/25-26/0001", z2: "INV/25-26/0002", z3: "LSINV/25-26/0132" };
  st.scan = new Map([["t1", numbers], ["t2", numbers]]);
});

describe("R-2949 sales-import route — the to-import list", () => {
  it("preview lists the invoices that will be imported (number, date, customer, total, TDS / adjustment)", async () => {
    const { body } = await post({ action: "preview" });
    expect(body.counts).toMatchObject({ import: 3, skip: 0, leftOutByYou: 0 });
    expect(body.toImport).toEqual([
      { zohoId: "z1", number: "INV/25-26/0001", date: "2025-05-10", customer: "Test Buyer", amount: 1180, tds: 0, tdsSection: null, adjustment: 0 },
      { zohoId: "z2", number: "INV/25-26/0002", date: "2025-06-02", customer: "Test Buyer", amount: 23600, tds: 2000, tdsSection: "194J", adjustment: 0 },
      { zohoId: "z3", number: "LSINV/25-26/0132", date: "2025-06-20", customer: "Test Buyer", amount: 1588, tds: 0, tdsSection: null, adjustment: 0 },
    ]);
    expect(body.toImportMore).toBe(0);
    expect(body.leftOut).toEqual({ prefixes: [], invoices: [] });
  });
});

describe("R-2949 sales-import route — left out by you, enforced on the server", () => {
  it("the prefix rule (typed in any case, with spaces) keeps that number out of preview, Check first and Import", async () => {
    expect((await post({ action: "leaveOut", prefix: "  ls " })).body).toMatchObject({ ok: true });
    const { body } = await post({ action: "preview" });
    expect(body.counts).toMatchObject({ import: 2, skip: 1, leftOutByYou: 1 });
    expect(body.toImport.map((r: { number: string }) => r.number)).toEqual(["INV/25-26/0001", "INV/25-26/0002"]);
    expect(body.leftOut).toEqual({
      prefixes: [{ prefix: "LS", count: 1, amount: 1588 }],
      invoices: [{ zohoId: "z3", number: "LSINV/25-26/0132", date: "2025-06-20", customer: "Test Buyer", amount: 1588, by: "prefix", prefix: "LS" }],
    });
    /* It has its own block — never a line in the generic list. */
    expect(body.skipped).toEqual([]);
    expect(body.skipReasons).toEqual([]);

    /* A direct call to the route — no dialog involved — dry run and for real. */
    await post({ action: "import", part: 0 });
    await post({ action: "import", part: 0, dryRun: false });
    expect(st.rpc).toHaveLength(2);
    expect(st.rpc.map((c) => c.args.p_dry_run)).toEqual([true, false]);
    expect(pickedIds()).toEqual(["z1", "z2", "z1", "z2"]);
    expect(pickedIds()).not.toContain("z3");
  });

  it("one invoice left out by its row: not imported even when the caller names it", async () => {
    expect((await post({ action: "leaveOut", zohoId: "z2" })).status).toBe(200);
    await post({ action: "import", part: 0, dryRun: false, picks: [{ zoho_invoice_id: "z2", customer_id: "cust-1", item_ids: [] }], zohoId: "z2" });
    expect(pickedIds()).toEqual(["z1", "z3"]);
    const { body } = await post({ action: "preview" });
    expect(body.leftOut.invoices).toEqual([{ zohoId: "z2", number: "INV/25-26/0002", date: "2025-06-02", customer: "Test Buyer", amount: 23600, by: "invoice" }]);
  });

  it("everything left out: the import is refused, nothing reaches the database", async () => {
    await post({ action: "leaveOut", prefix: "INV" });
    await post({ action: "leaveOut", prefix: "LS" });
    const r = await post({ action: "import", part: 0, dryRun: false });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("Nothing to import.");
    expect(st.rpc).toEqual([]);
  });

  it("the rest of the plan is untouched: Zoho's months the same, to-import less exactly that invoice", async () => {
    const before = (await post({ action: "preview" })).body;
    await post({ action: "leaveOut", prefix: "LS" });
    const after = (await post({ action: "preview" })).body;
    expect(after.zohoByMonth).toEqual(before.zohoByMonth);
    expect(after.importByMonth).toEqual([
      { month: "2025-05", count: 1, taxable: 1000, igst: 180, cgst: 0, sgst: 0, amount: 1180 },
      { month: "2025-06", count: 1, taxable: 20000, igst: 3600, cgst: 0, sgst: 0, amount: 23600 },
    ]);
    expect(before.importByMonth[1]).toEqual({ month: "2025-06", count: 2, taxable: 21346, igst: 3842, cgst: 0, sgst: 0, amount: 25188 });
  });

  it("taking it back brings it in again; doing either twice changes nothing more", async () => {
    await post({ action: "leaveOut", prefix: "LS" });
    await post({ action: "leaveOut", prefix: "ls" });
    await post({ action: "leaveOut", zohoId: "z1" });
    await post({ action: "leaveOut", zohoId: "z1" });
    expect(st.left.get("t1")).toHaveLength(2);
    expect((await post({ action: "preview" })).body.counts).toMatchObject({ import: 1, leftOutByYou: 2 });

    expect((await post({ action: "takeBack", prefix: "Ls" })).status).toBe(200);
    expect((await post({ action: "takeBack", prefix: "LS" })).status).toBe(200);
    await post({ action: "takeBack", zohoId: "z1" });
    const { body } = await post({ action: "preview" });
    expect(body.counts).toMatchObject({ import: 3, skip: 0, leftOutByYou: 0 });
    await post({ action: "import", part: 0, dryRun: false });
    expect(pickedIds()).toEqual(["z1", "z2", "z3"]);
  });

  it("another company is untouched by this company's rules", async () => {
    await post({ action: "leaveOut", prefix: "LS" });
    await post({ action: "leaveOut", zohoId: "z1" });
    st.tenantId = "t2";
    const other = (await post({ action: "preview" })).body;
    expect(other.counts).toMatchObject({ import: 3, leftOutByYou: 0 });
    expect(other.leftOut).toEqual({ prefixes: [], invoices: [] });
    await post({ action: "import", part: 0, dryRun: false });
    expect(pickedIds()).toEqual(["z1", "z2", "z3"]);
    /* …and it cannot take the first company's rule back. */
    await post({ action: "takeBack", prefix: "LS" });
    expect(st.left.get("t1")).toHaveLength(2);
  });

  it("only the owner or an accountant may read or change the list", async () => {
    for (const role of ["manager", "sales", "billing", "support"]) {
      st.role = role;
      for (const body of [{ action: "leaveOut", prefix: "LS" }, { action: "leaveOut", zohoId: "z1" }, { action: "takeBack", prefix: "LS" }]) {
        expect((await post(body)).status).toBe(403);
      }
    }
    st.role = null;
    expect((await post({ action: "leaveOut", prefix: "LS" })).status).toBe(401);
    expect(st.left.get("t1") ?? []).toEqual([]);
    st.role = "accountant";
    expect((await post({ action: "leaveOut", prefix: "LS" })).status).toBe(200);
  });

  it("refuses a prefix under 2 characters, an invoice that is not in this company's Zoho read, and a call that names neither", async () => {
    for (const prefix of ["", " ", "L", "x".repeat(21), 5, null]) {
      const r = await post({ action: "leaveOut", prefix });
      expect(r.status).toBe(400);
    }
    expect((await post({ action: "leaveOut", prefix: "L" })).body.error).toBe("Type 2 to 20 characters that the invoice numbers start with.");
    const unknown = await post({ action: "leaveOut", zohoId: "not-ours" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("That invoice is not in the Zoho read. Preview again.");
    expect((await post({ action: "leaveOut" })).status).toBe(400);
    expect((await post({ action: "leaveOut", zohoId: "z1", prefix: "LS" })).status).toBe(400);
    expect(st.left.get("t1") ?? []).toEqual([]);
  });

  it("refuses more rules than the list holds (the list stays small)", async () => {
    await post({ action: "leaveOut", prefix: "LS" });
    await post({ action: "leaveOut", prefix: "INV/24" });
    const r = await post({ action: "leaveOut", prefix: "ZZ" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/^You have already left out 2 /);
    /* Saving one that is already there is still fine. */
    expect((await post({ action: "leaveOut", prefix: "ls" })).status).toBe(200);
  });
});
