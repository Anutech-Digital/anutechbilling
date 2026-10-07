/**
 * WC-scale: invoice dunning reads every chaseable invoice and its whole history.
 *
 * The fake client cuts every read at 1000 rows like PostgREST's max_rows. Pinned:
 *   - 2,500 overdue invoices are all considered (was: the first 1,000);
 *   - no `.in()` list is longer than 200 ids;
 *   - a chunk whose dunning history is longer than one page is read to the end, so a step
 *     that already went out is not decided again;
 *   - the subscription behind an invoice is prefetched (no per-invoice lookup), and a quote
 *     with two subscriptions still counts as "none" — as maybeSingle() made it before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakePostgrest } from "@/lib/ops/fake-postgrest.testutil";

const db = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("@/lib/ops/fake-postgrest.testutil").fakePostgrest> }));
vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => db.current!.client }));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ status: "sent" })), isEmailConfigured: () => false }));
vi.mock("@/lib/contacts/primary", () => ({ primaryContactEmail: vi.fn(async () => ({ email: null, name: null, fromLegacy: false })) }));
vi.mock("@/lib/marketing/whatsapp-reminders.server", () => ({
  createReminderSender: () => ({ send: vi.fn(async () => ({ status: "disabled" })), totals: { sent: 0, skipped: 0, failed: 0, disabled: 0 } }),
}));

import { GET } from "./route";

const req = () => new Request("https://example.invalid/api/cron/invoice-dunning?dry=1&on=2026-09-30", { headers: { authorization: "Bearer s3cret" } });
const ENV = { ...process.env };
const pad = (i: number) => String(i).padStart(5, "0");

/** 2,500 unpaid invoices, 20 days past due on 30 Sep (→ the "final" step). */
function seed() {
  const invoices = Array.from({ length: 2500 }, (_, i) => ({
    id: `INV-${pad(i)}`, tenant_id: i % 3 === 0 ? "T-suspend" : "T-plain", customer_id: `C${i}`, customer_name: `Cust ${i}`,
    amount: 1000, paid_amount: 0, status: "overdue", due_date: "2026-09-10", quote_id: i < 3 ? `Q${i}` : null,
  }));
  /* The first 200 invoices (one .in() chunk) have SIX log rows each = 1,200 rows: more than
     one page. Every one of them already had the final step. */
  const steps = ["pre_due", "due_today", "reminder", "retry", "grace_warning", "final"];
  const logs = invoices.slice(0, 200).flatMap((inv, i) =>
    steps.map((step, k) => ({ id: `L${pad(i)}-${k}`, invoice_id: inv.id, dunning_step: step })));
  return {
    invoices: [...invoices, { id: "INV-PAID", tenant_id: "T-plain", status: "paid", due_date: "2026-09-10", amount: 1, paid_amount: 1 }],
    invoice_dunning_log: logs,
    tenants: [
      { id: "T-suspend", name: "S", email: null, auto_suspend_on_overdue: true, upi_vpa: null, upi_payee_name: null },
      { id: "T-plain", name: "P", email: null, auto_suspend_on_overdue: false, upi_vpa: null, upi_payee_name: null },
    ],
    subscriptions: [],
  };
}

beforeEach(() => { process.env.CRON_SECRET = "s3cret"; });
afterEach(() => { process.env = { ...ENV }; });

describe("invoice-dunning at scale", () => {
  it("considers every chaseable invoice, and skips the ones whose history (> 1 page) says final already went", async () => {
    db.current = fakePostgrest(seed());
    const body = await (await GET(req())).json();
    expect(body.considered).toBe(2500);
    expect(body.skipped).toBe(200);
    expect(body.details).toHaveLength(2300);
    const decided = new Set(body.details.map((d: { invoice_id: string }) => d.invoice_id));
    expect(decided.has("INV-00000")).toBe(false);
    expect(decided.has("INV-00199")).toBe(false);
    expect(decided.has("INV-00200")).toBe(true);
    expect(decided.has("INV-02499")).toBe(true);
  });

  it("never sends an .in() list longer than 200 ids", async () => {
    db.current = fakePostgrest(seed());
    await GET(req());
    const sizes = db.current.calls.flatMap((c) => c.inLists.filter((l) => l.col !== "status").map((l) => l.size));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
  });

  it("prefetches subscriptions by quote (no per-invoice lookup); a quote with two subscriptions is 'none'", async () => {
    const data = seed();
    /* Fresh history for the three quoted invoices so each gets decided. */
    data.invoice_dunning_log = data.invoice_dunning_log.filter((l) => !["INV-00000", "INV-00001", "INV-00002"].includes(l.invoice_id));
    data.invoices[1].tenant_id = "T-suspend";
    data.invoices[2].tenant_id = "T-suspend";
    (data.subscriptions as unknown[]).push(
      { id: "S0", quote_id: "Q0" },
      { id: "S1", quote_id: "Q1" },
      { id: "S2a", quote_id: "Q2" }, { id: "S2b", quote_id: "Q2" },
    );
    db.current = fakePostgrest(data);
    const body = await (await GET(req())).json();
    const byId = new Map(body.details.map((d: { invoice_id: string; action: string }) => [d.invoice_id, d.action]));
    /* R-116: Day 14 of the ladder no longer pauses — the company's own N-day rule does that,
       after a final notice (runOverdueSuspension). So every one of these tells the reseller. */
    expect(byId.get("INV-00000")).toBe("escalate");
    expect(byId.get("INV-00001")).toBe("escalate");
    expect(byId.get("INV-00002")).toBe("escalate");       // ambiguous → no subscription to suspend
    const subReads = db.current.calls.filter((c) => c.table === "subscriptions" && c.inLists.some((l) => l.col === "quote_id"));
    expect(subReads.length).toBe(1);                       // one chunk of quote ids, not one per invoice
    expect(subReads[0].filters.some((f) => f.startsWith("quote_id="))).toBe(false);
  });

  /* R-346: "Activate now, pay later" invoices are followed up by the owner's tasks only —
     no customer message, never an automatic suspension. */
  it("skips invoices of quotes activated on credit (no email, no suspend)", async () => {
    const data = seed() as ReturnType<typeof seed> & { quotes?: unknown[] };
    data.invoice_dunning_log = data.invoice_dunning_log.filter((l) => !["INV-00000", "INV-00001"].includes(l.invoice_id));
    (data.subscriptions as unknown[]).push({ id: "S0", quote_id: "Q0" }, { id: "S1", quote_id: "Q1" });
    data.quotes = [
      { id: "Q0", credit_activated_at: "2026-09-01T05:00:00Z" },
      { id: "Q1", credit_activated_at: null },
    ];
    db.current = fakePostgrest(data as never);
    const body = await (await GET(req())).json();
    const decided = new Set(body.details.map((d: { invoice_id: string }) => d.invoice_id));
    expect(decided.has("INV-00000")).toBe(false);   // on credit → skipped
    expect(decided.has("INV-00001")).toBe(true);    // ordinary invoice → chased as before
    expect(body.skipped).toBe(199);                  // 198 with final already sent + the credit one
  });

  it("before the migration (no credit column) the run carries on unchanged", async () => {
    db.current = fakePostgrest(seed());
    const inner = db.current.client;
    db.current.client = {
      from: (t: string) => {
        const b = inner.from(t) as unknown as Record<string, unknown>;
        if (t === "quotes") {
          b.then = (ok: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { code: "42703", message: "column quotes.credit_activated_at does not exist" } }).then(ok);
        }
        return b as never;
      },
    };
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).considered).toBe(2500);
  });

  it("any other failure reading credit quotes stops the run (500)", async () => {
    db.current = fakePostgrest(seed());
    const inner = db.current.client;
    db.current.client = {
      from: (t: string) => {
        const b = inner.from(t) as unknown as Record<string, unknown>;
        if (t === "quotes") {
          b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(ok);
        }
        return b as never;
      },
    };
    expect((await GET(req())).status).toBe(500);
  });

  it("a failed history read stops the run (500) instead of re-sending steps", async () => {
    db.current = fakePostgrest(seed());
    const inner = db.current.client;
    db.current.client = {
      from: (t: string) => {
        const b = inner.from(t) as unknown as Record<string, unknown>;
        if (t === "invoice_dunning_log") {
          b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "boom" } }).then(ok);
        }
        return b as never;
      },
    };
    const res = await GET(req());
    expect(res.status).toBe(500);
  });
});
