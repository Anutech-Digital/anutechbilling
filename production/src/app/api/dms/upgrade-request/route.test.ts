/**
 * POST /api/dms/upgrade-request (owner decision, 25 Sep 2026: DMS takes no payment for an
 * upgrade). Pinned: only DMS's key gets in; the request becomes ONE lead carrying DMS's
 * figure as an estimate, not a price; asking twice returns the same lead; the owner is told,
 * and a failed alert does not undo the request.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => ({ existing: null as unknown, findError: null as unknown, inserts: [] as Record<string, unknown>[], insertError: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = async () => ({ data: db.existing, error: db.findError });
    return {
      from: () => ({
        ...chain,
        insert: async (row: Record<string, unknown>) => { db.inserts.push(row); return { error: db.insertError }; },
      }),
    };
  },
}));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(), loadOwnerAlert: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert: mail.loadOwnerAlert }));

import { POST } from "./route";
/* R-1499: outside production the website tenant is never implied any more — name it, as a
   deployment does. (The fixture is the same id the routes used to fall back to.) */
process.env.BUY_PAGE_TENANT_ID ||= "fbb976f1-9090-4f10-9726-0901bd144e42";

const KEY = "panel-key-0123456789abcdef";
const body = {
  dmsUserId: "665f0c0ffee", email: "Asha@Example.invalid", fullName: "Asha Verma", phone: "9876543210",
  domain: "AshaCo.in", currentPlan: "Starter", targetPlan: "Standard", estimateRupees: 1234, expiresAt: "2027-01-10",
};
const req = (b: unknown, key: string | null = KEY) =>
  new NextRequest("https://app.example.invalid/api/dms/upgrade-request", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof b === "string" ? b : JSON.stringify(b),
  });

const ENV = { ...process.env };
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.invalid"); // R-723: links come from the app URL
  db.existing = null; db.findError = null; db.inserts = []; db.insertError = null;
  mail.sendEmail.mockReset().mockResolvedValue({ status: "sent" });
  mail.loadOwnerAlert.mockReset().mockResolvedValue({ alert: { ok: true, to: "owner@example.invalid", ownerName: "Owner" } });
  process.env.DMS_PANEL_API_KEY = KEY;
});
afterEach(() => { process.env = { ...ENV }; });

describe("only DMS gets in", () => {
  it("no key here → 503; wrong key → 401; nothing recorded", async () => {
    expect((await POST(req(body, "wrong-key-0123456789abcdef"))).status).toBe(401);
    process.env.DMS_PANEL_API_KEY = "";
    expect((await POST(req(body))).status).toBe(503);
    expect(db.inserts).toHaveLength(0);
  });
});

describe("the request", () => {
  it("becomes one lead, with DMS's figure as an estimate to check — not a price", async () => {
    const res = await POST(req(body));
    expect(await res.json()).toMatchObject({ success: true, alreadyRequested: false });
    expect(db.inserts).toHaveLength(1);
    const lead = db.inserts[0];
    expect(lead).toMatchObject({ source: "dms-upgrade-request", domain: "ashaco.in", plan: "hosting-upgrade-standard", contact_email: "asha@example.invalid", stage: "new" });
    expect(lead).not.toHaveProperty("value");
    expect(String(lead.notes)).toMatch(/₹1,234 incl\. GST.*ESTIMATE to check, not a price/);
    expect(String(lead.notes)).toContain("DMS account 665f0c0ffee");
  });
  it("asking twice returns the open request, no second lead, no second alert", async () => {
    db.existing = { id: "L-OPEN" };
    expect(await (await POST(req(body))).json()).toMatchObject({ leadId: "L-OPEN", alreadyRequested: true });
    expect(db.inserts).toHaveLength(0);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });
  it("the owner is told, with a lead link on this app's own origin", async () => {
    await POST(req(body));
    const msg = mail.sendEmail.mock.calls[0][0];
    expect(msg.to).toBe("owner@example.invalid");
    expect(msg.text).toContain("https://app.example.invalid/leads/L-");
  });
  it("a failed alert does not undo the request", async () => {
    mail.sendEmail.mockRejectedValue(new Error("smtp down"));
    expect((await POST(req(body))).status).toBe(200);
    expect(db.inserts).toHaveLength(1);
  });
  it("a database error is a 500 that says nothing was charged — never a quiet success", async () => {
    db.findError = { message: "boom" };
    const res = await POST(req(body));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Nothing was charged/);
  });
  it("bad input → 400, nothing recorded", async () => {
    expect((await POST(req({ ...body, domain: "x" }))).status).toBe(400);
    expect((await POST(req("{nope"))).status).toBe(400);
    expect(db.inserts).toHaveLength(0);
  });
});
