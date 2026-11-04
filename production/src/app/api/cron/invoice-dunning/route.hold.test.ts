/**
 * R-2411 — the dunning cron (the automatic payment reminders, email + WhatsApp) skips a
 * customer who PROMISED to pay (until that date) or who DISPUTES the bill (until resolved).
 * The skip is reported in `on_hold` so a dry run (`npm run cron:local invoice-dunning -- --dry`)
 * shows who was held and why. The day after the promise date the reminder goes again.
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
const wa = vi.hoisted(() => ({ send: vi.fn(async (_msg: unknown) => ({ status: "disabled" })) }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current!.client }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mail.sendEmail, isEmailConfigured: () => true }));
vi.mock("@/lib/contacts/primary", () => ({ primaryContactEmail: vi.fn(async () => ({ email: "pay@customer.example", name: null, fromLegacy: false })) }));
vi.mock("@/lib/marketing/whatsapp-reminders.server", () => ({
  createReminderSender: () => ({ send: wa.send, totals: { sent: 0, skipped: 0, failed: 0, disabled: 0 } }),
}));

import { GET } from "./route";

const ENV = { ...process.env };
const dry = (on: string) => GET(new Request(
  `https://example.invalid/api/cron/invoice-dunning?dry=1&on=${on}`,
  { headers: { authorization: "Bearer s3cret" } },
));
const live = () => GET(new Request("https://example.invalid/api/cron/invoice-dunning", { headers: { authorization: "Bearer s3cret" } }));

type Fu = Record<string, unknown>;
function seed(followups: Fu[]) {
  return {
    tenants: [{ id: "T1", name: "Seller", email: "owner@seller.example", auto_suspend_on_overdue: false, overdue_suspend_days: 15, upi_vpa: null, upi_payee_name: null }],
    invoices: [
      /* due 1 Nov → day-1 reminder due on 2 Nov */
      { id: "INV-P", tenant_id: "T1", customer_id: "C-PROM", customer_name: "Promise Co", amount: 5000, net_payable: null, paid_amount: 0, status: "overdue", due_date: "2026-11-01", quote_id: null },
      { id: "INV-D", tenant_id: "T1", customer_id: "C-DISP", customer_name: "Dispute Co", amount: 7000, net_payable: null, paid_amount: 0, status: "overdue", due_date: "2026-11-01", quote_id: null },
      { id: "INV-N", tenant_id: "T1", customer_id: "C-NONE", customer_name: "Normal Co", amount: 9000, net_payable: null, paid_amount: 0, status: "overdue", due_date: "2026-11-01", quote_id: null },
    ],
    subscriptions: [], quotes: [], items: [], subscription_billings: [], invoice_dunning_log: [], ai_action_log: [],
    payment_followups: followups,
  };
}
const promise = (on: string): Fu => ({ id: "fp", tenant_id: "T1", customer_id: "C-PROM", kind: "promise", note: null, outcome: null, promised_on: on, promised_amount: 5000, created_at: "2026-11-01T06:00:00Z" });
const dispute: Fu = { id: "fd", tenant_id: "T1", customer_id: "C-DISP", kind: "call", note: "Says the rate is wrong", outcome: "disputed", promised_on: null, promised_amount: null, created_at: "2026-11-01T06:00:00Z" };
const resolved: Fu = { id: "fr", tenant_id: "T1", customer_id: "C-DISP", kind: "note", note: "Dispute resolved.", outcome: "dispute_resolved", promised_on: null, promised_amount: null, created_at: "2026-11-02T03:00:00Z" };

const ids = (b: { details: { invoice_id: string }[] }) => b.details.map((d) => d.invoice_id).sort();

beforeEach(() => { process.env.CRON_SECRET = "s3cret"; mail.sendEmail.mockClear(); wa.send.mockClear(); });
afterEach(() => { process.env = { ...ENV }; vi.useRealTimers(); });

describe("promise / dispute hold (R-2411)", () => {
  it("dry run: promised (date ahead) and disputed customers are held, with why; the other is reminded", async () => {
    db.current = fakePostgrest(seed([promise("2026-11-05"), dispute]));
    const body = await (await dry("2026-11-03")).json();
    expect(ids(body)).toEqual(["INV-N"]);
    /* invoices are read in id order */
    expect(body.on_hold).toEqual([
      expect.objectContaining({ invoice_id: "INV-D", customer_id: "C-DISP", hold: "dispute", reason: "Says the rate is wrong" }),
      expect.objectContaining({ invoice_id: "INV-P", customer_id: "C-PROM", hold: "promise", until: "2026-11-05" }),
    ]);
  });

  it("on the promise date itself still held; the day after (not paid) the reminder goes again", async () => {
    db.current = fakePostgrest(seed([promise("2026-11-05")]));
    expect(ids(await (await dry("2026-11-05")).json())).toEqual(["INV-D", "INV-N"]);
    db.current = fakePostgrest(seed([promise("2026-11-05")]));
    expect(ids(await (await dry("2026-11-06")).json())).toEqual(["INV-D", "INV-N", "INV-P"]);
  });

  it("a resolved dispute resumes the reminders", async () => {
    db.current = fakePostgrest(seed([dispute, resolved]));
    const body = await (await dry("2026-11-03")).json();
    expect(ids(body)).toEqual(["INV-D", "INV-N", "INV-P"]);
    expect(body.on_hold).toEqual([]);
  });

  it("live run: nothing is emailed, logged or WhatsApped for a held customer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T04:00:00Z"));
    db.current = fakePostgrest(seed([promise("2026-11-05"), dispute]));
    const body = await (await live()).json();
    expect(body.emails_sent).toBe(1);
    expect(db.current.tables.invoice_dunning_log.map((l) => l.invoice_id)).toEqual(["INV-N"]);
    expect(wa.send).toHaveBeenCalledTimes(1);
    expect(wa.send.mock.calls[0][0]).toMatchObject({ subjectId: "INV-N" });
  });
});
