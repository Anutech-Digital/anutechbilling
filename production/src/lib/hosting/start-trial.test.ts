import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/marketing/utm", () => ({ captureFromRequest: () => ({}) }));
const sendEmail = vi.hoisted(() => vi.fn());
const loadOwnerAlert = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/send", () => ({ sendEmail }));
vi.mock("@/lib/email/owner-alert.server", () => ({ loadOwnerAlert }));

const checkTrialHistory = vi.hoisted(() => vi.fn());
const recordTrialInDms = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dms-engine/trials", () => ({ checkTrialHistory, recordTrialInDms }));

import { startHostingTrial, likeEscape, quoteForOr, repeatTrialsAllowed } from "./start-trial";

type Admin = Parameters<typeof startHostingTrial>[0];

interface Fake {
  prior?: { id: string; created_at: string }[];
  priorError?: { message: string } | null;
  leadError?: { code: string; message: string; details?: string } | null;
}
const calls = { or: [] as string[], inserts: 0, leadUpdates: [] as Record<string, unknown>[] };

/** The two reads/writes startHostingTrial makes on `leads`: the history query, then the insert. */
const adminWith = (f: Fake) =>
  ({
    from: (table: string) => {
      const q = {
        select: () => q, eq: () => q, order: () => q,
        update: (row: Record<string, unknown>) => { if (table === "leads") calls.leadUpdates.push(row); return q; },
        or: (s: string) => { calls.or.push(s); return q; },
        limit: async () => ({ data: f.prior ?? [], error: f.priorError ?? null }),
        // Only LEAD inserts are counted: a started trial also inserts its follow-up tasks.
        insert: async () => { if (table === "leads") calls.inserts += 1; return { error: table === "leads" ? f.leadError ?? null : null }; },
      };
      return q;
    },
  }) as unknown as Admin;

const req = new NextRequest("https://example.invalid/api/public/checkout/cart", { method: "POST" });
const input = { fullName: "T Tester", companyName: "T Co", email: "T@Example.invalid", phone: "+91 98765 43210", domain: "tco.in", cycle: "monthly" as const };

beforeEach(() => {
  calls.or = []; calls.inserts = 0; calls.leadUpdates = [];
  checkTrialHistory.mockReset().mockResolvedValue({ ok: true, trialled: false });
  recordTrialInDms.mockReset().mockResolvedValue({ ok: true });
  sendEmail.mockReset().mockResolvedValue({ status: "sent", providerId: "m1", errorMessage: null, provider: "smtp" });
  loadOwnerAlert.mockReset().mockResolvedValue({ alert: { ok: false, reason: "test" }, tenant: null });
});

describe("one free trial per customer (owner, 24 Sep 2026)", () => {
  it("an earlier trial on the same email, phone or domain refuses — and nothing is written", async () => {
    const r = await startHostingTrial(adminWith({ prior: [{ id: "L-OLD", created_at: "2026-09-01T00:00:00Z" }] }), input, req, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.alreadyTrialled).toBe(true);
      expect(r.error).toContain("one per customer");
      expect(r.error).toContain("Nothing was saved");
    }
    expect(calls.inserts).toBe(0);
  });

  it("matches on the lower-cased email, the last 10 phone digits and the domain", async () => {
    await startHostingTrial(adminWith({}), input, req, {});
    expect(calls.or[0]).toBe('contact_email.ilike."t@example.invalid",contact_phone.ilike."%9876543210",domain.eq."tco.in"');
  });

  it("no earlier trial → the trial starts", async () => {
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(true);
    expect(calls.inserts).toBe(1);
  });

  it("an unreadable history refuses rather than lets a second trial through", async () => {
    const r = await startHostingTrial(adminWith({ priorError: { message: "timeout" } }), input, req, {});
    expect(r.ok).toBe(false);
    expect(calls.inserts).toBe(0);
  });

  it("an email's _ or % cannot widen the match, and a comma cannot split the filter", () => {
    expect(likeEscape("a_b%c@x.in")).toBe("a\\_b\\%c@x.in");
    expect(quoteForOr('x,y"z')).toBe('"x,y\\"z"');
  });
});

describe("startHostingTrial — a missing buy-page tenant is a setup fault, not a retry", () => {
  it("the FK on tenant_id does not tell the customer to try again", async () => {
    const r = await startHostingTrial(
      adminWith({ leadError: { code: "23503", message: 'insert or update on table "leads" violates foreign key constraint "leads_tenant_id_fkey"', details: 'Key (tenant_id)=(x) is not present in table "tenants".' } }),
      input, req, {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("on our side");
      expect(r.error).not.toMatch(/please try again/i);
    }
  });

  it("any other insert failure keeps the retry wording", async () => {
    const r = await startHostingTrial(adminWith({ leadError: { code: "57014", message: "canceling statement due to statement timeout" } }), input, req, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/please try again/i);
  });
});

describe("one trial per customer across BOTH apps — DMS is the shared record", () => {
  it("a trial DMS knows of (its panel, or one recorded earlier) refuses, and nothing is written", async () => {
    checkTrialHistory.mockResolvedValueOnce({ ok: true, trialled: true, where: "dms", startedAt: "2026-09-10T00:00:00.000Z" });
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alreadyTrialled).toBe(true);
    expect(calls.inserts).toBe(0);
    expect(checkTrialHistory).toHaveBeenCalledWith({ email: "t@example.invalid", phone: "9876543210", domain: "tco.in" });
  });

  it("DMS not answering refuses the trial — never read as 'no earlier trial'", async () => {
    checkTrialHistory.mockResolvedValueOnce({ ok: false, reason: "DMS did not answer" });
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("couldn't check");
    expect(calls.inserts).toBe(0);
  });

  it("a started trial is recorded in DMS under its lead id", async () => {
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(true);
    expect(recordTrialInDms).toHaveBeenCalledWith(expect.objectContaining({ email: "t@example.invalid", domain: "tco.in", planId: "starter", cycle: "monthly" }));
    expect(calls.leadUpdates).toHaveLength(0);
  });

  it("if DMS cannot be told, the trial stands and the gap is written on the lead", async () => {
    recordTrialInDms.mockResolvedValueOnce({ ok: false, reason: "DMS answered HTTP 503" });
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r.ok).toBe(true);
    expect(String(calls.leadUpdates[0]?.notes)).toContain("NOT RECORDED IN DMS (DMS answered HTTP 503)");
  });
});

describe("trial emails: the customer only (30 Sep 2026)", () => {
  const ownerOk = { alert: { ok: true, to: "owner@example.invalid", ownerName: "Owner" }, tenant: { name: "T" } };

  it("the confirmation link is sent even when there is no owner alert address", async () => {
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r).toMatchObject({ ok: true, confirmationSent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: input.email, kind: "buy_page_trial_customer" });
  });

  it("a confirmation that did not go out is reported, not claimed — the trial still stands", async () => {
    sendEmail.mockResolvedValue({ status: "failed", providerId: null, errorMessage: "SMTP: 550 mailbox unavailable", provider: "smtp" });
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r).toMatchObject({ ok: true, confirmationSent: false });
  });

  it("sends the owner NO email at all — only the customer's confirmation (owner, 30 Sep 2026)", async () => {
    loadOwnerAlert.mockResolvedValue(ownerOk);
    const r = await startHostingTrial(adminWith({}), input, req, {});
    expect(r).toMatchObject({ ok: true, confirmationSent: true });
    const kinds = sendEmail.mock.calls.map((c) => (c[0] as { kind: string }).kind);
    expect(kinds).toEqual(["buy_page_trial_customer"]);
    // The storefront's customer email replies to support and signs as the company (5 Oct 2026).
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ replyTo: "support@anutech.in" });
    expect((sendEmail.mock.calls[0][0] as { text: string }).text).toMatch(/— Anutech Digital$/);
  });

  it("the storefront email replies to support even with no owner alert address", async () => {
    await startHostingTrial(adminWith({}), input, req, {});
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ replyTo: "support@anutech.in" });
    expect((sendEmail.mock.calls[0][0] as { text: string }).text).not.toContain("Owner");
  });
});

describe("repeat trials on a local machine only (1 Oct 2026)", () => {
  it("on only with ALLOW_REPEAT_TRIALS_LOCAL=1 outside a production build", () => {
    expect(repeatTrialsAllowed({ NODE_ENV: "development", ALLOW_REPEAT_TRIALS_LOCAL: "1" })).toBe(true);
    expect(repeatTrialsAllowed({ NODE_ENV: "development" })).toBe(false);
    expect(repeatTrialsAllowed({ NODE_ENV: "development", ALLOW_REPEAT_TRIALS_LOCAL: "true" })).toBe(false);
  });
  it("a production build keeps the one-trial check even if the variable is set", () => {
    expect(repeatTrialsAllowed({ NODE_ENV: "production", ALLOW_REPEAT_TRIALS_LOCAL: "1" })).toBe(false);
  });
});
