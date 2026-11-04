/**
 * R-2021 (R-2019b): the checkout route takes the phone flow's intent / domainMode / migrationSource
 * ADDITIVELY — an old page (the desktop) that sends none of them is priced and saved exactly as
 * before; "Decide later" is the only order that may come without a domain (the lead and the quote
 * then carry NULL, and the notes say so). Anything else unknown is refused before anything is saved.
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
    if (table === "quotes") return { data: { public_token: "tok-r2021" }, error: null };
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
  buyPageTenantIdOrEmpty: () => "00000000-0000-0000-0000-000000002021",
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


const lead = () => leadRow();
describe("R-2021: phone-flow fields on the checkout route — additive only", { timeout: 60_000 }, () => {
  it("an old body (no intent / domainMode / migrationSource) → saved exactly as before (₹38,232, domain kept, no new note)", async () => {
    const res = await post({});
    expect(res.status).not.toBe(400);
    expect(quoteRow().amount).toBe(38232);
    expect(lead().domain).toBe("ravitraders.in");
    expect(String(lead().notes)).not.toMatch(/Phone buy flow/);
  });

  it("the phone flow's fields → one plain line in the lead notes; the money is the same", async () => {
    await post({ intent: "transfer", domainMode: "google", migrationSource: undefined });
    expect(String(lead().notes)).toContain("Phone buy flow — Switching an existing Google Workspace to us · Domain: already on Google Workspace — move the billing only");
    expect(quoteRow().amount).toBe(38232);
  });

  it("Decide later: no domain is fine — lead + quote carry NULL and the notes say it is agreed on the setup call", async () => {
    const res = await post({ domain: "", intent: "new", domainMode: "later", migrationSource: "m365" });
    expect(res.status).not.toBe(400);
    expect(lead().domain).toBeNull();
    expect(quoteRow().domain).toBeNull();
    expect(String(lead().notes)).toContain("Domain: not chosen yet — agree it on the setup call");
    expect(String(lead().notes)).toContain("Email today: Microsoft 365");
  });

  it("no domain WITHOUT Decide later is still refused (400) and nothing is saved; unknown values are refused too", async () => {
    for (const extra of [{ domain: "" }, { domain: "ab" }, { domainMode: "someday" }, { intent: "upgrade" }, { migrationSource: "outlook" }, { domain: "", domainMode: "later", domainNew: true }]) {
      db.inserts = [];
      const res = await post(extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(db.inserts).toEqual([]);
    }
  });
});
