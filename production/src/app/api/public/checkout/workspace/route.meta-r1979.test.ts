/**
 * R-1979: a simulated (test) buy-page order sends the server Purchase to Meta — with the buyer's
 * consent and _fbp from the checkout body — after the payment and the invoice; Meta failing (it
 * never throws) cannot stop the order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({
  catalogRow: null as unknown,
  inserts: [] as { table: string; row: Record<string, unknown> }[],
}));

function chain(table: string) {
  const result = () => {
    if (table === "items") return { data: db.catalogRow, error: null };
    if (table === "quotes") return { data: { public_token: "tok-r1979" }, error: null };
    return { data: null, error: null };
  };
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "ilike", "limit", "lte", "or", "order", "update", "abortSignal"]) c[m] = () => c;
  c.insert = (row: Record<string, unknown>) => { db.inserts.push({ table, row }); return c; };
  c.maybeSingle = async () => result();
  c.single = async () => result();
  c.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
  return c;
}

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => chain(table),
    rpc: async (fn: string) =>
      fn === "next_document_number"
        ? { data: "Q-T-0001", error: null }
        : { data: null, error: null },
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => null }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
const meta = vi.hoisted(() => ({ calls: [] as unknown[], fail: false }));
vi.mock("@/lib/meta/capi.server", () => ({ reportPurchaseToMeta: async (_a: unknown, input: unknown) => { meta.calls.push(input); return meta.fail ? { sent: false, reason: "network" } : { sent: true }; } }));
vi.mock("@/lib/checkout/online-invoice.server", () => ({ issueInvoiceForOnlinePayment: async () => ({}) }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: async () => ({ alert: { ok: false, reason: "test" }, tenant: null }) }));
vi.mock("@/lib/email/lead-owner.server", () => ({ loadLeadOwner: async () => null }));
vi.mock("@/lib/messaging", () => ({ sendCustomerEmail: async () => ({}), sendInternalEmail: async () => ({}) }));
vi.mock("@/lib/checkout/live-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/checkout/live-guards")>()),
  buyPageTenantIdOrEmpty: () => "00000000-0000-0000-0000-000000001979",
  simulatedPaymentAllowed: () => true,
}));

const STARTER_ROW = {
  id: "GW-STR", name: "Google Workspace Business Starter", msrp: 270, wholesale: 0,
  prices: { annual: { msrp: 270, wholesale: 0 }, monthly: { msrp: 325, wholesale: 0 } },
};

const ENV = { ...process.env };
async function post(extra: Record<string, unknown>) {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  delete process.env.TURNSTILE_SECRET_KEY;
  vi.resetModules();
  const { POST } = await import("./route");
  return POST(new NextRequest("https://example.invalid/api/public/checkout/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fullName: "Ravi Kumar", companyName: "Ravi Traders", email: "ravi@example.invalid", phone: "9999999999",
      seats: 10, domain: "ravitraders.in", tierId: "starter", stateCode: "07", simulate: true, ...extra,
    }),
  }));
}
beforeEach(() => { db.catalogRow = STARTER_ROW; db.inserts = []; meta.calls = []; meta.fail = false; });
afterEach(() => { process.env = { ...ENV }; });

describe("R-1979 simulated order → server Purchase to Meta", { timeout: 60_000 }, () => {
  it("consent + _fbp from the checkout go to reportPurchaseToMeta for this quote", async () => {
    const res = await post({ metaConsent: true, fbp: "fb.1.111.222", pageUrl: "https://example.in/buy/workspace?utm_source=facebook" });
    expect(res.status).toBe(200);
    expect(meta.calls).toHaveLength(1);
    expect(meta.calls[0]).toMatchObject({ quoteId: "Q-T-0001", consent: true, fbp: "fb.1.111.222", sourceUrl: "https://example.in/buy/workspace?utm_source=facebook" });
  });

  it("no consent sent → consent false (the helper then sends nothing)", async () => {
    await post({});
    expect(meta.calls[0]).toMatchObject({ consent: false, fbp: null });
  });

  it("Meta failing does not fail the order", async () => {
    meta.fail = true;
    const res = await post({ metaConsent: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { simulated?: boolean }).simulated).toBe(true);
  });
});
