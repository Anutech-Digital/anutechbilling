import { describe, it, expect } from "vitest";
import { subscriptionSchedule, shortSplitTerm, currentTermStart } from "./subscription-schedule";
import { plannedInstalments } from "./instalments";
import { syncSubscriptionInstalments, type InstalmentSub } from "./sync-instalments.server";

/**
 * R-2543 (rv-train3, 6 Nov 2026 — train blocker for R-2533): R-2533 decided "short term" with
 * `uncheckedTermStart < start_date`. addMonths caps the day (31 Mar + 6 months = 30 Sep), so a
 * sale started on the 29th–31st counted back to a day BEFORE its start even with a full-term
 * renewal date, and got NO parts at all — silently. "Short" is now exactly the database's rule
 * (trg_subscriptions_zzz_split_term_covers): split-billed and renewal < addMonths(start, term) − 1
 * day. A short row gets a visible skip code ("short_term"), never a silent [].
 */
const sub = (start: string, renewal: string, term: number, cycle: "monthly" | "quarterly" | "half_yearly" | "yearly") => ({
  mrr: 1_000, billing_cycle: cycle, term_months: term, start_date: start, renewal_date: renewal,
});

const starts = (s: ReturnType<typeof sub>) => subscriptionSchedule(s).map((p) => p.periodStart);

describe("R-2543: late-month starts are not 'short'", () => {
  it("31 Mar 2026 + 6 months, quarterly, renewal 30 Sep 2026 (anniversary) → 2 parts from 31 Mar", () => {
    const s = sub("2026-03-31", "2026-09-30", 6, "quarterly");
    expect(shortSplitTerm(s)).toBeNull();
    expect(starts(s)).toEqual(["2026-03-31", "2026-06-30"]);
    expect(currentTermStart(s)).toBe("2026-03-31");
  });

  it("31 Mar 2026 + 6 months, the trigger's suggested date (29 Sep 2026, inclusive) → same 2 parts", () => {
    const s = sub("2026-03-31", "2026-09-29", 6, "quarterly");
    expect(shortSplitTerm(s)).toBeNull();
    expect(starts(s)).toEqual(["2026-03-31", "2026-06-30"]);
  });

  it("one day before the trigger's date (28 Sep 2026) IS short — the same line the database draws", () => {
    expect(shortSplitTerm(sub("2026-03-31", "2026-09-28", 6, "quarterly"))).toEqual({ minRenewal: "2026-09-29" });
    expect(subscriptionSchedule(sub("2026-03-31", "2026-09-28", 6, "quarterly"))).toEqual([]);
  });

  it("30 Jan 2026 + 1 month (monthly, one invoice a term) is never 'short' and keeps its one part", () => {
    const s = sub("2026-01-30", "2026-02-28", 1, "monthly");
    expect(shortSplitTerm(s)).toBeNull();
    expect(subscriptionSchedule(s)).toHaveLength(1);
  });

  it("30 Jan 2026 + 12 months paid monthly, renewal 30 Jan 2027 → 12 parts, first on 30 Jan", () => {
    const s = sub("2026-01-30", "2027-01-30", 12, "monthly");
    expect(shortSplitTerm(s)).toBeNull();
    const p = starts(s);
    expect(p).toHaveLength(12);
    expect(p[0]).toBe("2026-01-30");
  });

  it("29 Feb 2024 + 12 months, quarterly, renewal 28 Feb 2025 (anniversary) and 27 Feb 2025 (trigger date) → 4 parts from 29 Feb", () => {
    for (const renewal of ["2025-02-28", "2025-02-27"]) {
      const s = sub("2024-02-29", renewal, 12, "quarterly");
      expect(shortSplitTerm(s)).toBeNull();
      const p = starts(s);
      expect(p).toHaveLength(4);
      expect(p[0]).toBe("2024-02-29");
    }
  });

  it("31 Aug 2026 + 6 months, quarterly, renewal 28 Feb 2027 and 27 Feb 2027 → 2 parts from 31 Aug", () => {
    for (const renewal of ["2027-02-28", "2027-02-27"]) {
      const s = sub("2026-08-31", renewal, 6, "quarterly");
      expect(shortSplitTerm(s)).toBeNull();
      expect(starts(s)).toEqual(["2026-08-31", "2026-11-30"]);
    }
  });

  it("Suresh: start 19 Jun 2026, renewal 19 Dec 2026, 12 months half-yearly → short (min 18 Jun 2027), no parts", () => {
    const s = sub("2026-06-19", "2026-12-19", 12, "half_yearly");
    expect(shortSplitTerm(s)).toEqual({ minRenewal: "2027-06-18" });
    expect(subscriptionSchedule(s)).toEqual([]);
  });

  it("Suresh repaired: renewal 19 Jun 2027 → 2 parts with term_start 19 Jun 2026", () => {
    const parts = plannedInstalments(sub("2026-06-19", "2027-06-19", 12, "half_yearly"));
    expect(parts.map((p) => [p.termStart, p.periodStart])).toEqual([
      ["2026-06-19", "2026-06-19"],
      ["2026-06-19", "2026-12-19"],
    ]);
  });

  it("yearly (co-termed, one invoice) is never 'short' — it keeps the counted-back term it always showed", () => {
    expect(shortSplitTerm(sub("2026-01-10", "2026-12-31", 12, "yearly"))).toBeNull();
  });
});

describe("R-2543: syncSubscriptionInstalments says why a short term lays nothing", () => {
  it("returns skip code short_term with the date to set — and touches no table", async () => {
    const calls: string[] = [];
    const db = new Proxy({}, { get: (_t, k) => () => { calls.push(String(k)); throw new Error("no db call expected"); } });
    const s: InstalmentSub = {
      id: "s1", tenant_id: "t1", quote_id: null, mrr: 13_125, billing_cycle: "half_yearly", term_months: 12,
      start_date: "2026-06-19", renewal_date: "2026-12-19",
    };
    const r = await syncSubscriptionInstalments({ supabase: db as never, sub: s, quote: undefined, todayISO: "2026-11-06" });
    expect(r.skip?.code).toBe("short_term");
    expect(r.skip?.reason).toContain("18 Jun 2027");
    expect(r.created).toBe(0);
    expect(calls).toEqual([]);
  });
});
