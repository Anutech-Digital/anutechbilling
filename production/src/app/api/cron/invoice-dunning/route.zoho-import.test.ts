/**
 * R-2499 — an FY 2025-26 sale imported as Zoho's own invoice (zoho_invoice_id set) is never
 * chased by the dunning cron: its receipts come from the bank / Zoho (R-2501), not a reminder.
 * The same pending invoice without a Zoho id still gets its reminder (the control).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
/* R-897: customer messages switched ON for these tests (the gate has its own tests). */
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
const sent = vi.hoisted(() => ({ emails: [] as { to: string; subject: string; text: string }[], wa: [] as Record<string, unknown>[] }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current!.client }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: vi.fn(async (m: { to: string; subject: string; text: string }) => { sent.emails.push(m); return { status: "sent" }; }),
  isEmailConfigured: () => true,
}));
vi.mock("@/lib/contacts/primary", () => ({ primaryContactEmail: vi.fn(async () => ({ email: "cust@example.invalid", name: "Cust", fromLegacy: false })) }));
vi.mock("@/lib/marketing/whatsapp-reminders.server", () => ({
  createReminderSender: () => ({
    send: vi.fn(async (a: { values: Record<string, unknown> }) => { sent.wa.push(a.values); return { status: "disabled" }; }),
    totals: { sent: 0, skipped: 0, failed: 0, disabled: 0 },
  }),
}));

import { GET } from "./route";

const ENV = { ...process.env };
const live = () => new Request("https://example.invalid/api/cron/invoice-dunning", { headers: { authorization: "Bearer s3cret" } });

function seed(inv: Record<string, unknown>) {
  return {
    invoices: [{
      id: "INV/25-26/0007", tenant_id: "T1", customer_id: "C1", customer_name: "Cust",
      status: "overdue", quote_id: null, paid_amount: 0, amount: 11800, net_payable: 11800, due_date: "2026-10-03", ...inv,
    }],
    invoice_dunning_log: [],
    tenants: [{ id: "T1", name: "Seller", email: "owner@example.invalid", auto_suspend_on_overdue: false, upi_vpa: "seller@upi", upi_payee_name: "Seller" }],
    subscriptions: [],
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  sent.emails.length = 0; sent.wa.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T06:30:00Z"));   // 12:00 IST, 10 Oct
});
afterEach(() => { vi.useRealTimers(); process.env = { ...ENV }; });

describe("R-2499 dunning leaves imported Zoho FY sales alone", () => {
  it("an imported Zoho sale gets no reminder", async () => {
    db.current = fakePostgrest(seed({ zoho_invoice_id: "9000007" }) as never);
    const body = await (await GET(live())).json();
    expect(body.considered).toBe(0);
    expect(body.details).toHaveLength(0);
    expect(sent.emails).toHaveLength(0);
  });

  it("the same invoice made in the app is still chased (control)", async () => {
    db.current = fakePostgrest(seed({ zoho_invoice_id: null }) as never);
    const body = await (await GET(live())).json();
    expect(body.details).toHaveLength(1);
    expect(sent.emails.length).toBeGreaterThan(0);
  });
});
