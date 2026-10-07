/**
 * R-325 — the compliance reminder cron reads each tenant's business type + GST mode (R-262).
 *
 * Before: the cron built every tenant's list from the Pvt Ltd catalog, so a proprietor was
 * mailed about AOC-4 / MGT-7. Pinned:
 *   - a proprietor gets no ROC reminder; a tenant with no profile still gets AOC-4, as before;
 *   - before the business_type / gst_filing columns exist (42703), the run falls back to the
 *     old list instead of failing.
 * Every run here is `dry=1` and email is mocked — nothing is sent, nothing is logged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";

const db = vi.hoisted(() => ({ current: null as null | { from: (t: string) => unknown } }));
const sendEmail = vi.hoisted(() => vi.fn(async () => ({ id: "never" })));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current! }));
vi.mock("@/lib/email/send", () => ({ sendEmail, isEmailConfigured: () => false }));
vi.mock("@/lib/ops/heartbeat", () => ({ pingHeartbeat: vi.fn() }));

import { GET } from "./route";

/* 22 Oct 2026: AOC-4 (due 29 Oct) is on its T-7 rung. */
const req = () => new Request(
  "https://example.invalid/api/cron/compliance-reminders?dry=1&on=2026-10-22",
  { headers: { authorization: "Bearer s3cret" } },
);
const ENV = { ...process.env };

function seed(tenants: Record<string, unknown>[]) {
  return {
    tenants,
    users: tenants.map((t, i) => ({ tenant_id: t.id, email: `owner${i}@example.invalid`, role: "owner", is_active: true })),
    compliance_log: [],
    compliance_reminder_log: [],
    salary_payments: [],
    expenses: [],
  };
}

type Detail = { tenant: string; obligation: string };
const obligationsOf = (details: Detail[], tenant: string) =>
  details.filter((d) => d.tenant === tenant).map((d) => d.obligation);

beforeEach(() => { process.env.CRON_SECRET = "s3cret"; delete process.env.HEARTBEAT_PING_URL; sendEmail.mockClear(); });
afterEach(() => { process.env = { ...ENV }; });

describe("compliance-reminders cron reads the business profile (R-325)", () => {
  it("a proprietor gets no ROC reminder; an unknown profile still gets AOC-4", async () => {
    db.current = fakePostgrest(seed([
      { id: "T-prop", name: "Prop", business_type: "proprietor", gst_filing: "monthly" },
      { id: "T-unknown", name: "Unknown", business_type: null, gst_filing: null },
    ])).client;
    const body = await (await GET(req())).json();
    expect(body.errors).toEqual([]);
    const prop = obligationsOf(body.details, "Prop");
    expect(prop.filter((k) => k.startsWith("roc_"))).toEqual([]);
    expect(obligationsOf(body.details, "Unknown")).toContain("roc_aoc4");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("falls back to the old list when the profile columns do not exist yet", async () => {
    const fake = fakePostgrest(seed([{ id: "T-old", name: "Old" }]));
    /* A real PostgREST answers 42703 for a SELECT that names a missing column. */
    db.current = {
      from: (t: string) => {
        const b = fake.client.from(t) as { select: (c?: string) => unknown };
        if (t !== "tenants") return b;
        const select = b.select.bind(b);
        b.select = (cols?: string) => {
          if (cols?.includes("business_type")) {
            const failing = {
              order: () => failing,
              range: () => failing,
              then: (ok: (v: unknown) => unknown) =>
                Promise.resolve({ data: null, error: { code: "42703", message: "column tenants.business_type does not exist" } }).then(ok),
            };
            return failing;
          }
          return select(cols);
        };
        return b;
      },
    };
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenants).toBe(1);
    expect(obligationsOf(body.details, "Old")).toContain("roc_aoc4");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
