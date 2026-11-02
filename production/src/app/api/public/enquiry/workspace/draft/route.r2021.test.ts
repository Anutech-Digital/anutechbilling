/**
 * R-2021 (R-2019 decision 5, G-DPDP): the phone flow's draft lead is saved ONLY with the
 * "WhatsApp me a link to finish this order" tick — resumeConsent must be literally true. Without
 * it: 400 and nothing written. With it: one lead (stage new, source buy-workspace-draft, no quote,
 * no email) whose notes record the tick, the notice version and the time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ inserts: [] as { table: string; row: Record<string, unknown> }[] }));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => { db.inserts.push({ table, row }); return { error: null }; },
    }),
    rpc: async () => { throw new Error("the draft route makes no quote"); },
  }),
}));
vi.mock("@/lib/website-tenant", () => ({
  websiteTenantId: () => "00000000-0000-0000-0000-000000002021",
  websiteTenantMissingBody: () => ({ error: "no tenant" }),
}));

const ENV = { ...process.env };
async function post(body: Record<string, unknown>) {
  delete process.env.TURNSTILE_SECRET_KEY;
  vi.resetModules();
  const { POST } = await import("./route");
  return POST(new NextRequest("https://example.invalid/api/public/enquiry/workspace/draft", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}
const BASE = { fullName: "Ravi Kumar", phone: "+919876543210", email: "ravi@example.invalid", seats: 10, tierId: "standard", billing: "annual" };

beforeEach(() => { db.inserts = []; });
afterEach(() => { process.env = { ...ENV }; });

describe("R-2021 draft lead — only with the WhatsApp tick", { timeout: 60_000 }, () => {
  it("no tick (missing, false, 'true', 1) → 400 and NOTHING is written", async () => {
    for (const resumeConsent of [undefined, false, "true", 1]) {
      const res = await post({ ...BASE, resumeConsent });
      expect(res.status, String(resumeConsent)).toBe(400);
      expect((await res.json()).error).toMatch(/not ticked/);
    }
    expect(db.inserts).toEqual([]);
  });

  it("ticked → ONE draft lead, no quote; the notes record the tick, notice version and time", async () => {
    const res = await post({ ...BASE, resumeConsent: true, domain: "ravitraders.in", intent: "new", domainMode: "have", migrationSource: "zoho" });
    expect(res.status).toBe(200);
    expect(db.inserts.map((i) => i.table)).toEqual(["leads"]);
    const lead = db.inserts[0].row;
    expect(lead).toMatchObject({ stage: "new", source: "buy-workspace-draft", contact_name: "Ravi Kumar", contact_phone: "+919876543210", seats: 10, value: 0, plan: "google-workspace-standard", domain: "ravitraders.in" });
    expect(String(lead.notes)).toMatch(/The buyer ticked "WhatsApp me a link to finish this order" \(data notice \d{4}-\d{2}-\d{2}, \d{4}-\d{2}-\d{2}T/);
    expect(String(lead.notes)).toContain("not an order yet");
    expect(String(lead.notes)).toContain("Email today: Zoho Mail");
  });

  it("only the two sold plans; a bad phone or name is refused before anything is written", async () => {
    for (const bad of [{ tierId: "plus" }, { phone: "123" }, { fullName: "R" }]) {
      const res = await post({ ...BASE, resumeConsent: true, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(db.inserts).toEqual([]);
  });
});
