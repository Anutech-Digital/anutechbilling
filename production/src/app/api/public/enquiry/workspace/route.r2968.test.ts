/**
 * R-2968 (20 Nov 2026): the GST quote request ("requestQuote" on the buy page) had the same gap as
 * the trial — every press made a new lead + owner alert + customer email (+ draft quote). Now the
 * SAME request (same mobile / email, plan, seats, price) within 24 h joins the first one; a changed
 * request (other seats) is a new quote, so it still makes a new lead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Lead = Record<string, unknown> & { id: string; notes: string };
const db = vi.hoisted(() => ({
  leads: [] as Lead[],
  rawLeadInserts: 0,
  alerts: 0,
  emails: 0,
  lastArgs: null as null | { p_match_offer: boolean; p_window_hours: number },
}));
const norm = (p: unknown) => String(p ?? "").replace(/\D/g, "").slice(-10);

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async () => { if (table === "leads") db.rawLeadInserts++; return { error: null }; },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc: async (fn: string, args: { p_tenant: string; p_row: Record<string, unknown>; p_window_hours: number; p_match_offer: boolean }) => {
      if (fn !== "website_lead_once") return { data: null, error: { message: `no ${fn} in this test` } };
      db.lastArgs = args;
      const row = args.p_row;
      const hit = db.leads.find((l) => l.tenant_id === args.p_tenant && l.source === row.source
        && (norm(l.contact_phone) === norm(row.contact_phone) || l.contact_email === row.contact_email)
        && (!args.p_match_offer || (l.plan === row.plan && l.seats === row.seats && l.value === row.value)));
      if (hit) { hit.notes += "\nAsked again 20 Nov 2026, 18:01 IST"; return { data: { action: "joined", lead_id: hit.id, note: "Asked again" }, error: null }; }
      db.leads.push({ ...row, tenant_id: args.p_tenant } as Lead);
      return { data: { action: "created", lead_id: row.id }, error: null };
    },
  }),
}));
vi.mock("@/lib/website-tenant", () => ({
  websiteTenantId: () => "00000000-0000-0000-0000-000000002968",
  websiteTenantMissingBody: () => ({ error: "no tenant" }),
}));
vi.mock("@/lib/pricing/workspace", async (orig) => ({
  ...(await orig<typeof import("@/lib/pricing/workspace")>()),
  fetchWorkspaceCatalogPrice: async () => null, // no catalogue row → no draft quote in this test
}));
vi.mock("@/lib/consent/marketing-consent.server", () => ({ recordFormConsent: async () => true }));
vi.mock("@/lib/notifications/notify.server", () => ({ notifyTenantOwners: async () => { db.alerts++; } }));
vi.mock("@/lib/email/owner-alert.server", () => ({
  loadOwnerAlert: async () => ({ alert: { ok: true, to: "owner@example.invalid", ownerName: "Owner" }, tenant: null }),
}));
vi.mock("@/lib/messaging", () => ({
  sendCustomerEmail: async () => { db.emails++; return { status: "sent" }; },
  sendInternalEmail: async () => { db.emails++; return { status: "sent" }; },
}));

const ENV = { ...process.env };
let POST: (r: NextRequest) => Promise<Response>;
async function post(body: Record<string, unknown>) {
  return POST(new NextRequest("https://example.invalid/api/public/enquiry/workspace", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}
const BASE = { fullName: "Ravi Kumar", companyName: "Ravi Traders", email: "ravi@example.invalid", phone: "+919876543210", seats: 10, tierId: "standard", billing: "annual" };

beforeEach(async () => {
  delete process.env.TURNSTILE_SECRET_KEY;
  db.leads = []; db.rawLeadInserts = 0; db.alerts = 0; db.emails = 0; db.lastArgs = null;
  vi.resetModules();
  ({ POST } = await import("./route"));
}, 60_000);
afterEach(() => { process.env = { ...ENV }; });

describe("R-2968 quote request asked again joins the first request", { timeout: 60_000 }, () => {
  it("the same request twice → ONE lead, 'Asked again', owner alert + emails only once", async () => {
    const first = await (await post(BASE)).json();
    expect(first).toMatchObject({ success: true });
    const emailsAfterFirst = db.emails;
    const second = await (await post({ ...BASE, phone: "98765 43210" })).json();
    expect(second).toMatchObject({ success: true, alreadyRequested: true, leadId: first.leadId });
    expect(db.leads).toHaveLength(1);
    expect(db.rawLeadInserts).toBe(0);
    expect(db.leads[0].notes).toContain("Asked again");
    expect(db.alerts).toBe(1);
    expect(db.emails).toBe(emailsAfterFirst);
    expect(db.lastArgs).toMatchObject({ p_match_offer: true, p_window_hours: 24 });
  });

  it("other seats → a new quote request, a new lead and its own alert", async () => {
    await post(BASE);
    const r = await (await post({ ...BASE, seats: 12 })).json();
    expect(r.alreadyRequested).toBeUndefined();
    expect(db.leads).toHaveLength(2);
    expect(db.alerts).toBe(2);
  });
});
