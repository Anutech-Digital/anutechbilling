/** R-2727 review (MED): the server loaders (PDF, email, WhatsApp, accept page, renewal cron) read the
 *  renewed subscription's start + term too — so they print billing's next-term start. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { loadInvoicePeriodRuleFrom, loadQuotePeriodContext, loadRenewedSubscription } from "./line-period-context";
import { linePeriodText } from "./service-period";

function fakeDb(row: Record<string, unknown> | null) {
  const calls: Array<[string, unknown]> = [];
  const chain = {
    select: (cols: string) => { calls.push(["select", cols]); return chain; },
    eq: (c: string, v: unknown) => { calls.push([c, v]); return chain; },
    limit: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { db: { from: () => chain }, calls };
}

/* A domain renewal quote stores its own domain (createDomainRenewalQuote). */
const quote = { id: "Q-1", tenant_id: "t1", is_renewal: true, extension_months: 12, renewal_term_date: "2027-09-04", renewal_subscription_id: "sub-1", domain: "rajpharma.in" };
const line = { name: "Domain rajpharma.in", commitment: "annual_yearly" };

describe("loadQuotePeriodContext — billing's next-term start", () => {
  it("app-made subscription (start 4 Sep 2026, yearly): the PDF period starts ON 4 Sep 2027 — read even though the quote has its own domain", async () => {
    const { db, calls } = fakeDb({ domain: "rajpharma.in", start_date: "2026-09-04", term_months: 12 });
    const ctx = await loadQuotePeriodContext(db, quote as never);
    expect(calls).toEqual([["select", "domain, start_date, term_months"], ["tenant_id", "t1"], ["id", "sub-1"]]);
    expect(linePeriodText(line, ctx)).toBe("Subscription period: 1 Year (04/09/2027 – 03/09/2028)");
  });
  it("Zoho-import row (renewal_date = last day): the day after, as before", async () => {
    const { db } = fakeDb({ domain: null, start_date: "2026-09-05", term_months: 12 });
    const ctx = await loadQuotePeriodContext(db, quote as never);
    expect(linePeriodText(line, ctx)).toBe("Subscription period: 1 Year (05/09/2027 – 04/09/2028)");
    expect(ctx.domain).toBe("rajpharma.in");   // the quote's own domain still wins
  });
  it("subscription unreadable → the old day-after rule; a new sale reads nothing", async () => {
    const down = { from: () => { throw new Error("down"); } };
    expect(linePeriodText(line, await loadQuotePeriodContext(down, quote as never))).toBe("Subscription period: 1 Year (05/09/2027 – 04/09/2028)");
    const { db, calls } = fakeDb({ start_date: "2026-09-04" });
    expect(await loadRenewedSubscription(db, { ...quote, is_renewal: false } as never)).toBeNull();
    expect(calls).toEqual([]);
  });
  it("the fallback is not silent: a failed read or a missing subscription logs a warning with tenant + quote id only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadRenewedSubscription({ from: () => { throw new Error("down"); } }, quote as never);
    await loadRenewedSubscription(fakeDb(null).db, quote as never);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toBe("[line-period] tenant t1 quote Q-1: renewed subscription not read (down) — renewal period uses the day after renewal_term_date");
    expect(warn.mock.calls[1][0]).toContain("renewed subscription not found");
    expect(String(warn.mock.calls.flat())).not.toContain("rajpharma");
  });
});
afterEach(() => vi.restoreAllMocks());

describe("loadInvoicePeriodRuleFrom — when the invoice period rule went live on this database", () => {
  it("reads app_rule_dates by the rule key and returns from_at", async () => {
    const { db, calls } = fakeDb({ from_at: "2026-11-13T10:00:00+00:00" });
    expect(await loadInvoicePeriodRuleFrom(db)).toBe("2026-11-13T10:00:00+00:00");
    expect(calls).toEqual([["select", "from_at"], ["key", "r2727_invoice_period_rule"]]);
  });
  it("no row yet (migration not applied), an unparsable value, or a failed read → null (the old rule)", async () => {
    expect(await loadInvoicePeriodRuleFrom(fakeDb(null).db)).toBeNull();
    expect(await loadInvoicePeriodRuleFrom(fakeDb({ from_at: "soon" }).db)).toBeNull();
    expect(await loadInvoicePeriodRuleFrom({ from: () => { throw new Error("down"); } })).toBeNull();
  });
});
