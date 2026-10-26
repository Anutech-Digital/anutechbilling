/**
 * R-1967 (26 Oct 2026, Pardeep on the staging Buy now dialog): the buyer chooses Annual or
 * Monthly (flex). The route takes only the CHOICE; the rate comes from the catalogue here.
 *   - Annual: the order is exactly what it was before (Starter × 10 = ₹32,400 + GST = ₹38,232,
 *     one annual_yearly line at ₹3,240/user/year, no billing_cycle on the quote).
 *   - Monthly: users × the catalogue's flex rate (+GST), ONE month, a `monthly` line — which
 *     record_payment turns into a 1-month subscription (supabase/tests/monthly_subscription.test.sql).
 *   - A rate sent by the browser is ignored.
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
    if (table === "quotes") return { data: { public_token: "tok-r1967" }, error: null };
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
        : { data: null, error: { message: "stop after the quote", code: "P0001" } },
  }),
}));
vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: () => null }));
vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
vi.mock("@/lib/checkout/live-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/checkout/live-guards")>()),
  buyPageTenantIdOrEmpty: () => "00000000-0000-0000-0000-000000001967",
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
type Row = Record<string, unknown> & { line_items: Record<string, unknown>[] };
const quoteRow = () => db.inserts.find((i) => i.table === "quotes")?.row as Row;
const leadRow = () => db.inserts.find((i) => i.table === "leads")?.row as Record<string, unknown>;

beforeEach(() => { db.catalogRow = STARTER_ROW; db.inserts = []; });
afterEach(() => { process.env = { ...ENV }; });

describe("R-1967 Workspace checkout — Annual or Monthly (flex)", { timeout: 60_000 }, () => {
  it("no choice sent → Annual, exactly as before (Starter × 10 = ₹32,400 + GST = ₹38,232)", async () => {
    await post({});
    const q = quoteRow();
    expect(q.subtotal).toBe(32400);
    expect(q.amount).toBe(38232);
    expect(q.line_items).toHaveLength(1);
    expect(q.line_items[0]).toMatchObject({ qty: 10, rate: 3240, commitment: "annual_yearly", name: "Google Workspace Business Starter" });
    expect("billing_cycle" in q).toBe(false);
  });

  it("Annual chosen → the same order", async () => {
    await post({ commitment: "annual" });
    const q = quoteRow();
    expect(q.amount).toBe(38232);
    expect(q.line_items[0]).toMatchObject({ rate: 3240, commitment: "annual_yearly" });
  });

  it("Monthly chosen → 10 × ₹325 = ₹3,250 + GST = ₹3,835 for ONE month, a monthly line, billed monthly", async () => {
    await post({ commitment: "monthly" });
    const q = quoteRow();
    expect(q.subtotal).toBe(3250);
    expect(q.amount).toBe(3835);
    expect(q.line_items[0]).toMatchObject({ qty: 10, rate: 325, commitment: "monthly" });
    expect(q.billing_cycle).toBe("monthly");
    expect(String(leadRow().notes)).toMatch(/Billing: monthly \(flex\)/);
  });

  it("Standard monthly → users × ₹1,300 (+GST)", async () => {
    db.catalogRow = {
      id: "GW-STD", name: "Google Workspace Business Standard", msrp: 1080, wholesale: 0,
      prices: { annual: { msrp: 1080, wholesale: 0 }, monthly: { msrp: 1300, wholesale: 0 } },
    };
    await post({ commitment: "monthly", tierId: "standard", seats: 4 });
    expect(quoteRow().subtotal).toBe(5200);
    expect(quoteRow().amount).toBe(6136);
  });

  it("a rate or amount sent by the browser is ignored — the catalogue decides", async () => {
    await post({ commitment: "monthly", rate: 1, monthlyRate: 1, amount: 1, subtotal: 1 });
    expect(quoteRow().amount).toBe(3835);
  });

  it("an edition with no flexible price in the catalogue → monthly refused, nothing saved", async () => {
    db.catalogRow = { ...STARTER_ROW, prices: { annual: { msrp: 270, wholesale: 0 } } };
    const res = await post({ commitment: "monthly" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Monthly billing isn't offered/);
    expect(body.error).toMatch(/Nothing was charged/);
    expect(db.inserts).toHaveLength(0);
  });

  it("an unknown choice is refused", async () => {
    const res = await post({ commitment: "weekly" });
    expect(res.status).toBe(400);
    expect(db.inserts).toHaveLength(0);
  });
});
