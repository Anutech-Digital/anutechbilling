/**
 * R-2070 (decision D4) — the dunning cron pauses a SUPPORT subscription (catalogue SKU SUP-…)
 * once its invoice is more than 7 days past due, for every company, without the R-116 opt-in.
 * Status 'paused' + suspended_by 'automation' + suspended_invoice_id, so the existing trigger
 * trg_invoices_overdue_resume turns it back on when the invoice is paid. Workspace and other
 * subscriptions are untouched by this pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/automation/gate.server", () => ({
  automationState: async () => "on",
  cronTenants: async () => ({ on: [], dry: [] }),
  recordRun: async () => {},
  readJobRow: async () => null,
  ensureDefaultOnRow: async () => {},
  readTenantJobs: async () => [],
}));
/* R-897: route logic under test — the automation gate is passed through here; it has its own tests (_lib/automation-gate.test.ts). */
vi.mock("@/lib/automation/cron-gate", () => ({
  gatedCron: (_job: string, h: unknown) => h,
  cronTenantAllowed: () => true,
  isCronDryRun: () => false,
  noteWouldSend: () => {},
  currentCronRun: () => null,
}));
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

const SUP_ITEM = "SUP-STANDARD-MO-T1";
const GWS_ITEM = "GWS-STARTER-T1";

function seed(opts: { autoOn?: boolean; days?: number; paid?: number; credit?: boolean; viaBilling?: boolean } = {}) {
  return {
    tenants: [{
      id: "T1", name: "Seller", email: "owner@seller.example", auto_suspend_on_overdue: opts.autoOn ?? false,
      overdue_suspend_days: opts.days ?? 15, upi_vpa: null, upi_payee_name: null,
    }],
    items: [
      { id: SUP_ITEM, tenant_id: "T1", vendor: "support" },
      { id: GWS_ITEM, tenant_id: "T1", vendor: "google" },
    ],
    invoices: [
      { id: "INV-S", tenant_id: "T1", customer_id: "C1", customer_name: "Ravi Co", amount: 999, net_payable: null,
        paid_amount: opts.paid ?? 0, status: "overdue", due_date: "2026-09-01", quote_id: opts.viaBilling ? "Q-OTHER" : "Q-S" },
      { id: "INV-W", tenant_id: "T1", customer_id: "C1", customer_name: "Ravi Co", amount: 10000, net_payable: null,
        paid_amount: 0, status: "overdue", due_date: "2026-09-01", quote_id: "Q-W" },
    ],
    subscriptions: [
      { id: "S-SUP", tenant_id: "T1", customer_id: "C1", customer_name: "Ravi Co", plan: "Standard Support (Monthly)",
        domain: "ravi.in", quote_id: "Q-S", item_id: SUP_ITEM, status: "active" },
      { id: "S-GWS", tenant_id: "T1", customer_id: "C1", customer_name: "Ravi Co", plan: "Business Starter",
        domain: "ravi.in", quote_id: "Q-W", item_id: GWS_ITEM, status: "active" },
    ],
    subscription_billings: opts.viaBilling ? [{ id: "B1", subscription_id: "S-SUP", invoice_id: "INV-S" }] : [],
    quotes: [
      { id: "Q-S", credit_activated_at: opts.credit ? "2026-08-30T00:00:00Z" : null },
      { id: "Q-W", credit_activated_at: null },
      { id: "Q-OTHER", credit_activated_at: null },
    ],
    invoice_dunning_log: [
      /* Ladder history so the reminder pass is quiet. */
      { id: "L0", invoice_id: "INV-S", dunning_step: "final", sent_at: "2026-09-15T04:00:00Z", status: "sent" },
      { id: "L1", invoice_id: "INV-W", dunning_step: "final", sent_at: "2026-09-15T04:00:00Z", status: "sent" },
    ],
    ai_action_log: [],
  };
}

beforeEach(() => { process.env.CRON_SECRET = "s3cret"; mail.sendEmail.mockClear(); });
afterEach(() => { process.env = { ...ENV }; vi.useRealTimers(); });

describe("support plan pause after 7 days overdue (R-2070)", () => {
  it("day 7 past due → no pause yet", async () => {
    db.current = fakePostgrest(seed());
    const body = await (await call("2026-09-08")).json();
    expect(body.support_pause.details).toEqual([]);
  });

  it("day 8 past due → support subscription decided 'suspend' even with the company auto-pause OFF", async () => {
    db.current = fakePostgrest(seed({ autoOn: false }));
    const body = await (await call("2026-09-09")).json();
    expect(body.support_pause.details).toEqual([
      expect.objectContaining({ subscription_id: "S-SUP", invoice_id: "INV-S", action: "suspend", days_overdue: 8 }),
    ]);
    /* dry run writes nothing */
    expect(db.current.tables.subscriptions.map((s) => s.status)).toEqual(["active", "active"]);
  });

  it("an invoice linked through subscription_billings counts too", async () => {
    db.current = fakePostgrest(seed({ viaBilling: true }));
    const body = await (await call("2026-09-09")).json();
    expect(body.support_pause.details.map((d: { subscription_id: string }) => d.subscription_id)).toEqual(["S-SUP"]);
  });

  it("paid invoice → nothing", async () => {
    db.current = fakePostgrest(seed({ paid: 999 }));
    const body = await (await call("2026-09-20")).json();
    expect(body.support_pause.details).toEqual([]);
  });

  it("'activate now, pay later' quote (R-346) → never paused", async () => {
    db.current = fakePostgrest(seed({ credit: true }));
    const body = await (await call("2026-09-20")).json();
    expect(body.support_pause.details).toEqual([]);
  });

  it("live run: support paused (automation, invoice linked, logged); Workspace subscription untouched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T06:00:00Z"));
    db.current = fakePostgrest(seed());
    const body = await (await call("", true)).json();
    expect(body.support_pause.suspends).toBe(1);
    const [sup, gws] = db.current.tables.subscriptions;
    expect(sup).toEqual(expect.objectContaining({
      status: "paused", suspended_by: "automation", suspended_invoice_id: "INV-S",
      suspended_at: "2026-09-09T06:00:00.000Z",
    }));
    expect(String(sup.suspend_reason)).toContain("INV-S");
    expect(gws).toEqual(expect.objectContaining({ status: "active" }));
    expect(gws.suspended_by).toBeUndefined();
    expect(db.current.tables.ai_action_log).toEqual([
      expect.objectContaining({ action: "subscription.support_overdue_suspend", outcome: "did", entity_id: "S-SUP" }),
    ]);
  });

  it("company auto-pause ON (limit 3): the R-116 pass leaves the support plan to the support rule", async () => {
    db.current = fakePostgrest(seed({ autoOn: true, days: 3 }));
    const body = await (await call("2026-09-06")).json();
    /* day 5: R-116 acts at limit 3 — but not on the support plan. */
    expect(body.overdue_pause.details.map((d: { subscription_id: string }) => d.subscription_id)).toEqual(["S-GWS"]);
    expect(body.support_pause.details).toEqual([]);
  });
});
