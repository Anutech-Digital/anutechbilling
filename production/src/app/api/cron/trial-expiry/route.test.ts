/**
 * R-065 — the trial-expiry cron mails the CUSTOMER only, never the owner.
 *
 * Owner (30 Sep 2026): "Every trial you test also sends a real owner alert to
 * pardeep@anutech.in. Remove this feature completely." The other trial owner mails
 * went in fbfb6ba9; this cron's "Trial expired" alert (kind trial_expiry_owner) was the
 * last one. Pinned here: an expired trial is stamped, its customer gets the "we miss
 * you" mail with the owner as replyTo, and no sendEmail ever goes to the owner.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";

const db = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("@/lib/ops/fake-postgrest.testutil").fakePostgrest> }));
const sent = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current!.client }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (args: Record<string, unknown>) => { sent.calls.push(args); return { status: "sent" }; }),
  isEmailConfigured: () => false,
}));

import { GET } from "./route";

const OWNER = "owner@reseller.test";
const req = () => new Request("https://example.invalid/api/cron/trial-expiry", { headers: { authorization: "Bearer s3cret" } });
const ENV = { ...process.env };

function seed() {
  return {
    leads: [
      { id: "L-ws", tenant_id: "T1", stage: "trial", company: "Acme", contact_name: "Ravi Kumar", contact_email: "ravi@acme.test",
        contact_phone: "9999999999", plan: "starter", domain: "acme.test", source: "buy-workspace-trial",
        trial_expires_at: "2026-10-01T00:00:00Z", trial_started_at: "2026-09-17T00:00:00Z", trial_converted_at: null, trial_expired_at: null },
      { id: "L-host", tenant_id: "T1", stage: "trial", company: "Beta", contact_name: "Sita", contact_email: "sita@beta.test",
        contact_phone: null, plan: null, domain: "beta.test", source: "buy-hosting-trial",
        trial_expires_at: "2026-10-02T00:00:00Z", trial_started_at: "2026-09-18T00:00:00Z", trial_converted_at: null, trial_expired_at: null },
      { id: "L-noemail", tenant_id: "T1", stage: "trial", company: "Gamma", contact_name: null, contact_email: null,
        contact_phone: null, plan: null, domain: null, source: null,
        trial_expires_at: "2026-10-03T00:00:00Z", trial_started_at: null, trial_converted_at: null, trial_expired_at: null },
    ],
    tenants: [{ id: "T1", name: "Reseller One", email: OWNER, phone: null, contact_name: "Owner" }],
  };
}

beforeEach(() => { process.env.CRON_SECRET = "s3cret"; sent.calls = []; });
afterEach(() => { process.env = { ...ENV }; });

describe("trial-expiry cron (R-065)", () => {
  it("sends the owner nothing — no trial_expiry_owner mail, nothing addressed to the owner", async () => {
    db.current = fakePostgrest(seed());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(sent.calls.filter((c) => c.kind === "trial_expiry_owner")).toEqual([]);
    expect(sent.calls.filter((c) => c.to === OWNER)).toEqual([]);
  });

  it("still sends each customer with an email the 'trial ended' mail, replies going to the owner", async () => {
    db.current = fakePostgrest(seed());
    const body = await (await GET(req())).json();
    expect(sent.calls.map((c) => c.to).sort()).toEqual(["ravi@acme.test", "sita@beta.test"]);
    for (const c of sent.calls) {
      expect(c.kind).toBe("trial_expiry_customer");
      expect(c.replyTo).toBe(OWNER);
    }
    expect(body.total_expired).toBe(3);
    expect(body.emails_sent).toBe(2);
  });

  it("still stamps every expired trial", async () => {
    db.current = fakePostgrest(seed());
    await GET(req());
    const stamps = db.current.calls.filter((c) => c.table === "leads" && c.op === "update");
    expect(stamps).toHaveLength(3);
  });
});

describe("trial-expiry cron — trials started from an accepted quote (R-282)", () => {
  /* Pardeep (6 Oct): a quote-trial ends with a REMINDER TASK for the owner only — no automatic
     message to the customer, no suspension. The "trial ended, reply to convert" mail is for
     self-serve trials; a customer who has already accepted a quote is chased by a person. */
  function withQuote(status: string) {
    const s = seed();
    return { ...s, quotes: [{ id: "Q-1", tenant_id: "T1", lead_id: "L-ws", status }] };
  }

  it("does not mail the customer whose trial came from an accepted quote — but still stamps it", async () => {
    db.current = fakePostgrest(withQuote("accepted"));
    const body = await (await GET(req())).json();
    expect(sent.calls.map((c) => c.to)).toEqual(["sita@beta.test"]);
    expect(body.total_expired).toBe(3);
  });

  it("a lead whose quote is only sent/draft keeps the normal mail", async () => {
    db.current = fakePostgrest(withQuote("sent"));
    await GET(req());
    expect(sent.calls.map((c) => c.to).sort()).toEqual(["ravi@acme.test", "sita@beta.test"]);
  });
});
