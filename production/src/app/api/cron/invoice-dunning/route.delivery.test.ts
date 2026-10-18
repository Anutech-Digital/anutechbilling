/**
 * R-1538 / R-1539 / R-1572 — a dunning step or pause notice counts as "sent" only when the
 * email provider ACCEPTED it.
 *
 * Before (anutech/manager-pardeep, 18 Oct 2026):
 *   - route.ts:339 kept sendCustomerEmail's result only for a counter; :377 logged the step
 *     from dunningLogStatus(recipient, isEmailConfigured()) → a refused send was logged "sent".
 *   - route.ts:196-207 advanced the ladder on EVERY log row, whatever its status, so a failed
 *     step was never retried (the :399 comment promised it would be).
 *   - route.ts:382 inserted the log row AFTER sending and never checked the error → a failed
 *     write meant the same email again next morning.
 *   - route.ts:370 told the owner "the customer has had the full reminder sequence" even when
 *     none of it reached them.
 *   - overdue-suspension.server.ts:104 counted every notice row except 'failed' as delivered,
 *     and :180 took no_recipient / stubbed from dunningLogStatus → service paused with no notice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const gate = vi.hoisted(() => ({ state: "on" as "on" | "off" }));
vi.mock("@/lib/automation/gate.server", () => ({
  automationState: async () => gate.state,
  cronTenants: async () => ({ on: [], dry: [] }),
  recordRun: async () => {},
  readJobRow: async () => null,
  ensureDefaultOnRow: async () => {},
  readTenantJobs: async () => [],
}));
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: () => true,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
  currentCronRun: () => null,
}));
vi.mock("@/lib/email/log", () => ({ recordEmail: async () => {} }));
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";

type Mail = { to: string; subject: string; text: string };
const db = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("@/lib/ops/fake-postgrest.testutil").fakePostgrest> }));
const mail = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_m: unknown) => ({ status: "sent", providerId: "p1", errorMessage: null, provider: "smtp" })),
}));
const contact = vi.hoisted(() => ({ email: "pay@customer.example" as string | null }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current!.client }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail, isEmailConfigured: () => true }));
vi.mock("@/lib/contacts/primary", () => ({
  primaryContactEmail: vi.fn(async () => ({ email: contact.email, name: null, fromLegacy: false })),
}));
vi.mock("@/lib/marketing/whatsapp-reminders.server", () => ({
  createReminderSender: () => ({ send: vi.fn(async () => ({ status: "disabled" })), totals: { sent: 0, skipped: 0, failed: 0, disabled: 0 } }),
}));

import { GET } from "./route";

const ENV = { ...process.env };
async function liveRun(at: string) {
  vi.setSystemTime(new Date(at));
  const res = await GET(new Request("https://example.invalid/api/cron/invoice-dunning", { headers: { authorization: "Bearer s3cret" } }));
  return res.json();
}
const sentTo = (addr: string) =>
  mail.sendEmail.mock.calls.map((c) => c[0] as Mail).filter((m) => m.to === addr);

type LogRow = { id?: string; invoice_id: string; dunning_step: string; sent_at: string; status: string; error_message?: string | null };

function seed(opts: { autoOn?: boolean; logs?: LogRow[] } = {}) {
  return {
    tenants: [{
      id: "T1", name: "Seller", email: "owner@seller.example", auto_suspend_on_overdue: opts.autoOn ?? false,
      overdue_suspend_days: 15, upi_vpa: null, upi_payee_name: null,
    }],
    invoices: [{
      id: "INV-1", tenant_id: "T1", customer_id: "C1", customer_name: "Ravi Co", amount: 10000, net_payable: null,
      paid_amount: 0, status: "overdue", due_date: "2026-09-01", quote_id: "Q1",
    }],
    subscriptions: [{
      id: "S1", tenant_id: "T1", customer_id: "C1", customer_name: "Ravi Co", plan: "Business Starter",
      domain: "ravi.in", quote_id: "Q1", status: "active",
    }],
    subscription_billings: [],
    quotes: [{ id: "Q1", credit_activated_at: null }],
    invoice_dunning_log: (opts.logs ?? []).map((l, i) => ({ id: l.id ?? `L${i}`, ...l })),
    ai_action_log: [],
    email_log: [],
  };
}
const ladderDone: LogRow = { invoice_id: "INV-1", dunning_step: "final", sent_at: "2026-09-15T04:00:00Z", status: "sent" };

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  mail.sendEmail.mockClear();
  mail.sendEmail.mockImplementation(async () => ({ status: "sent", providerId: "p1", errorMessage: null, provider: "smtp" }));
  gate.state = "on";
  contact.email = "pay@customer.example";
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => { process.env = { ...ENV }; vi.useRealTimers(); });

describe("R-1539/R-1572 — a reminder is 'sent' only when the provider accepted it", () => {
  it("customer messages OFF → step logged 'failed' with the reason, NOT sent", async () => {
    gate.state = "off";
    db.current = fakePostgrest(seed());
    const body = await liveRun("2026-09-02T06:00:00Z");
    const rows = db.current.tables.invoice_dunning_log.filter((l) => l.dunning_step === "reminder");
    expect(rows).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(String(rows[0].error_message)).toMatch(/switched off/i);
    expect(body.emails_sent).toBe(0);
    /* Surfaced in the cron failure report (top-level errors → cronFailureLine). */
    expect(body.errors).toContainEqual(expect.objectContaining({ invoice_id: "INV-1", message: expect.stringMatching(/reminder.*not delivered/i) }));
  });

  it("a refused step is RETRIED on the next run (the ladder does not move on)", async () => {
    gate.state = "off";
    db.current = fakePostgrest(seed());
    await liveRun("2026-09-02T06:00:00Z");
    gate.state = "on";
    const body = await liveRun("2026-09-03T06:00:00Z");
    expect(body.details).toEqual([expect.objectContaining({ invoice_id: "INV-1", step: "reminder" })]);
    expect(sentTo("pay@customer.example")).toHaveLength(1);
    const rows = db.current.tables.invoice_dunning_log.filter((l) => l.dunning_step === "reminder").map((l) => l.status);
    expect(rows).toEqual(["failed", "sent"]);
  });

  it("retries are bounded: after 3 undelivered attempts the step is given up and reported", async () => {
    db.current = fakePostgrest(seed({ logs: [1, 2, 3].map((d) => ({
      invoice_id: "INV-1", dunning_step: "reminder", sent_at: `2026-09-0${d}T04:00:00Z`, status: "failed", error_message: "refused",
    })) }));
    const body = await liveRun("2026-09-03T06:00:00Z");   // day 2: still the reminder step
    expect(body.details).toEqual([]);
    expect(sentTo("pay@customer.example")).toHaveLength(0);
  });

  it("no customer email → 'no_recipient', counted, and retried next run (bounded)", async () => {
    contact.email = null;
    db.current = fakePostgrest(seed());
    const b1 = await liveRun("2026-09-02T06:00:00Z");
    expect(b1.no_recipient).toBe(1);
    const b2 = await liveRun("2026-09-03T06:00:00Z");
    expect(b2.details).toEqual([expect.objectContaining({ step: "reminder" })]);
    expect(db.current.tables.invoice_dunning_log.map((l) => l.status)).toEqual(["no_recipient", "no_recipient"]);
  });

  it("log write fails → the email is NOT sent, and the next run sends it exactly once", async () => {
    db.current = fakePostgrest(seed());
    const inner = db.current.client;
    let failWrites = true;
    db.current.client = {
      from: (t: string) => {
        const b = inner.from(t) as unknown as Record<string, unknown>;
        if (t === "invoice_dunning_log" && failWrites) {
          /* The row is NOT written and the caller is told so. */
          b.insert = () => ({
            then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "insert failed" } }).then(ok),
          });
        }
        return b as never;
      },
    };
    await liveRun("2026-09-02T06:00:00Z");
    failWrites = false;
    await liveRun("2026-09-03T06:00:00Z");
    expect(sentTo("pay@customer.example")).toHaveLength(1);
  });

  it("send ok but the outcome write fails → the claimed row stays and the step is NOT sent again", async () => {
    db.current = fakePostgrest(seed());
    const inner = db.current.client;
    let failUpdates = true;
    db.current.client = {
      from: (t: string) => {
        const b = inner.from(t) as unknown as Record<string, unknown>;
        if (t === "invoice_dunning_log" && failUpdates) {
          const failed = {
            eq: () => failed,
            then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "update failed" } }).then(ok),
          };
          b.update = () => failed;
        }
        return b as never;
      },
    };
    const b1 = await liveRun("2026-09-02T06:00:00Z");
    failUpdates = false;
    await liveRun("2026-09-03T06:00:00Z");
    expect(sentTo("pay@customer.example")).toHaveLength(1);
    expect(b1.errors.length).toBeGreaterThan(0);
  });
});

describe("R-1539 — the owner's escalation tells the truth", () => {
  it("steps that never reached the customer → no 'full reminder sequence', true counts instead", async () => {
    db.current = fakePostgrest(seed({ logs: [
      { invoice_id: "INV-1", dunning_step: "reminder", sent_at: "2026-09-02T04:00:00Z", status: "sent" },
      ...[3, 4, 5].map((d) => ({ invoice_id: "INV-1", dunning_step: "retry", sent_at: `2026-09-0${d}T04:00:00Z`, status: "no_recipient" })),
      ...[8, 9].map((d) => ({ invoice_id: "INV-1", dunning_step: "grace_warning", sent_at: `2026-09-0${d}T04:00:00Z`, status: "failed", error_message: "Customer messages are switched off" })),
      { invoice_id: "INV-1", dunning_step: "grace_warning", sent_at: "2026-09-10T04:00:00Z", status: "failed", error_message: "Customer messages are switched off" },
    ] }));
    const body = await liveRun("2026-09-15T06:00:00Z");
    expect(body.escalations).toBe(1);
    const owner = sentTo("owner@seller.example");
    expect(owner).toHaveLength(1);
    expect(owner[0].text).not.toMatch(/full reminder sequence/i);
    expect(owner[0].text).toMatch(/2 of 4 reminders reached the customer/i);
    expect(owner[0].text).toMatch(/retry.*no email address/i);
    expect(owner[0].text).toMatch(/grace_warning.*switched off/i);
  });

  it("every step delivered → still says the full sequence went out", async () => {
    db.current = fakePostgrest(seed({ logs: ["reminder", "retry", "grace_warning"].map((s, i) => ({
      invoice_id: "INV-1", dunning_step: s, sent_at: `2026-09-0${2 + i * 3}T04:00:00Z`, status: "sent",
    })) }));
    await liveRun("2026-09-15T06:00:00Z");
    const owner = sentTo("owner@seller.example");
    expect(owner[0].text).toMatch(/4 of 4 reminders reached the customer/i);
    expect(owner[0].text).toMatch(/full reminder sequence/i);
  });

  it("the escalation goes to the owner ONCE, even while the final notice is retried", async () => {
    gate.state = "off";
    db.current = fakePostgrest(seed({ logs: ["reminder", "retry", "grace_warning"].map((s, i) => ({
      invoice_id: "INV-1", dunning_step: s, sent_at: `2026-09-0${2 + i * 3}T04:00:00Z`, status: "sent",
    })) }));
    await liveRun("2026-09-15T06:00:00Z");
    await liveRun("2026-09-16T06:00:00Z");
    expect(sentTo("owner@seller.example")).toHaveLength(1);
    expect(db.current.tables.invoice_dunning_log.filter((l) => l.dunning_step === "final").map((l) => l.status)).toEqual(["failed", "failed"]);
  });
});

describe("R-1538 — no pause without a DELIVERED final notice", () => {
  for (const status of ["no_recipient", "stubbed", "sending"]) {
    it(`a '${status}' notice is not a notice → never 'suspend'`, async () => {
      db.current = fakePostgrest(seed({ autoOn: true, logs: [
        ladderDone,
        { invoice_id: "INV-1", dunning_step: "suspend_notice", sent_at: "2026-09-14T04:00:00Z", status },
      ] }));
      const body = await liveRun("2026-09-20T06:00:00Z");
      expect(body.overdue_pause.suspends).toBe(0);
      expect(db.current.tables.subscriptions[0].status).toBe("active");
    });
  }

  it("customer without email: notice logged no_recipient, owner told, service never paused", async () => {
    contact.email = null;
    db.current = fakePostgrest(seed({ autoOn: true, logs: [ladderDone] }));
    const b1 = await liveRun("2026-09-14T06:00:00Z");
    expect(b1.overdue_pause.notices).toBe(0);
    expect(db.current.tables.invoice_dunning_log.filter((l) => l.dunning_step === "suspend_notice").map((l) => l.status)).toEqual(["no_recipient"]);
    expect(b1.overdue_pause.blocked).toEqual([expect.objectContaining({ subscription_id: "S1", invoice_id: "INV-1", reason: expect.stringMatching(/no email address/i) })]);
    expect(b1.errors).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/can't pause.*final notice not delivered/i) }));
    const owner = sentTo("owner@seller.example");
    expect(owner).toHaveLength(1);
    expect(owner[0].text).toMatch(/not paused/i);

    for (const day of ["2026-09-17", "2026-09-18", "2026-09-19", "2026-09-25"]) {
      const b = await liveRun(`${day}T06:00:00Z`);
      expect(b.overdue_pause.suspends).toBe(0);
    }
    expect(db.current.tables.subscriptions[0].status).toBe("active");
    /* Bounded: at most 3 notice attempts, and the owner alert only once. */
    expect(db.current.tables.invoice_dunning_log.filter((l) => l.dunning_step === "suspend_notice")).toHaveLength(3);
    expect(sentTo("owner@seller.example")).toHaveLength(1);
  });

  it("notice refused by the switch → 'failed', retried next run; delivered then → pause only N days after delivery", async () => {
    gate.state = "off";
    db.current = fakePostgrest(seed({ autoOn: true, logs: [ladderDone] }));
    await liveRun("2026-09-14T06:00:00Z");
    gate.state = "on";
    const b2 = await liveRun("2026-09-15T06:00:00Z");
    expect(b2.overdue_pause.notices).toBe(1);
    expect(db.current.tables.invoice_dunning_log.filter((l) => l.dunning_step === "suspend_notice").map((l) => l.status)).toEqual(["failed", "sent"]);
    const b3 = await liveRun("2026-09-17T06:00:00Z");
    expect(b3.overdue_pause.suspends).toBe(0);           // 2 days after the real notice
    const b4 = await liveRun("2026-09-18T06:00:00Z");
    expect(b4.overdue_pause.suspends).toBe(1);           // 3 days after
  });
});
