/**
 * R-371 (P0 money) — the dunning reminder must ask for what is actually owed.
 *
 * It computed `amount − paid_amount`, ignoring `net_payable` (lowered at issue by a credit
 * note or an adjusted advance). Local evidence: INV-9B8C-2026-27-0003 — amount ₹11,800,
 * credit note ₹1,180, net_payable ₹10,620, paid 0 — the reminder asked for ₹11,800.
 *
 * A LIVE pass (not dry) with the clock pinned, so the customer email, the reseller
 * escalation and the WhatsApp values are all actually built and can be read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
      id: "INV-9B8C-2026-27-0003", tenant_id: "T1", customer_id: "C1", customer_name: "Cust",
      status: "pending", quote_id: null, paid_amount: 0, ...inv,
    }],
    invoice_dunning_log: [],
    tenants: [{ id: "T1", name: "Seller", email: "owner@example.invalid", auto_suspend_on_overdue: false, upi_vpa: "seller@upi", upi_payee_name: "Seller" }],
    subscriptions: [],
  };
}

/** Record the column list of every select so the test can prove net_payable is READ. */
function spySelects() {
  const cols: Record<string, string[]> = {};
  const inner = db.current!.client;
  db.current!.client = {
    from: (t: string) => {
      const b = inner.from(t) as unknown as { select: (c?: string, o?: unknown) => unknown };
      const orig = b.select.bind(b);
      b.select = (c?: string, o?: unknown) => { (cols[t] ??= []).push(c ?? ""); return orig(c, o); };
      return b as never;
    },
  } as never;
  return cols;
}

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  sent.emails.length = 0; sent.wa.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T06:30:00Z"));   // 12:00 IST, 10 Oct
});
afterEach(() => { vi.useRealTimers(); process.env = { ...ENV }; });

describe("R-371 dunning amount = net_payable − paid_amount", () => {
  it("credit-note invoice: reminder asks ₹10,620, not ₹11,800 (and the select reads net_payable)", async () => {
    db.current = fakePostgrest(seed({ amount: 11800, net_payable: 10620, due_date: "2026-10-03" }) as never);
    const cols = spySelects();
    const body = await (await GET(live())).json();
    expect(body.details).toHaveLength(1);
    expect(cols.invoices.join(",")).toContain("net_payable");
    const customer = sent.emails.find((e) => e.to === "cust@example.invalid")!;
    expect(customer.text).toContain("10,620");
    expect(customer.text).not.toContain("11,800");
    expect(String(sent.wa[0].amount)).toContain("10,620");
  });

  it("advance-adjusted invoice with a later part-receipt: asks net_payable − paid", async () => {
    // ₹50,000 invoice, ₹20,000 advance folded in at issue (net 30,000), ₹5,000 received since.
    db.current = fakePostgrest(seed({ amount: 50000, net_payable: 30000, paid_amount: 5000, due_date: "2026-10-03" }) as never);
    await GET(live());
    const customer = sent.emails.find((e) => e.to === "cust@example.invalid")!;
    expect(customer.text).toContain("25,000");
    expect(customer.text).not.toContain("45,000");
  });

  it("fully covered by advance (net_payable 0): nobody is chased", async () => {
    db.current = fakePostgrest(seed({ amount: 10000, net_payable: 0, due_date: "2026-10-03" }) as never);
    const body = await (await GET(live())).json();
    expect(body.details).toHaveLength(0);
    expect(sent.emails).toHaveLength(0);
  });

  it("escalation to the reseller states the real outstanding", async () => {
    // 30 days late → escalate step; the owner mail must carry 10,620 too.
    db.current = fakePostgrest(seed({ amount: 11800, net_payable: 10620, due_date: "2026-09-01" }) as never);
    const body = await (await GET(live())).json();
    expect(body.details[0].action).toBe("escalate");
    const owner = sent.emails.find((e) => e.to === "owner@example.invalid")!;
    expect(owner.text).toContain("10,620");
    for (const e of sent.emails) expect(e.text).not.toContain("11,800");
  });

  it("old rows with no net_payable still fall back to amount − paid", async () => {
    db.current = fakePostgrest(seed({ amount: 11800, net_payable: null, paid_amount: 800, due_date: "2026-10-03" }) as never);
    await GET(live());
    expect(sent.emails.find((e) => e.to === "cust@example.invalid")!.text).toContain("11,000");
  });
});
