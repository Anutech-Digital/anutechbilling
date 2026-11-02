/**
 * POST /api/public/callback — R-2011 (DPDP): the call-back forms (home page, ad landing page)
 * record the data notice + marketing opt-in for the new lead in consent_events. Ticked →
 * 'granted', left empty → 'denied'; a page that sends no consent field (old cached page) still
 * works exactly as before and records nothing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ inserts: [] as Array<{ table: string; row: Record<string, unknown> }> }));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => { db.inserts.push({ table, row }); return { error: null }; },
    }),
  }),
}));
vi.mock("@/lib/website-tenant", () => ({ websiteTenantId: () => "T-SITE", websiteTenantMissingBody: () => ({ error: "x" }) }));
vi.mock("@/lib/security/turnstile-guard", () => ({ turnstileRefusal: async () => null }));
vi.mock("@/lib/notifications/notify.server", () => ({ notifyTenantOwners: async () => {} }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: async () => ({ alert: { ok: false, reason: "test" } }) }));
vi.mock("@/lib/messaging", () => ({ sendInternalEmail: vi.fn() }));

import { POST } from "./route";

let n = 0;
const call = (b: Record<string, unknown>) =>
  POST(new NextRequest("https://example.invalid/api/public/callback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}` },
    body: JSON.stringify(b),
  }));
const base = (phone: string) => ({ fullName: "Rajesh Kumar", phone, product: "custom-software", pageUrl: "https://anutech.in/" });

beforeEach(() => { db.inserts = []; });

describe("call-back form records the marketing opt-in (R-2011)", () => {
  it("ticked → lead + a 'granted' marketing row for that lead", async () => {
    const res = await call({ ...base("9810000011"), consent: { form: "callback", noticeVersion: "2026-11-01", marketing: true } });
    expect(res.status).toBe(200);
    const lead = db.inserts.find((i) => i.table === "leads")!.row;
    const c = db.inserts.find((i) => i.table === "consent_events")!.row;
    expect(c).toMatchObject({ tenant_id: "T-SITE", lead_id: lead.id, purpose: "marketing", choice: "granted", source: "form", form: "callback", notice_version: "2026-11-01", page: "/" });
  });

  it("left empty → a 'denied' row (notice shown, no offers)", async () => {
    await call({ ...base("9810000012"), consent: { form: "ad_callback", noticeVersion: "2026-11-01", marketing: false } });
    expect(db.inserts.find((i) => i.table === "consent_events")!.row).toMatchObject({ choice: "denied", form: "ad_callback" });
  });

  it("no consent field → the lead is saved exactly as before, nothing recorded", async () => {
    const res = await call(base("9810000013"));
    expect(res.status).toBe(200);
    expect(db.inserts.map((i) => i.table)).toEqual(["leads"]);
  });
});
