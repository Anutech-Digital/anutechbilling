/**
 * R-2099 — the settlement fetch end to end with Razorpay's HTTP MOCKED (never a real key): keys
 * missing, settlement found (paged recon, fee + tax), not found, Razorpay refusing the key, and
 * the platform env keys never used for another company.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (row: unknown) => row }));

import { loadSettlementPlan, loadSettlementKeys, NO_KEYS_MESSAGE } from "./settlement.server";

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

/** A tiny PostgREST stand-in: eq / in / is / gte / lte filter the fixture rows. */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const b: Record<string, unknown> = {};
      const chain = (fn?: (r: Row) => boolean) => { if (fn) filters.push(fn); return b; };
      b.select = () => chain();
      b.eq = (c: string, v: unknown) => chain((r) => r[c] === v);
      b.in = (c: string, vs: unknown[]) => chain((r) => vs.includes(r[c]));
      b.is = (c: string, v: unknown) => chain((r) => (r[c] ?? null) === v);
      b.gte = (c: string, v: string) => chain((r) => String(r[c]) >= v);
      b.lte = (c: string, v: string) => chain((r) => String(r[c]) <= v);
      b.order = () => chain();
      b.limit = () => chain();
      const rows = () => (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok);
      return b;
    },
  } as never;
}

const T = "tenant-1";
const LINE = {
  id: "L1", tenant_id: T, credit: 9251, txn_date: "2026-10-20", reference: "AXISCN0012345", matched_to_type: null,
  description: "NEFT CR-UTIB0001506-RAZORPAY PAYMENTS PVT LTD PAYMENT AGGREGATOR ESCR-ACME TRADERS-A",
};
const pay = (id: string, ref: string, amount: number) => ({
  id, tenant_id: T, reference: ref, amount, credit_applied: 0, status: "received", received_at: "2026-10-18T10:00:00Z",
  quote_id: `Q-${id}`, customer_id: "c1", bank_txn_id: null,
});
const SETL = { id: "setl_A", entity: "settlement", amount: 925100, fees: 18900, tax: 2900, utr: "AXISCN0012345", status: "processed", created_at: 1792474200 };
const recon = (id: string, amount: number, fee: number, tax: number) => ({
  entity_id: id, type: "payment", amount, credit: amount - fee, debit: 0, fee, tax, settlement_id: "setl_A", order_id: null, created_at: 1792300000,
});

let calls: string[] = [];
let authSeen: string | null = null;
function razorpay(routes: { settlements?: unknown[]; recon?: unknown[]; status?: number }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push(url);
    authSeen = (init?.headers as Record<string, string>)?.Authorization ?? null;
    if (routes.status) return new Response("{}", { status: routes.status });
    const u = new URL(url);
    if (u.pathname === "/v1/settlements") return Response.json({ entity: "collection", items: routes.settlements ?? [] });
    if (u.pathname === "/v1/settlements/recon/combined") {
      return Response.json({ entity: "collection", items: Number(u.searchParams.get("skip")) === 0 ? routes.recon ?? [] : [] });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  authSeen = null;
  db.tables = {
    bank_transactions: [LINE],
    tenant_secrets: [{ tenant_id: T, razorpay_key_id: "rzp_test_abc123", razorpay_key_secret: "secret_xyz_123" }],
    payments: [pay("a1", "pay_1", 1180), pay("a2", "pay_2", 2360), pay("a3", "pay_3", 5900)],
    customers: [{ id: "c1", tenant_id: T, name: "Acme" }],
    quotes: [],
  };
});

const run = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof loadSettlementPlan>[0]> = {}) =>
  loadSettlementPlan({ db: fakeClient(), admin: fakeClient(), tenantId: T, txnId: "L1", fetchImpl, env: {}, ...extra });

describe("loadSettlementPlan (Razorpay mocked)", () => {
  it("no keys → the Settings message; Razorpay is never called", async () => {
    db.tables.tenant_secrets = [];
    const r = await run(razorpay({}));
    expect(r).toEqual({ state: "no_keys", message: NO_KEYS_MESSAGE });
    expect(NO_KEYS_MESSAGE).toContain("Add your Razorpay API key in Settings → Integrations");
    expect(calls).toEqual([]);
  });

  it("found: settlement by UTR, its recon rows, matched to the app payments; fee + tax sum to the bank line", async () => {
    const r = await run(razorpay({
      settlements: [{ ...SETL, id: "setl_other", utr: "XYZ", amount: 100 }, SETL],
      recon: [recon("pay_1", 118000, 2400, 400), recon("pay_2", 236000, 4700, 700), recon("pay_3", 590000, 11800, 1800)],
    }));
    expect(r.state).toBe("plan");
    if (r.state !== "plan") return;
    expect(r.plan.ready).toBe(true);
    expect(r.plan.totals).toMatchObject({ gross: 9440, fee: 189, feeGst: 29, net: 9251, bank: 9251 });
    expect(r.plan.payments.every((p) => p.customer === "Acme")).toBe(true);
    // Basic auth with the company's own key; the secret is never in a URL.
    expect(authSeen).toBe("Basic " + Buffer.from("rzp_test_abc123:secret_xyz_123").toString("base64"));
    expect(calls.some((c) => c.includes("secret_xyz_123"))).toBe(false);
    // the settlement window and the settlement's IST day
    const s = new URL(calls[0]);
    expect(s.pathname).toBe("/v1/settlements");
    expect(Number(s.searchParams.get("from"))).toBeLessThan(SETL.created_at);
    expect(Number(s.searchParams.get("to"))).toBeGreaterThan(SETL.created_at);
    const rc = new URL(calls[1]);
    expect([rc.searchParams.get("year"), rc.searchParams.get("month"), rc.searchParams.get("day")]).toEqual(["2026", "10", "20"]);
  });

  it("not found → plain English, nothing else read", async () => {
    const r = await run(razorpay({ settlements: [{ ...SETL, utr: "OTHER", amount: 1 }] }));
    expect(r.state).toBe("not_found");
    if (r.state === "not_found") expect(r.message).toMatch(/No Razorpay settlement of ₹9,251/);
  });

  it("Razorpay refuses the key → says where to fix it", async () => {
    const r = await run(razorpay({ status: 401 }));
    expect(r).toMatchObject({ state: "error", message: expect.stringContaining("Settings → Integrations → Razorpay") });
  });

  it("an unmatched Razorpay payment is offered the app's same-amount payments", async () => {
    db.tables.payments = [pay("a1", "pay_1", 1180), pay("x9", "UTR-123", 2360), pay("a3", "pay_3", 5900)];
    const r = await run(razorpay({
      settlements: [SETL],
      recon: [recon("pay_1", 118000, 2400, 400), recon("pay_2", 236000, 4700, 700), recon("pay_3", 590000, 11800, 1800)],
    }));
    if (r.state !== "plan") throw new Error(r.state);
    expect(r.plan.ready).toBe(false);
    expect(r.plan.payments[1].candidates.map((c) => c.id)).toEqual(["x9"]);
  });

  it("an already reconciled line is refused before Razorpay is called", async () => {
    db.tables.bank_transactions = [{ ...LINE, matched_to_type: "payment" }];
    const r = await run(razorpay({}));
    expect(r.state).toBe("error");
    expect(calls).toEqual([]);
  });
});

describe("loadSettlementKeys", () => {
  it("the env pair only for the platform company — never another company's fallback", async () => {
    db.tables.tenant_secrets = [];
    const env = { BUY_PAGE_TENANT_ID: "platform-1", RAZORPAY_KEY_ID: "rzp_live_platform", RAZORPAY_KEY_SECRET: "platform_secret" };
    expect(await loadSettlementKeys(fakeClient(), "tenant-1", env)).toBeNull();
    expect(await loadSettlementKeys(fakeClient(), "platform-1", env)).toEqual({ keyId: "rzp_live_platform", keySecret: "platform_secret" });
  });
});
