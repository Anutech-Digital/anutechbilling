/**
 * R-1978 (26 Oct 2026, G-ADS): the ad that brought an online order reaches the ORDER. The buy page
 * sends the landing URL (utm_*, fbclid, gclid) as pageUrl and document.referrer as pageReferrer
 * (site/lib/ad-attribution.ts landingForForm); the route writes the cleaned capture on the lead
 * (now with utm_content + utm_term) AND on the quote — which the subscription reads by quote_id.
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
    if (table === "quotes") return { data: { public_token: "tok-r1978" }, error: null };
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
vi.mock("@/lib/checkout/live-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/checkout/live-guards")>()),
  buyPageTenantIdOrEmpty: () => "00000000-0000-0000-0000-000000001978",
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
type Row = Record<string, unknown>;
const quoteRow = () => db.inserts.find((i) => i.table === "quotes")?.row as Row;
const leadRow = () => db.inserts.find((i) => i.table === "leads")?.row as Row;

beforeEach(() => { db.catalogRow = STARTER_ROW; db.inserts = []; });
afterEach(() => { process.env = { ...ENV }; });

const AD = "https://example.in/buy/workspace?utm_source=facebook&utm_medium=paid_social&utm_campaign=ws-oct&utm_content=ad1&utm_term=gsuite&fbclid=FB.123&email=ravi@example.invalid";

describe("R-1978 ad attribution on the lead AND the quote", { timeout: 60_000 }, () => {
  it("the Facebook ad URL → lead and quote carry source, medium, campaign, content, term, fbclid; landing URL keeps only utm params", async () => {
    await post({ pageUrl: AD, pageReferrer: "https://l.facebook.com/l.php?u=secret" });
    for (const r of [leadRow(), quoteRow()]) {
      expect(r).toMatchObject({
        utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "ws-oct", utm_content: "ad1", utm_term: "gsuite",
        fbclid: "FB.123", gclid: null, referrer_url: "https://l.facebook.com/l.php",
      });
      expect(String(r.landing_page_url)).toBe("https://example.in/buy/workspace?utm_source=facebook&utm_medium=paid_social&utm_campaign=ws-oct&utm_content=ad1&utm_term=gsuite");
      expect(String(r.landing_page_url)).not.toMatch(/email|ravi/);
    }
  });

  it("no ad → the quote carries NULLs (nothing captured), money unchanged (₹38,232)", async () => {
    await post({});
    const q = quoteRow();
    expect(q.utm_source).toBeNull();
    expect(q.fbclid).toBeNull();
    expect(q.amount).toBe(38232);
  });
});
