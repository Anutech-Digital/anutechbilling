/**
 * R-2968 (20 Nov 2026): "Start free trial" pressed again for the same domain / mobile / email
 * joins the first request — ONE lead, "Asked again" in its notes, the three follow-up tasks and the
 * customer email only once. Another domain → a new lead; after the 24 h window → a new lead; two
 * requests at once → one lead (the lock is in website_lead_once, proven by its SQL test; here the
 * fake RPC runs them one after the other the way the advisory lock does).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { WEBSITE_REQUEST_AGAIN_WINDOW_HOURS } from "@/lib/leads/website-request-once";

type Lead = Record<string, unknown> & { id: string; created: number; notes: string };
const db = vi.hoisted(() => ({
  leads: [] as Lead[],
  tasks: [] as Record<string, unknown>[],
  rawLeadInserts: 0,
  emails: 0,
  now: 0,
  queue: Promise.resolve() as Promise<unknown>,
}));

const norm = (p: unknown) => String(p ?? "").replace(/\D/g, "").slice(-10);
/** A stand-in for website_lead_once: same matching rule, run one at a time like the advisory lock. */
function leadOnce(args: { p_tenant: string; p_row: Record<string, unknown>; p_window_hours: number }) {
  const run = async () => {
    const row = args.p_row;
    const hit = db.leads.find((l) => l.tenant_id === args.p_tenant && l.source === row.source
      && db.now - l.created < args.p_window_hours * 3600_000
      && ((row.domain && l.domain === row.domain) || norm(l.contact_phone) === norm(row.contact_phone)
          || String(l.contact_email).toLowerCase() === String(row.contact_email).toLowerCase()));
    await new Promise((r) => setTimeout(r, 5));
    if (hit) {
      const note = `Asked again 20 Nov 2026, 18:01 IST${hit.seats !== row.seats ? ` — seats now ${row.seats} (was ${hit.seats})` : ""}`;
      hit.notes = `${hit.notes}\n${note}`;
      return { data: { action: "joined", lead_id: hit.id, note }, error: null };
    }
    db.leads.push({ ...row, tenant_id: args.p_tenant, created: db.now } as Lead);
    return { data: { action: "created", lead_id: row.id }, error: null };
  };
  const p = db.queue.then(run);
  db.queue = p.catch(() => undefined);
  return p;
}

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        if (table === "leads") db.rawLeadInserts++;
        if (table === "tasks") db.tasks.push(...(Array.isArray(rows) ? rows : [rows]));
        return { error: null };
      },
    }),
    rpc: (fn: string, args: Parameters<typeof leadOnce>[0]) => {
      if (fn !== "website_lead_once") throw new Error(`unexpected rpc ${fn}`);
      return leadOnce(args);
    },
  }),
}));
vi.mock("@/lib/website-tenant", () => ({
  websiteTenantId: () => "00000000-0000-0000-0000-000000002968",
  websiteTenantMissingBody: () => ({ error: "no tenant" }),
}));
vi.mock("@/lib/consent/marketing-consent.server", () => ({ recordFormConsent: async () => true }));
vi.mock("@/lib/email/owner-alert.server", () => ({
  loadOwnerAlert: async () => ({ alert: { ok: false, reason: "test" }, tenant: null }),
}));
vi.mock("@/lib/messaging", () => ({ sendCustomerEmail: async () => { db.emails++; return { status: "sent" }; } }));

const ENV = { ...process.env };
let POST: (r: NextRequest) => Promise<Response>;
async function post(body: Record<string, unknown>) {
  return POST(new NextRequest("https://example.invalid/api/public/trial/workspace", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}
const BASE = { fullName: "Ravi Kumar", companyName: "Ravi Traders", email: "ravi@example.invalid", phone: "+919876543210", seats: 5, domain: "ravitraders.in", tierId: "standard" };
const OTHER = { ...BASE, email: "a@acme.invalid", phone: "+919222222222", domain: "https://Acme.in/" };

beforeEach(async () => {
  delete process.env.TURNSTILE_SECRET_KEY;
  db.leads = []; db.tasks = []; db.rawLeadInserts = 0; db.emails = 0; db.now = Date.UTC(2026, 10, 20, 12, 30);
  vi.resetModules();
  ({ POST } = await import("./route"));
});
afterEach(() => { process.env = { ...ENV }; });

describe("R-2968 trial asked again joins the first request", { timeout: 60_000 }, () => {
  it("the window is 24 hours", () => {
    expect(WEBSITE_REQUEST_AGAIN_WINDOW_HOURS).toBe(24);
  });

  it("three clicks for one domain → ONE lead, 'Asked again' twice, tasks + customer email once", async () => {
    const first = await (await post(BASE)).json();
    expect(first).toMatchObject({ success: true });
    expect(first.alreadyRequested).toBeUndefined();
    db.now += 60_000;
    const second = await (await post({ ...BASE, seats: 8 })).json();
    db.now += 60_000;
    const third = await (await post({ ...BASE, phone: "98765 43210" })).json();
    expect(second).toMatchObject({ success: true, alreadyRequested: true, leadId: first.leadId });
    expect(third).toMatchObject({ success: true, alreadyRequested: true, leadId: first.leadId });
    expect(db.leads).toHaveLength(1);
    expect(db.rawLeadInserts).toBe(0); // every lead goes through website_lead_once
    expect(db.leads[0].notes.match(/Asked again/g)).toHaveLength(2);
    expect(db.leads[0].notes).toContain("seats now 8 (was 5)");
    expect(db.tasks).toHaveLength(3);
    expect(db.emails).toBe(1);
  });

  it("another domain and contact → a new lead with its own tasks", async () => {
    await post(BASE);
    const r = await (await post(OTHER)).json();
    expect(r.alreadyRequested).toBeUndefined();
    expect(db.leads.map((l) => l.domain)).toEqual(["ravitraders.in", "acme.in"]);
    expect(db.tasks).toHaveLength(6);
  });

  it("after the 24 h window → a new lead", async () => {
    await post(BASE);
    db.now += (WEBSITE_REQUEST_AGAIN_WINDOW_HOURS * 60 + 1) * 60_000;
    const r = await (await post(BASE)).json();
    expect(r.alreadyRequested).toBeUndefined();
    expect(db.leads).toHaveLength(2);
    expect(db.tasks).toHaveLength(6);
  });

  it("two clicks at the same moment → one lead, tasks once", async () => {
    const [a, b] = await Promise.all([post(BASE), post(BASE)]);
    const ja = await a.json(); const jb = await b.json();
    expect([ja.alreadyRequested, jb.alreadyRequested].filter(Boolean)).toHaveLength(1);
    expect(db.leads).toHaveLength(1);
    expect(db.tasks).toHaveLength(3);
  });
});
