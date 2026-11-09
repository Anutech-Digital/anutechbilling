/**
 * R-2619 — two follow-ups from R-2618's independent check (9 Nov 2026, LOW 1 + 2).
 *
 * (1) Before letting go of a CLOSED plan-change quote, path 1 read only quotes.payment_status and
 *     invoice_id. R-2590's release (release_expired_plan_change_quotes) also refuses when a
 *     `payments` row with status 'received' is on the quote — money rule N6 says "as R-2590", so the
 *     helper now checks that row too (tenant-scoped); a failed read holds, never lets go.
 * (2) Between that unlink and create_renewal_quote, a Change plan pressed at the same moment can link
 *     a NEW plan-change quote. The RPC's step 1 returns any linked quote as created:false, and path 2
 *     labelled it kind 'renewal' — the reminder would carry the plan-change amount. Now a created:false
 *     answer is re-read: a plan-change quote → held (never sent as a renewal); anything else keeps the
 *     kind its row says (quoteDocumentKind); an unreadable row → null (nothing sent, retried).
 * Edge cases (1)–(10) on the card.
 */
import { describe, it, expect, vi } from "vitest";
import { createOrGetRenewalQuote, isRenewalQuoteHold, type CreateRenewalQuoteInput } from "./create-renewal-quote";

type Filters = [string, unknown][];
interface Opts {
  /** path-1 linked quote (quotes .single()) */
  linked?: Record<string, unknown> | null;
  /** payments rows the money check finds, or a read error */
  payments?: Record<string, unknown>[] | { error: string };
  /** what create_renewal_quote answers */
  made?: Record<string, unknown>;
  /** the created:false re-read (quotes .maybeSingle()), or a read error */
  reread?: Record<string, unknown> | null | { error: string };
}

function fakeDb(opts: Opts) {
  const writes: { table: string; row: unknown; filters: Filters }[] = [];
  const reads: { table: string; filters: Filters }[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const filters: Filters = [];
    let write: { table: string; row: unknown; filters: Filters } | null = null;
    const read = { table, filters };
    reads.push(read);
    Object.assign(chain, {
      select: () => chain,
      limit: () => chain,
      eq: (col: string, val: unknown) => { (write ? write.filters : filters).push([col, val]); return chain; },
      then: (ok: (v: unknown) => unknown) => {
        if (table === "payments") {
          const p = opts.payments ?? [];
          return ok(Array.isArray(p) ? { data: p, error: null } : { data: null, error: { message: p.error } });
        }
        return ok({ data: [], error: null });
      },
      maybeSingle: async () => {
        if (table === "quotes") {
          const r = opts.reread;
          if (r && "error" in r) return { data: null, error: { message: r.error as string } };
          return { data: r ?? null, error: null };
        }
        return { data: table === "customers" ? { country: "India" } : table === "items" ? { msrp: 300, wholesale: 110 } : null, error: null };
      },
      single: async () => ({ data: table === "quotes" ? opts.linked ?? null : null, error: null }),
      update: (row: unknown) => { write = { table, row, filters: [] }; writes.push(write); return chain; },
    });
    return chain;
  };
  const rpc = vi.fn(async (fn: string, args: { p_quote: Record<string, unknown> }) => {
    if (fn !== "create_renewal_quote") return { data: null, error: { message: `unexpected rpc ${fn}` } };
    const p = args.p_quote;
    return {
      data: opts.made ?? { quote_id: "Q-NEW", created: true, amount: p.amount, subtotal: p.subtotal, discount_pct: 0, tax_rate: 18, line_items: p.line_items },
      error: null,
    };
  });
  return { db: { from, rpc } as unknown as CreateRenewalQuoteInput["supabase"], rpc, writes, reads };
}

const input = (db: CreateRenewalQuoteInput["supabase"], over: Partial<CreateRenewalQuoteInput> = {}): CreateRenewalQuoteInput => ({
  supabase: db, subscriptionId: "sub-1", tenantId: "ten-1", customerId: "cust-1", customerName: "Acme",
  plan: "Workspace Starter", itemId: "item-1", seats: 10, mrr: 3000, termMonths: 12,
  renewalDate: "2099-04-01", graceDays: 7, existingQuoteId: "Q-LINKED", ...over,
});

/** A Change-plan quote as R-2227 stores it: renewal-linked, buys no time, first line carries plan_change. */
const planChangeQuote = (over: Record<string, unknown> = {}) => ({
  id: "Q-LINKED", amount: 5900, subtotal: 5000, discount_pct: 0, tax_rate: 18,
  is_renewal: true, is_extension: false, extension_months: 0, status: "sent", superseded_by: null,
  payment_status: "none", invoice_id: null,
  line_items: [{ id: "l1", name: "Workspace Standard", qty: 10, rate: 500, cost: 300, plan_change: { subscription_id: "sub-1", from_seats: 10, from_mrr: 3000, new_mrr: 5000 } }],
  ...over,
});
const closed = planChangeQuote({ status: "rejected" });

describe("R-2619 (1): a closed plan-change quote with a RECEIVED payments row is never let go (as R-2590)", () => {
  it("1. payment_status none + no invoice, but a 'received' payments row on the quote → held 'settle or refund', no unlink, no RPC; the read is tenant-scoped", async () => {
    const { db, rpc, writes, reads } = fakeDb({ linked: closed, payments: [{ id: "PAY-1" }] });
    const r = await createOrGetRenewalQuote(input(db));
    expect(r).toMatchObject({ held: "plan_change_pending", quoteId: "Q-LINKED" });
    expect(isRenewalQuoteHold(r) && r.message).toMatch(/payment or invoice/);
    expect(isRenewalQuoteHold(r) && r.message).toMatch(/Settle or refund/);
    expect(rpc).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    const pay = reads.find((x) => x.table === "payments");
    expect(pay?.filters).toEqual(expect.arrayContaining([["tenant_id", "ten-1"], ["quote_id", "Q-LINKED"], ["status", "received"]]));
  });

  it("2. no received payments row (none found) → unlinked on the same link, real renewal quote made (R-2618 unchanged)", async () => {
    const { db, rpc, writes } = fakeDb({ linked: closed, payments: [] });
    const r = await createOrGetRenewalQuote(input(db));
    expect(r).toMatchObject({ quoteId: "Q-NEW", created: true, kind: "renewal" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].filters).toEqual(expect.arrayContaining([["renewal_quote_id", "Q-LINKED"]]));
  });

  it("1b. payment_status partial / received / invoiced, or an invoice_id → held at once (no payments read needed), never unlinked", async () => {
    for (const over of [{ payment_status: "partial" }, { payment_status: "received" }, { payment_status: "invoiced" }, { invoice_id: "INV-9" }]) {
      const { db, rpc, writes, reads } = fakeDb({ linked: planChangeQuote({ status: "rejected", ...over }), payments: [] });
      const r = await createOrGetRenewalQuote(input(db));
      expect(r).toMatchObject({ held: "plan_change_pending", quoteId: "Q-LINKED" });
      expect(rpc).not.toHaveBeenCalled();
      expect(writes).toHaveLength(0);
      expect(reads.some((x) => x.table === "payments")).toBe(false);
    }
  });

  it("3. the payments read fails → held with the reason, nothing unlinked, no RPC (never let go on an unknown)", async () => {
    const { db, rpc, writes } = fakeDb({ linked: closed, payments: { error: "timeout" } });
    const r = await createOrGetRenewalQuote(input(db));
    expect(r).toMatchObject({ held: "plan_change_pending", quoteId: "Q-LINKED" });
    expect(isRenewalQuoteHold(r) && r.message).toMatch(/timeout/);
    expect(rpc).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

describe("R-2619 (2): the RPC's created:false answer is re-checked — a plan-change quote is never sent as the renewal", () => {
  const noLink = { existingQuoteId: null };

  it("4. created:false and the returned quote is an OPEN plan-change quote (Change plan linked it meanwhile) → held 'pending', never kind 'renewal'", async () => {
    const pc = planChangeQuote({ id: "Q-PC" });
    const { db } = fakeDb({ made: { quote_id: "Q-PC", created: false, relinked: false, amount: 5900, subtotal: 5000, discount_pct: 0, tax_rate: 18, line_items: pc.line_items }, reread: pc });
    const r = await createOrGetRenewalQuote(input(db, noLink));
    expect(r).toMatchObject({ held: "plan_change_pending", quoteId: "Q-PC" });
    expect(isRenewalQuoteHold(r) && r.message).toMatch(/Plan change quote Q-PC is pending/);
  });

  it("5. created:false and the returned plan-change quote is CLOSED → still held (next run's path 1 sorts the link out)", async () => {
    const pc = planChangeQuote({ id: "Q-PC", status: "rejected" });
    const { db, writes } = fakeDb({ made: { quote_id: "Q-PC", created: false, amount: 5900, subtotal: 5000, discount_pct: 0, tax_rate: 18, line_items: pc.line_items }, reread: pc });
    const r = await createOrGetRenewalQuote(input(db, noLink));
    expect(r).toMatchObject({ held: "plan_change_pending", quoteId: "Q-PC" });
    expect(isRenewalQuoteHold(r) && r.message).toMatch(/closed but still linked.*Retried next run/);
    expect(writes).toHaveLength(0);
  });

  it("6. created:false and the returned quote is a real renewal / extension / support upgrade → returned, kind from its own row", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ id: "Q-R", is_renewal: true, extension_months: 12, line_items: [{ qty: 10, rate: 3600 }] }, "renewal"],
      [{ id: "Q-R", is_renewal: true, extension_months: 24, line_items: [{ qty: 10, rate: 3600 }] }, "renewal"],
      [{ id: "Q-R", is_renewal: true, extension_months: 0, line_items: [{ item_id: "SUP-PRO", qty: 1, rate: 5000 }] }, "upgrade"],
    ];
    for (const [row, kind] of cases) {
      const { db } = fakeDb({ made: { quote_id: "Q-R", created: false, relinked: true, amount: 42480, subtotal: 36000, discount_pct: 0, tax_rate: 18, line_items: [] }, reread: row });
      const r = await createOrGetRenewalQuote(input(db, noLink));
      expect(r).toMatchObject({ quoteId: "Q-R", amount: 42480, created: false, kind });
    }
  });

  it("7. created:false and the re-read fails or finds no row → null and logged; nothing goes out on an unchecked quote", async () => {
    for (const reread of [{ error: "boom" }, null]) {
      const { db } = fakeDb({ made: { quote_id: "Q-X", created: false, amount: 1, subtotal: 1, discount_pct: 0, tax_rate: 18, line_items: [] }, reread });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const r = await createOrGetRenewalQuote(input(db, noLink));
      expect(r).toBeNull();
      expect(err.mock.calls.flat().join(" ")).toContain("Q-X");
      err.mockRestore();
    }
  });

  it("8. created:true → no extra quotes read (the RPC just made a renewal priced here)", async () => {
    const { db, reads } = fakeDb({});
    const r = await createOrGetRenewalQuote(input(db, noLink));
    expect(r).toMatchObject({ quoteId: "Q-NEW", created: true, kind: "renewal" });
    expect(reads.filter((x) => x.table === "quotes")).toHaveLength(0);
  });
});
