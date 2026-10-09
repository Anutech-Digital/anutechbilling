/**
 * R-116 — the "pause after N days overdue" pass inside the dunning cron.
 * Notice first (once), then pause with reason + actor, logged; switch off = nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";

const db = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("@/lib/ops/fake-postgrest.testutil").fakePostgrest> }));
const mail = vi.hoisted(() => ({ sendEmail: vi.fn(async () => ({ status: "sent", providerId: null, errorMessage: null, provider: "stub" })) }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current!.client }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail, isEmailConfigured: () => true }));
vi.mock("@/lib/contacts/primary", () => ({ primaryContactEmail: vi.fn(async () => ({ email: "pay@customer.example", name: null, fromLegacy: false })) }));
vi.mock("@/lib/marketing/whatsapp-reminders.server", () => ({
  createReminderSender: () => ({ send: vi.fn(async () => ({ status: "disabled" })), totals: { sent: 0, skipped: 0, failed: 0, disabled: 0 } }),
}));

import { GET } from "./route";

const ENV = { ...process.env };
const call = (on: string, live = false) => GET(new Request(
  live ? "https://example.invalid/api/cron/invoice-dunning" : `https://example.invalid/api/cron/invoice-dunning?dry=1&on=${on}`,
  { headers: { authorization: "Bearer s3cret" } },
));

function seed(opts: { autoOn: boolean; days?: number; notices?: { sent_at: string; status: string }[]; paid?: number }) {
  return {
    tenants: [{
      id: "T1", name: "Seller", email: "owner@seller.example", auto_suspend_on_overdue: opts.autoOn,
      overdue_suspend_days: opts.days ?? 15, upi_vpa: null, upi_payee_name: null,
    }],
    invoices: [{
      id: "INV-1", tenant_id: "T1", customer_id: "C1", customer_name: "Ravi Co", amount: 10000, net_payable: null,
      paid_amount: opts.paid ?? 0, status: "overdue", due_date: "2026-09-01", quote_id: "Q1",
    }],
    subscriptions: [{
      id: "S1", tenant_id: "T1", customer_id: "C1", customer_name: "Ravi Co", plan: "Business Starter",
      domain: "ravi.in", quote_id: "Q1", status: "active",
    }],
    subscription_billings: [],
    quotes: [{ id: "Q1", credit_activated_at: null }],
    invoice_dunning_log: [
      /* Ladder history so the reminder pass is quiet and only the pause pass acts. */
      { id: "L0", invoice_id: "INV-1", dunning_step: "final", sent_at: "2026-09-15T04:00:00Z", status: "sent" },
      ...(opts.notices ?? []).map((n, i) => ({ id: `N${i}`, invoice_id: "INV-1", dunning_step: "suspend_notice", ...n })),
    ],
    ai_action_log: [],
  };
}

beforeEach(() => { process.env.CRON_SECRET = "s3cret"; mail.sendEmail.mockClear(); });
afterEach(() => { process.env = { ...ENV }; vi.useRealTimers(); });

describe("overdue pause pass", () => {
  it("switch off → nothing decided", async () => {
    db.current = fakePostgrest(seed({ autoOn: false }));
    const body = await (await call("2026-09-30")).json();
    expect(body.overdue_pause.companies_on).toBe(0);
    expect(body.overdue_pause.details).toEqual([]);
  });

  it("day 13 with no notice → notice (dry run writes nothing)", async () => {
    db.current = fakePostgrest(seed({ autoOn: true }));
    const body = await (await call("2026-09-14")).json();
    expect(body.overdue_pause.details).toEqual([
      expect.objectContaining({ subscription_id: "S1", invoice_id: "INV-1", action: "notice", pause_on: "2026-09-17" }),
    ]);
    expect(db.current.tables.subscriptions[0].status).toBe("active");
  });

  it("a FAILED notice is not a notice — still 'notice', never 'suspend'", async () => {
    db.current = fakePostgrest(seed({ autoOn: true, notices: [{ sent_at: "2026-09-14T04:00:00Z", status: "failed" }] }));
    const body = await (await call("2026-09-20")).json();
    expect(body.overdue_pause.details[0].action).toBe("notice");
  });

  it("notice sent, past the limit → suspend", async () => {
    db.current = fakePostgrest(seed({ autoOn: true, notices: [{ sent_at: "2026-09-14T04:00:00Z", status: "sent" }] }));
    const body = await (await call("2026-09-17")).json();
    expect(body.overdue_pause.details[0]).toEqual(expect.objectContaining({ action: "suspend", days_overdue: 16 }));
  });

  it("company limit 30 → no pause on day 20 even with a notice", async () => {
    db.current = fakePostgrest(seed({ autoOn: true, days: 30, notices: [{ sent_at: "2026-09-14T04:00:00Z", status: "sent" }] }));
    const body = await (await call("2026-09-21")).json();
    expect(body.overdue_pause.details).toEqual([]);
  });

  it("live run: pauses with reason + actor, logs it, tells the company", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-17T06:00:00Z"));
    db.current = fakePostgrest(seed({ autoOn: true, notices: [{ sent_at: "2026-09-14T04:00:00Z", status: "sent" }] }));
    const body = await (await call("", true)).json();
    expect(body.overdue_pause.suspends).toBe(1);
    const sub = db.current.tables.subscriptions[0];
    expect(sub).toEqual(expect.objectContaining({
      status: "paused", suspended_by: "automation", suspended_invoice_id: "INV-1",
    }));
    expect(String(sub.suspend_reason)).toContain("INV-1");
    expect(sub.suspended_at).toBe("2026-09-17T06:00:00.000Z");
    expect(db.current.tables.ai_action_log).toEqual([
      expect.objectContaining({ action: "subscription.overdue_suspend", outcome: "did", entity_id: "S1" }),
    ]);
    const toOwner = mail.sendEmail.mock.calls.map((c) => (c as unknown as [{ to: string }])[0].to);
    expect(toOwner).toContain("owner@seller.example");
  });

  it("live run on notice day: emails the customer through the dunning switch and logs the notice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T06:00:00Z"));
    db.current = fakePostgrest(seed({ autoOn: true }));
    const body = await (await call("", true)).json();
    expect(body.overdue_pause.notices).toBe(1);
    const sent = mail.sendEmail.mock.calls.map((c) => (c as unknown as [{ to: string; automated?: { action: string } }])[0]);
    expect(sent).toContainEqual(expect.objectContaining({ to: "pay@customer.example", automated: { tenantId: "T1", action: "dunning.send" } }));
    expect(db.current.tables.invoice_dunning_log.filter((l) => l.dunning_step === "suspend_notice")).toEqual([
      expect.objectContaining({ invoice_id: "INV-1", status: "sent" }),
    ]);
    expect(db.current.tables.subscriptions[0].status).toBe("active");
  });
});
