/**
 * R-2092 — PROOF against the real local database (docker Supabase), no mocks of the lay / bill
 * layer: a quote with TWO subscriptions billed quarterly (Starter 57 × ₹3,200/yr + Standard 13 ×
 * ₹11,000/yr = ₹3,83,972 = 4 × ₹95,993), paid for Q1, then raiseDueInstalmentsForQuote — the code
 * behind POST /api/quotes/:id/raise-instalments (the Record payment sheet), the online checkout
 * and the Invoices page's Generate.
 *
 * Localhost check of 68ed55d70 (29 Oct): Record payment ₹95,993 → ONE invoice for the Starter only
 * (₹53,808), the Standard's Q1 left without one; ₹95,933 (₹60 short) → the Starter invoiced 'Paid'
 * (R-2048 broken). The Standard's parts were laid only AFTER the Starter was billed.
 *
 * Opt-in (it writes to a database): R2092_DB_TEST=1 npx vitest run src/lib/billing/raise-instalments-r2092.db.test.ts
 * Reads .env.local and refuses unless NEXT_PUBLIC_SUPABASE_URL is a local 127.0.0.1 / localhost
 * address. Each run uses its own throw-away company; it is removed at the end where the database
 * lets it (issued invoices are kept by design — they stay inside that test company).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { raiseDueInstalmentsForQuote } from "./sync-instalments.server";
import { istToday } from "@/lib/dates/ist";

/* The ROUTE runs as itself: only the signed-in user is stood in (an owner of the test company);
   the admin client it bills with is the real one (createAdminClientFor). */
const who = vi.hoisted(() => ({ userId: "", tenantId: "" }));
vi.mock("@/lib/supabase/server", async (importActual) => {
  const real = await importActual<typeof import("@/lib/supabase/server")>();
  return {
    ...real,
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: who.userId } }, error: null }) },
      from: () => {
        const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: { tenant_id: who.tenantId, role: "owner" }, error: null }) };
        return b;
      },
    }),
  };
});
import { POST as raiseInstalmentsRoute } from "@/app/api/quotes/[id]/raise-instalments/route";

function localEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const env = localEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url);
const run = process.env.R2092_DB_TEST === "1" && isLocal && !!env.SUPABASE_SERVICE_ROLE_KEY;

const LINES = [
  { name: "Google Workspace Starter", qty: 57, rate: 3200, item_id: "GW-STR", commitment: "annual_yearly" },
  { name: "Google Workspace Standard", qty: 13, rate: 11000, item_id: "GW-STD", commitment: "annual_yearly" },
];

describe.runIf(run)("raise-instalments for a 2-subscription quarterly quote, local DB (R-2092)", () => {
  let db: SupabaseClient;
  const tenantId = randomUUID();
  const customerId = randomUUID();
  const doc = `T${Math.floor(Math.random() * 900 + 100)}`;
  const today = istToday();
  let seq = 0;

  async function sale(paid: number): Promise<{ quoteId: string; subIds: string[] }> {
    seq += 1;
    const quoteId = `TESTQ-R2092-${doc}-${seq}`;
    const q = await db.from("quotes").insert({
      id: quoteId, tenant_id: tenantId, customer_id: customerId, customer_name: "R2092 Customer",
      tax_rate: 18, amount: 383972, subtotal: 325400, billing_cycle: "quarterly", status: "accepted",
      line_items: LINES.map((l) => ({ ...l, start_date: today })),
    });
    if (q.error) throw new Error(q.error.message);
    /* record_payment activates the sale: it makes the subscriptions (one per line), as the
       Record payment sheet does on localhost. */
    const p = await db.rpc("record_payment", { p_quote_id: quoteId, p_amount: paid, p_method: "upi", p_reference: `${quoteId}-PAY` });
    if (p.error) throw new Error(p.error.message);
    const { data: subs, error: sErr } = await db.from("subscriptions").select("id, plan").eq("quote_id", quoteId).order("plan");
    if (sErr) throw new Error(sErr.message);
    const subIds = (subs ?? []).map((x) => x.id as string);
    if (subIds.length !== 2) throw new Error(`record_payment made ${subIds.length} subscription(s), want 2`);
    return { quoteId, subIds };
  }

  /** POST /api/quotes/:id/raise-instalments — what the Record payment sheet calls after a payment. */
  async function viaRoute(quoteId: string) {
    const res = await raiseInstalmentsRoute(new Request(`http://x/api/quotes/${quoteId}/raise-instalments`, { method: "POST" }), { params: Promise.resolve({ id: quoteId }) });
    expect(res.status).toBe(200);
    return (await res.json()) as Awaited<ReturnType<typeof raiseDueInstalmentsForQuote>>;
  }

  beforeAll(async () => {
    db = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const t = await db.from("tenants").insert({
      id: tenantId, name: `R2092 Test ${doc}`, email: `r2092-${doc}@example.in`, state_code: "27",
      gstin: "27AAACT2092F1Z5", address: "Test street, Mumbai", doc_code: doc,
    });
    if (t.error) throw new Error(t.error.message);
    const c = await db.from("customers").insert({ id: customerId, tenant_id: tenantId, name: "R2092 Customer", state_code: "27", country: "India" });
    if (c.error) throw new Error(c.error.message);
    const au = await db.auth.admin.createUser({ email: `r2092-${doc}-owner@example.in`, email_confirm: true });
    if (au.error || !au.data.user) throw new Error(au.error?.message ?? "no auth user");
    const userId = au.data.user.id;
    const u = await db.from("users").upsert({ id: userId, tenant_id: tenantId, email: `r2092-${doc}-owner@example.in`, role: "owner" });
    if (u.error) throw new Error(u.error.message);
    who.userId = userId;
    who.tenantId = tenantId;
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterAll(async () => {
    if (!db) return;
    /* Best effort: issued invoices are immutable by design, so the company may stay. */
    await db.from("subscription_billings").delete().eq("tenant_id", tenantId);
    await db.from("subscriptions").delete().eq("tenant_id", tenantId);
  });

  it("Q1 paid in full (₹95,993) → ONE invoice ₹95,993 with both subscriptions' lines, paid; again → no second", async () => {
    const { quoteId, subIds } = await sale(95993);
    const out = await viaRoute(quoteId);
    expect(out.errors).toEqual([]);
    const { data: rows } = await db.from("subscription_billings").select("subscription_id, period_index, invoice_id, taxable_amount").in("subscription_id", subIds).eq("period_index", 1);
    expect(rows).toHaveLength(2);
    const invIds = [...new Set((rows ?? []).map((r) => r.invoice_id))];
    expect(invIds).toHaveLength(1);
    expect(invIds[0]).not.toBeNull();
    const { data: inv } = await db.from("invoices").select("amount, taxable_value, status, paid_amount, line_items, inter_state").eq("id", invIds[0] as string).single();
    expect(inv).toMatchObject({ amount: 95993, taxable_value: 81350, status: "paid", paid_amount: 95993, inter_state: false });
    expect((inv?.line_items as unknown[]).length).toBe(2);
    expect(out.invoices.map((i) => i.invoice_id)).toEqual(invIds);

    await viaRoute(quoteId);
    await raiseDueInstalmentsForQuote({ supabase: db as never, quoteId, tenantId, todayISO: today });   // the billing cron's path
    const { count } = await db.from("invoices").select("id", { count: "exact", head: true }).eq("customer_id", customerId).eq("amount", 95993);
    expect(count).toBe(1);
  });

  it("Q1 paid ₹60 short (₹95,933) → NO tax invoice (R-2048); owed ₹60 once", async () => {
    const { quoteId, subIds } = await sale(95933);
    const out = await viaRoute(quoteId);
    expect(out.errors).toEqual([]);
    const { data: rows } = await db.from("subscription_billings").select("invoice_id").in("subscription_id", subIds);
    expect((rows ?? []).length).toBe(8);
    expect((rows ?? []).every((r) => r.invoice_id == null)).toBe(true);
    const { data: subs } = await db.from("subscriptions").select("outstanding_amount").in("id", subIds);
    expect((subs ?? []).reduce((a, s) => a + (s.outstanding_amount ?? 0), 0)).toBe(60);
    const { data: st } = await db.rpc("split_sale_invoice_status", { p_quote_ids: [quoteId] });
    expect((st as { state: string; gross: number }[])[0]).toMatchObject({ state: "short", gross: 95993 });
  });

  /* Localhost, 29 Oct (68ed55d70): the lay-first pass for the Standard failed, its error was
     swallowed, and the Starter was invoiced alone. A dropped connection on the Standard's first
     write of its parts reproduces that order exactly. */
  async function withStandardLayDropped<T>(standardId: string, fn: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    let dropped = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!dropped && u.includes("/rest/v1/subscription_billings") && (init?.method ?? "GET").toUpperCase() === "POST"
          && typeof init?.body === "string" && init.body.includes(standardId)) {
        dropped = true;
        throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
      }
      return real(input, init);
    }) as typeof fetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  }

  async function standardOf(subIds: string[]) {
    const { data } = await db.from("subscriptions").select("id").in("id", subIds).ilike("plan", "%Standard%").single();
    return data!.id as string;
  }

  it("the Standard's lay fails (dropped connection) → the error is REPORTED and the Starter is never invoiced alone", async () => {
    const { quoteId, subIds } = await sale(95993);
    const out = await withStandardLayDropped(await standardOf(subIds), () => viaRoute(quoteId));
    expect(out.errors.map((e) => e.message).join(" ")).toMatch(/Laying the parts failed/);
    const { data: rows } = await db.from("subscription_billings").select("subscription_id, invoice_id").in("subscription_id", subIds).eq("period_index", 1);
    const invIds = [...new Set((rows ?? []).map((r) => r.invoice_id))];
    expect(rows).toHaveLength(2);
    expect(invIds).toHaveLength(1);          // both parts on the SAME invoice (or, if none, both null)
    const { data: inv } = await db.from("invoices").select("amount, status, line_items").eq("id", invIds[0] as string).single();
    expect(inv).toMatchObject({ amount: 95993, status: "paid" });
    expect((inv?.line_items as unknown[]).length).toBe(2);
  });

  it("…and ₹60 short with the Standard's lay failing → no tax invoice at all (R-2048)", async () => {
    const { quoteId, subIds } = await sale(95933);
    await withStandardLayDropped(await standardOf(subIds), () => viaRoute(quoteId));
    const { data: rows } = await db.from("subscription_billings").select("invoice_id").in("subscription_id", subIds);
    expect((rows ?? []).every((r) => r.invoice_id == null)).toBe(true);
  });
});
