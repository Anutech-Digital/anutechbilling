/**
 * R-220: the morning run emails ONE person — the first owner — with that owner's tenant's
 * four numbers, even when the production logs cannot be read. No real email: sendEmail is
 * mocked; the DB is lib/ops/fake-postgrest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";

const db = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("@/lib/ops/fake-postgrest.testutil").fakePostgrest> }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current!.client }));
const sendEmail = vi.hoisted(() => vi.fn(async (_msg: { to: string; subject: string; text: string }) => ({ status: "sent", providerId: "x", errorMessage: null })));
vi.mock("@/lib/email/send", () => ({ sendEmail }));
const session = vi.hoisted(() => ({ me: null as null | { email: string; user: { role: string; tenant_id: string } } }));
vi.mock("@/lib/tenant", () => ({ getCurrentUser: async () => session.me }));

import { GET } from "./route";

const ENV = { ...process.env };
const req = () => new Request("https://example.invalid/api/cron/health-digest", { headers: { authorization: "Bearer s3cret" } });

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-07T02:30:00Z")); // 08:00 IST
  /* No metadata server off Cloud Run: logs unreadable, the business digest must still go. */
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no metadata server"); }));
  sendEmail.mockClear();
});
afterEach(() => {
  process.env = { ...ENV };
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function seed() {
  return fakePostgrest({
    users: [
      { id: "u2", email: "second-owner@t1.test", role: "owner", tenant_id: "T1", created_at: "2026-02-01T00:00:00Z" },
      { id: "u1", email: "owner@t1.test", role: "owner", tenant_id: "T1", created_at: "2026-01-01T00:00:00Z" },
      { id: "u3", email: "sales@t1.test", role: "sales", tenant_id: "T1", created_at: "2025-01-01T00:00:00Z" },
    ],
    payments: [
      { id: "p1", tenant_id: "T1", status: "received", amount: 11800, received_at: "2026-10-06T05:00:00Z" },
      { id: "p2", tenant_id: "T2", status: "received", amount: 99999, received_at: "2026-10-06T05:00:00Z" }, // other tenant
    ],
    project_payments: [{ id: "pp1", tenant_id: "T1", amount: 50000, received_at: "2026-10-06" }],
    invoices: [
      { id: "i1", tenant_id: "T1", status: "pending", due_date: "2026-09-30", amount: 23600, paid_amount: 0 },
      { id: "i2", tenant_id: "T2", status: "pending", due_date: "2026-09-30", amount: 777, paid_amount: 0 },
    ],
    ai_action_log: [
      { id: 1, tenant_id: "T1", outcome: "held", reason: "Reply to Acme held", created_at: "2026-10-06T04:00:00Z" },
      { id: 2, tenant_id: "T1", outcome: "did", reason: "Sent", created_at: "2026-10-06T04:00:00Z" },
    ],
    quotes: [
      { id: "q1", tenant_id: "T1", approval_status: "pending" },
      { id: "q2", tenant_id: "T2", approval_status: "pending" },
    ],
    subscriptions: [
      { id: "s1", tenant_id: "T1", status: "active", renewal_date: "2026-10-20", mrr: 1650 },
      { id: "s2", tenant_id: "T2", status: "active", renewal_date: "2026-10-20", mrr: 8000 },
    ],
  });
}

describe("R-220 health-digest route: owner morning digest", () => {
  it("emails only the first owner, with their tenant's four numbers", async () => {
    db.current = seed();
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const msg = sendEmail.mock.calls[0][0];
    expect(msg.to).toBe("owner@t1.test");

    expect(body.owner_digest).toMatchObject({
      day: "2026-10-06",
      moneyIn: { count: 2, value: 61800 },
      overdue: { count: 1, value: 23600 },
      waiting: { held: 1, quotes: 1, total: 2 },
      renewals: { count: 1, value: 1650 },
    });
    expect(msg.subject).toBe("ResellerOS morning: ₹61,800 in, 1 overdue, 2 waiting on you");
    expect(msg.text).toContain("Money in yesterday: ₹61,800");
    expect(msg.text).toContain("Logs were not read");
    expect(msg.text).not.toContain("99,999");
  });

  it("every business read is limited to the owner's tenant", async () => {
    db.current = seed();
    await GET(req());
    const reads = db.current.calls.filter((c) => c.table !== "users");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((c) => c.filters.includes("tenant_id=T1"))).toBe(true);
  });

  it("rejects a wrong secret and sends nothing", async () => {
    db.current = seed();
    const res = await GET(new Request("https://example.invalid/api/cron/health-digest", { headers: { authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("R-112 health-digest ?dryRun=1: preview, never send", () => {
  const dry = (q = "", auth?: string) => new Request(`https://example.invalid/api/cron/health-digest?dryRun=1${q}`,
    auth ? { headers: { authorization: auth } } : undefined);

  it("cron secret: returns the first owner's numbers + mail body, sends nothing, reads no logs", async () => {
    db.current = seed();
    const res = await GET(dry("", "Bearer s3cret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, dryRun: true, emailed: false, to: "owner@t1.test" });
    expect(body.owner_digest).toMatchObject({ moneyIn: { count: 2, value: 61800 }, overdue: { count: 1, value: 23600 } });
    expect(body.email.subject).toBe("ResellerOS morning: ₹61,800 in, 1 overdue, 2 waiting on you");
    expect(body.email.text).toContain("Money in yesterday: ₹61,800");
    expect(body.email.html).toContain("₹61,800");
    expect(body.email.html).not.toContain("99,999");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled(); // no Cloud Logging read, no heartbeat ping
  });

  it("format=html returns the mail as a page", async () => {
    db.current = seed();
    const res = await GET(dry("&format=html", "Bearer s3cret"));
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Overdue invoices");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("logged-in owner without the secret sees their own tenant", async () => {
    db.current = seed();
    session.me = { email: "boss@t2.test", user: { role: "owner", tenant_id: "T2" } };
    const body = await (await GET(dry())).json();
    expect(body).toMatchObject({ dryRun: true, emailed: false, to: "boss@t2.test" });
    expect(body.owner_digest.moneyIn.value).toBe(99999);
    const reads = db.current.calls.filter((c) => c.table !== "users");
    expect(reads.every((c) => c.filters.includes("tenant_id=T2"))).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("non-owner gets 403, anonymous 401, wrong secret 401 — and nothing is sent", async () => {
    db.current = seed();
    session.me = { email: "sales@t1.test", user: { role: "sales", tenant_id: "T1" } };
    expect((await GET(dry())).status).toBe(403);
    session.me = null;
    expect((await GET(dry())).status).toBe(401);
    expect((await GET(dry("", "Bearer nope"))).status).toBe(401);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
