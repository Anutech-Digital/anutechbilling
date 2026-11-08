/**
 * R-2618 — the renewal path never reuses a linked PLAN-CHANGE quote as the renewal quote.
 *
 * Found in R-2590's independent review (8 Nov 2026): createOrGetRenewalQuote path 1 returned
 * whatever quote `subscriptions.renewal_quote_id` pointed at. A Change-plan quote (R-2227) is
 * linked there too, so the T-10..T-0 renewal reminders carried the plan-change amount, no real
 * renewal quote was made while it was valid, and paying it applied the plan change — renewed
 * nothing. Now path 1 reads the kind: a plan-change quote → a `held` result the callers show
 * the owner as "plan change pending"; the renewal quote is made after it is paid (record_payment
 * clears the link and applies the new plan — the next run prices the renewal on it) or expires
 * (R-2590 releases the link). Edge cases (1)–(13) on the card.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOrGetRenewalQuote, isRenewalQuoteHold, type CreateRenewalQuoteInput } from "./create-renewal-quote";

function fakeDb(linked?: Record<string, unknown> | null) {
  const updates: unknown[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    Object.assign(chain, {
      select: self, eq: self,
      then: (ok: (v: unknown) => unknown) => ok({ data: [], error: null }),
      maybeSingle: async () => ({
        data: table === "customers" ? { country: "India" } : table === "items" ? { msrp: 300, wholesale: 110 } : null,
        error: null,
      }),
      single: async () => ({ data: table === "quotes" ? linked ?? null : null, error: null }),
      update: (row: unknown) => { updates.push(row); return chain; },
    });
    return chain;
  };
  const rpc = vi.fn(async (fn: string, args: { p_quote: Record<string, unknown> }) => {
    if (fn !== "create_renewal_quote") return { data: null, error: { message: `unexpected rpc ${fn}` } };
    const p = args.p_quote;
    return { data: { quote_id: "Q-NEW", created: true, amount: p.amount, subtotal: p.subtotal, discount_pct: 0, tax_rate: 18, line_items: p.line_items }, error: null };
  });
  return { db: { from, rpc } as unknown as CreateRenewalQuoteInput["supabase"], rpc, updates };
}

const input = (db: CreateRenewalQuoteInput["supabase"], over: Partial<CreateRenewalQuoteInput> = {}): CreateRenewalQuoteInput => ({
  supabase: db, subscriptionId: "sub-1", tenantId: "ten-1", customerId: "cust-1", customerName: "Acme",
  plan: "Workspace Starter", itemId: "item-1", seats: 10, mrr: 3000, termMonths: 12,
  renewalDate: "2099-04-01", graceDays: 7, existingQuoteId: "Q-LINKED", ...over,
});

/** A Change-plan quote as R-2227 stores it: renewal-linked, buys no time, first line carries plan_change. */
const planChangeQuote = (over: Record<string, unknown> = {}) => ({
  id: "Q-LINKED", amount: 5900, subtotal: 5000, discount_pct: 0, tax_rate: 18,
  is_renewal: true, is_extension: false, extension_months: 0,
  line_items: [{ id: "l1", name: "Workspace Standard", qty: 10, rate: 500, cost: 300, plan_change: { subscription_id: "sub-1", from_seats: 10, from_mrr: 3000, new_mrr: 5000 } }],
  ...over,
});

describe("R-2618: a linked plan-change quote is never the renewal quote", () => {
  it("1. plan-change quote linked → held (plan_change_pending), names the quote, nothing made or written", async () => {
    const { db, rpc, updates } = fakeDb(planChangeQuote());
    const r = await createOrGetRenewalQuote(input(db));
    expect(r && isRenewalQuoteHold(r)).toBe(true);
    expect(r).toMatchObject({ held: "plan_change_pending", quoteId: "Q-LINKED" });
    expect(isRenewalQuoteHold(r) && r.message).toMatch(/Plan change quote Q-LINKED is pending/);
    expect(isRenewalQuoteHold(r) && r.message).toMatch(/after it is paid or expires/);
    // (11) R-2605 freeze / R-2613 link guard: nothing touches subscriptions or quotes
    expect(rpc).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("2. a real renewal quote (term months) or an extension quote (24/36) linked → returned unchanged, no re-pricing", async () => {
    for (const months of [12, 1, 24, 36]) {
      const { db, rpc } = fakeDb({ ...planChangeQuote(), extension_months: months, line_items: [{ qty: 10, rate: 3600 }] });
      const r = await createOrGetRenewalQuote(input(db));
      expect(r).toMatchObject({ quoteId: "Q-LINKED", amount: 5900, created: false, kind: "renewal" });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("3. a support-plan upgrade quote (R-2073) linked → unchanged today: returned with kind 'upgrade' (R-2093 labels it)", async () => {
    const { db, rpc } = fakeDb({ ...planChangeQuote(), line_items: [{ item_id: "SUP-PRO", qty: 1, rate: 5000 }] });
    const r = await createOrGetRenewalQuote(input(db));
    expect(r).toMatchObject({ quoteId: "Q-LINKED", created: false, kind: "upgrade" });
    expect(r && isRenewalQuoteHold(r)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("4. the plan-change quote's status or validity does not matter — expired-but-still-linked is held too (R-2590 releases the link)", async () => {
    for (const status of ["draft", "sent", "accepted", "expired"]) {
      const { db, rpc } = fakeDb(planChangeQuote({ status, expires_date: "2020-01-01" }));
      const r = await createOrGetRenewalQuote(input(db));
      expect(r).toMatchObject({ held: "plan_change_pending", quoteId: "Q-LINKED" });
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("5. the linked row is gone → path 2 makes the renewal quote as before", async () => {
    const { db, rpc } = fakeDb(null);
    const r = await createOrGetRenewalQuote(input(db));
    expect(r).toMatchObject({ quoteId: "Q-NEW", created: true, kind: "renewal" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("no link at all → path 2, never a hold", async () => {
    const { db, rpc } = fakeDb(planChangeQuote());
    const r = await createOrGetRenewalQuote(input(db, { existingQuoteId: null }));
    expect(r).toMatchObject({ quoteId: "Q-NEW", created: true });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

/* ── Wiring: every caller shows the hold to the owner, never sends or returns it as a renewal ── */
const src = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
/** Comments stripped, so prose about the rule cannot satisfy the scan. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("R-2618 wiring: the hold reaches the owner in plain words", () => {
  it("renewals cron: a held result sends no reminder, is counted as skipped, names the quote in errors, and the quote is never read as a renewal", () => {
    const c = code("app/api/cron/renewals/route.ts");
    const hold = c.indexOf("isRenewalQuoteHold(quoteResult)");
    const nullCheck = c.indexOf("if (!quoteResult) {");
    const use = c.indexOf("const renewalQuoteId = quoteResult.quoteId;");
    expect(hold).toBeGreaterThan(0);
    expect(nullCheck).toBeGreaterThan(hold);     // R-1571's hold stays, after this one
    expect(use).toBeGreaterThan(nullCheck);
    const block = c.slice(hold, nullCheck);
    expect(block).toContain("result.emails_skipped += 1");
    expect(block).toContain("result.errors.push({ subscription_id: sub.id, message: quoteResult.message })");
    expect(block).toMatch(/detail\.emailStatus = .*held: plan change/);
    expect(block).toContain("result.details.push(detail)");
    expect(block).toMatch(/return;\s*\}\s*$/);
  });

  it("Send now: a held result answers 409 with the owner message, before any reminder or log row", () => {
    const s = code("app/api/renewals/send-now/route.ts");
    const hold = s.indexOf("isRenewalQuoteHold(quoteResult)");
    const log = s.indexOf('from("renewal_email_log")');
    expect(hold).toBeGreaterThan(0);
    expect(log).toBeGreaterThan(hold);
    expect(s.slice(hold, hold + 400)).toMatch(/\{ error: quoteResult\.message \},\s*\{ status: 409 \}/);
  });

  it("Generate renewal quote: a held result answers 409 with the owner message and advances nothing", () => {
    const g = code("app/api/subscriptions/[id]/generate-renewal-quote/route.ts");
    const hold = g.indexOf("isRenewalQuoteHold(result)");
    const advance = g.indexOf('renewal_state: "notice_sent"');
    expect(hold).toBeGreaterThan(0);
    expect(advance).toBeGreaterThan(hold);
    expect(g.slice(hold, hold + 400)).toMatch(/\{ error: result\.message \},\s*\{ status: 409 \}/);
  });

  it("the helper decides the kind with isPlanChangeQuote (R-2227's marker), not a flag of its own", () => {
    const h = code("lib/renewals/create-renewal-quote.ts");
    expect(h).toContain("isPlanChangeQuote(");
    expect(h).toMatch(/held:\s*"plan_change_pending"/);
  });
});
