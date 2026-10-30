/**
 * R-2176 (GP-10c, G-PERSONAL) — a PERSONAL user's Help → Report a problem becomes a ticket on
 * Anutech's support desk (their free support plan), never a `feedback` row.
 *
 * The owner's real path: a free personal login hits a problem on /vault/personal, opens Help →
 * Report a problem, types what happened and presses Submit. Before R-2176 that inserted into
 * `feedback` (a business table the personal data gateway refuses, R-2125) — the report was lost
 * and the server logged gateway_refused. Now the words land as a support_tickets row in the
 * company the person is a customer of (personal_identity_link, R-2118), on the 'app' channel,
 * for their linked customer — the same desk, SLA stamp (free tier) and staff notification as a
 * support@ mail.
 */
import { describe, it, expect } from "vitest";
import {
  ticketFieldsFromReport,
  filePersonalSupportTicket,
  PERSONAL_REPORT_HOURLY_CAP,
  type PersonalReportDb,
} from "./personal-report";

const USER = "11111111-1111-4111-8111-111111111111";
const PERSONAL_TENANT = "22222222-2222-4222-8222-222222222222";
const SELLER = "33333333-3333-4333-8333-333333333333";
const CUSTOMER = "44444444-4444-4444-8444-444444444444";

interface Fake {
  fullName: string | null;
  link: Record<string, unknown> | null;
  recent: number;
  insertError: string | null;
  inserted: Record<string, unknown>[];
  reads: string[];
}

function fakeDb(f: Fake): PersonalReportDb {
  return {
    from(table: string) {
      f.reads.push(table);
      if (table === "personal_identity_link") {
        return {
          select: () => ({ eq: (col: string, v: string) => ({
            maybeSingle: async () => ({ data: col === "auth_user_id" && v === USER ? f.link : null, error: null }),
          }) }),
        } as never;
      }
      if (table === "support_tickets") {
        return {
          select: () => ({ eq: (c1: string, v1: string) => ({ eq: (c2: string, v2: string) => ({ eq: (c3: string, v3: string) => ({
            gte: async () => ({
              count: c1 === "tenant_id" && v1 === SELLER && c2 === "raised_by_user" && v2 === USER && c3 === "channel" && v3 === "app" ? f.recent : 0,
              error: null,
            }),
          }) }) }) }),
          insert: async (row: Record<string, unknown>) => {
            if (f.insertError) return { error: { message: f.insertError } };
            f.inserted.push(row);
            return { error: null };
          },
        } as never;
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function fresh(over: Partial<Fake> = {}): Fake {
  return {
    fullName: "Asha Rao",
    link: {
      personal_tenant_id: PERSONAL_TENANT,
      seller_tenant_id: SELLER,
      anutech_customer_id: CUSTOMER,
      email: "asha@example.test",
      link_status: "linked",
    },
    recent: 0,
    insertError: null,
    inserted: [],
    reads: [],
    ...over,
  };
}

const REPORT = { type: "bug" as const, severity: "medium" as const, text: "Bank balance shows 0\n\nI added a statement and the tile still says 0.", pagePath: "/vault/personal/banking" };

describe("ticketFieldsFromReport", () => {
  it("first line is the subject; kind and severity map onto the desk's own vocabulary", () => {
    expect(ticketFieldsFromReport(REPORT)).toEqual({ subject: "Bank balance shows 0", category: "tech", priority: "normal" });
    expect(ticketFieldsFromReport({ ...REPORT, type: "feature", severity: "low" })).toMatchObject({ category: "feature", priority: "low" });
    expect(ticketFieldsFromReport({ ...REPORT, type: "ui_improvement", severity: "high" })).toMatchObject({ category: "tech", priority: "high" });
    expect(ticketFieldsFromReport({ ...REPORT, severity: "critical" })).toMatchObject({ priority: "urgent" });
  });
  it("a long first line is cut to 120 characters", () => {
    const s = ticketFieldsFromReport({ ...REPORT, text: "x".repeat(300) }).subject;
    expect(s.length).toBe(120);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("filePersonalSupportTicket (R-2176)", () => {
  it("a linked personal user gets ONE support ticket in the seller company, for their customer, on the app channel — and no feedback row", async () => {
    const f = fresh();
    const r = await filePersonalSupportTicket(fakeDb(f), USER, f.fullName, REPORT);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error("expected ok");
    expect(r.ticketId).toMatch(/^TKT-[0-9A-Z]+-[0-9A-F]{2}$/);
    expect(f.inserted).toHaveLength(1);
    expect(f.inserted[0]).toMatchObject({
      id: r.ticketId,
      tenant_id: SELLER,
      customer_id: CUSTOMER,
      customer_name: "Asha Rao",
      raised_by_email: "asha@example.test",
      raised_by_user: USER,
      channel: "app",
      category: "tech",
      priority: "normal",
      status: "open",
      subject: "Bank balance shows 0",
    });
    expect(String(f.inserted[0].body)).toContain("I added a statement");
    expect(String(f.inserted[0].body)).toContain("/vault/personal/banking");
    /* tier / sla_due_at are left to the INSERT trigger (stamp_support_ticket_sla): no support plan = free. */
    expect(f.inserted[0]).not.toHaveProperty("tier");
    expect(f.reads).not.toContain("feedback");
  });

  it("an email whose link is waiting on a decision (no customer yet) still files, with no customer attached", async () => {
    const f = fresh({ link: { ...fresh().link!, anutech_customer_id: null, link_status: "needs_decision" } });
    const r = await filePersonalSupportTicket(fakeDb(f), USER, f.fullName, REPORT);
    expect(r.ok).toBe(true);
    expect(f.inserted[0]).toMatchObject({ customer_id: null, tenant_id: SELLER });
  });

  it("no full name → the verified email is the name on the ticket", async () => {
    const f = fresh({ fullName: "  " });
    await filePersonalSupportTicket(fakeDb(f), USER, f.fullName, REPORT);
    expect(f.inserted[0].customer_name).toBe("asha@example.test");
  });

  it("not linked to the support desk yet (e.g. email not confirmed, or a local test user) → honest refusal, nothing written", async () => {
    const f = fresh({ link: null });
    const r = await filePersonalSupportTicket(fakeDb(f), USER, f.fullName, REPORT);
    expect(r).toMatchObject({ ok: false, code: "NOT_LINKED", status: 409 });
    if (r.ok) throw new Error("expected refusal");
    expect(r.error).toMatch(/NOT sent/);
    expect(f.inserted).toHaveLength(0);
  });

  it("a link with no seller company → same honest refusal", async () => {
    const f = fresh({ link: { ...fresh().link!, seller_tenant_id: null } });
    const r = await filePersonalSupportTicket(fakeDb(f), USER, f.fullName, REPORT);
    expect(r).toMatchObject({ ok: false, code: "NOT_LINKED" });
    expect(f.inserted).toHaveLength(0);
  });

  it("empty text → 400, nothing written", async () => {
    const f = fresh();
    const r = await filePersonalSupportTicket(fakeDb(f), USER, f.fullName, { ...REPORT, text: "   " });
    expect(r).toMatchObject({ ok: false, code: "EMPTY", status: 400 });
    expect(f.inserted).toHaveLength(0);
  });

  it(`more than ${PERSONAL_REPORT_HOURLY_CAP} reports in an hour → 429, nothing written`, async () => {
    const f = fresh({ recent: PERSONAL_REPORT_HOURLY_CAP });
    const r = await filePersonalSupportTicket(fakeDb(f), USER, f.fullName, REPORT);
    expect(r).toMatchObject({ ok: false, code: "TOO_MANY", status: 429 });
    expect(f.inserted).toHaveLength(0);
  });

  it("the insert fails → 500 that says the report was NOT sent", async () => {
    const f = fresh({ insertError: "boom" });
    const r = await filePersonalSupportTicket(fakeDb(f), USER, f.fullName, REPORT);
    expect(r).toMatchObject({ ok: false, code: "FAILED", status: 500 });
    if (r.ok) throw new Error("expected refusal");
    expect(r.error).toMatch(/NOT sent/);
    expect(r.error).not.toMatch(/boom/);
  });
});
