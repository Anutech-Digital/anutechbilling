/**
 * R-2849 — a renewal quote billed together (R-2847) has no quote-level renewal_term_date: each line carries its own
 * subscription_id + renewal_term_date. The quote page / PDF / email print EACH line's own period (billing's
 * followingTermStart from that subscription's start + term — the rule R-2848's invoice stamp uses) and its own domain.
 */
import { describe, it, expect } from "vitest";
import { linePeriodText, lineSubscriptionNotes, quoteLinePeriodContext, togetherLineSubscriptions } from "./service-period";
import { loadQuotePeriodContext } from "./line-period-context";

const STD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/* As create_renewal_quote_together stores them */
const lineStd = { name: "Business Standard", commitment: "annual_yearly", qty: 20, rate: 1080, subscription_id: STD, renewal_term_date: "2026-10-31", period_start: "2026-10-31", period_end: "2027-10-30" };
const lineSta = { name: "Business Starter", commitment: "annual_yearly", qty: 10, rate: 1632.5, subscription_id: STA, renewal_term_date: "2026-11-15", period_start: "2026-11-15", period_end: "2027-11-14" };
const quote = { id: "Q-T", tenant_id: "t1", is_renewal: true, extension_months: 12, renewal_term_date: null, renewal_subscription_id: null, created_date: "2026-10-20", domain: null };

describe("R-2849 together lines", () => {
  it("R-2849 together lines: each line prints ITS subscription's next year and domain", () => {
    const ctx = quoteLinePeriodContext(quote, {
      domain: "itbuzz.in", start_date: "2025-10-31", term_months: 12,
      lines: { [STD]: { domain: "itbuzz.in", start_date: "2025-10-31", term_months: 12 }, [STA]: { domain: "itbuzz.co", start_date: "2024-11-16", term_months: 12 } },
    });
    expect(lineSubscriptionNotes(lineStd, ctx)).toEqual(["Domain: itbuzz.in", "Subscription period: 1 Year (31/10/2026 – 30/10/2027)"]);
    /* Business Starter: an imported row whose renewal date is its term's LAST day → its next year starts the day after */
    expect(lineSubscriptionNotes(lineSta, ctx)).toEqual(["Domain: itbuzz.co", "Subscription period: 1 Year (16/11/2026 – 15/11/2027)"]);
  });

  it("subscriptions not read → the line's own stored start (what the RPC wrote) — never no period, never the other line's", () => {
    const ctx = quoteLinePeriodContext(quote, null);
    expect(linePeriodText(lineStd, ctx)).toBe("Subscription period: 1 Year (31/10/2026 – 30/10/2027)");
    expect(linePeriodText(lineSta, ctx)).toBe("Subscription period: 1 Year (15/11/2026 – 14/11/2027)");
  });

  it("a single renewal quote is unchanged (no subscription_id on its line)", () => {
    const ctx = quoteLinePeriodContext({ ...quote, renewal_term_date: "2026-10-31", renewal_subscription_id: STD }, { start_date: "2025-10-31", term_months: 12 });
    expect(linePeriodText({ name: "Business Standard", commitment: "annual_yearly" }, ctx)).toBe("Subscription period: 1 Year (31/10/2026 – 30/10/2027)");
  });

  it("togetherLineSubscriptions: the subscriptions the lines name, from the customer's list; none → null", () => {
    const subs = [{ id: STD, domain: "itbuzz.in", start_date: "2025-10-31", term_months: 12 }, { id: "x", domain: null, start_date: null, term_months: 12 }];
    expect(togetherLineSubscriptions([lineStd, lineSta], subs)).toEqual({ [STD]: { domain: "itbuzz.in", start_date: "2025-10-31", term_months: 12 } });
    expect(togetherLineSubscriptions([{ name: "x" } as never], subs)).toBeNull();
  });

  it("server loader: a together quote reads its link rows, then each subscription (tenant-scoped)", async () => {
    const calls: Array<[string, string, unknown]> = [];
    const db = {
      from: (t: string) => {
        const chain: Record<string, unknown> = {};
        const result = t === "renewal_quote_subscriptions"
          ? { data: [{ subscription_id: STD, line_no: 1 }, { subscription_id: STA, line_no: 2 }], error: null }
          : { data: [{ id: STD, domain: "itbuzz.in", start_date: "2025-10-31", term_months: 12 }, { id: STA, domain: "itbuzz.co", start_date: "2024-11-16", term_months: 12 }], error: null };
        Object.assign(chain, {
          select: () => chain,
          eq: (c: string, v: unknown) => { calls.push([t, c, v]); return chain; },
          in: (c: string, v: unknown) => { calls.push([t, c, v]); return chain; },
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (ok: (v: unknown) => unknown) => ok(result),
        });
        return chain;
      },
    };
    const ctx = await loadQuotePeriodContext(db as never, quote as never);
    expect(calls).toEqual([
      ["renewal_quote_subscriptions", "tenant_id", "t1"], ["renewal_quote_subscriptions", "quote_id", "Q-T"],
      ["subscriptions", "tenant_id", "t1"], ["subscriptions", "id", [STD, STA]],
    ]);
    expect(ctx.domain).toBe("itbuzz.in");
    expect(linePeriodText(lineSta, ctx)).toBe("Subscription period: 1 Year (16/11/2026 – 15/11/2027)");
  });
});
