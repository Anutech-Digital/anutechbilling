/**
 * R-808 — a subscription billed in parts renews without a whole-term renewal quote.
 *
 * PROOF of the bug (local DB, real record_payment + generate_invoice +
 * raise_subscription_billing, rolled back, 10 Oct 2026): quarterly, 8 seats, mrr ₹2,160,
 * term 1 Nov 2025 → 1 Nov 2026, all four Year-1 quarters invoiced and paid. The whole-year
 * renewal quote (₹30,586) was paid → renewal_date 1 Nov 2027 and one PAID whole-year
 * invoice ₹30,586. The billing cron then laid 1 Nov 2026 / 1 Feb / 1 May / 1 Aug 2027 and
 * raised them PENDING ₹7,646 each — ₹30,584 asked again for the same year. The pure half is
 * pinned in the first describe; the rest pins the fix.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renewalQuoteBlockedReason, nextTermRenewalDate, splitBilledRenewalStep } from "./split-billed-renewal";
import { plannedInstalments } from "@/lib/billing/instalments";
import { renewalTerm } from "./renewal-term";

const proofSub = {
  billing_cycle: "quarterly" as const,
  term_months: 12,
  start_date: "2025-11-01",
  renewal_date: "2026-11-01",
  mrr: 2160,
  renewal_quote_id: null as string | null,
};

describe("R-808 PROOF: a paid whole-year renewal quote leaves the instalments to bill the same year", () => {
  it("the renewal quote charges the whole year, and after it rolls the cron plans that same year again", () => {
    const quote = renewalTerm({ mrr: 2160, termMonths: 12, seats: 8, catalogPerSeatMonth: 270 });
    expect(quote.ok && quote.subtotal).toBe(25920);

    // record_payment's renewal branch: renewal_date + extension_months (12)
    const afterPaid = { ...proofSub, renewal_date: "2027-11-01" };
    const plan = plannedInstalments(afterPaid);
    expect(plan.map((p) => p.billOn)).toEqual(["2026-11-01", "2027-02-01", "2027-05-01", "2027-08-01"]);
    // …the same ₹25,920 ex-GST the paid renewal quote already invoiced.
    expect(plan.reduce((s, p) => s + p.taxableAmount, 0)).toBe(quote.ok ? quote.subtotal : -1);
  });
});

describe("renewalQuoteBlockedReason", () => {
  it.each([
    ["monthly", "monthly"], ["quarterly", "quarterly"], ["half_yearly", "half-yearly"],
  ] as const)("billed %s → refused, with the reason", (cycle, word) => {
    expect(renewalQuoteBlockedReason(cycle)).toBe(
      `This subscription is billed ${word}, so each part gets its own invoice on its date. A renewal quote would bill the next term twice. It renews on its own: the term rolls on and the next parts are invoiced on their dates.`,
    );
  });

  it.each(["yearly", null, undefined] as const)("billed %s → a renewal quote is allowed, as before", (cycle) => {
    expect(renewalQuoteBlockedReason(cycle)).toBeNull();
  });
});

describe("nextTermRenewalDate keeps the stored date shape", () => {
  it("anniversary row: one term on", () => {
    expect(nextTermRenewalDate(proofSub)).toBe("2027-11-01");
  });
  it("inclusive last day: one term on, still the last day", () => {
    expect(nextTermRenewalDate({ term_months: 12, start_date: "2025-10-20", renewal_date: "2026-10-19" })).toBe("2027-10-19");
  });
  it("anniversary on the 31st does not drift to the 28th", () => {
    // start 31 Jan, monthly: renewal 28 Feb is start + 1 month → next is 31 Mar, not 28 Mar
    expect(nextTermRenewalDate({ term_months: 1, start_date: "2026-01-31", renewal_date: "2026-02-28" })).toBe("2026-03-31");
  });
  it("inclusive month end: term 1–31 Jan → 1–28 Feb", () => {
    expect(nextTermRenewalDate({ term_months: 1, start_date: "2026-01-01", renewal_date: "2026-01-31" })).toBe("2026-02-28");
  });
  it("no renewal date → null", () => {
    expect(nextTermRenewalDate({ term_months: 12, start_date: "2026-01-01", renewal_date: null })).toBeNull();
  });
});

describe("splitBilledRenewalStep — what the renewals cron does", () => {
  it("yearly → not ours, the normal renewal quote path runs unchanged", () => {
    expect(splitBilledRenewalStep({ ...proofSub, billing_cycle: "yearly" }, "2026-11-01")).toEqual({ kind: "not_split_billed" });
  });

  it("before the new term → wait (no reminder, no quote)", () => {
    expect(splitBilledRenewalStep(proofSub, "2026-10-31")).toEqual({ kind: "wait", nextTermStart: "2026-11-01" });
    expect(splitBilledRenewalStep(proofSub, "2026-10-02")).toEqual({ kind: "wait", nextTermStart: "2026-11-01" });
  });

  it("on the new term's first day → roll one term", () => {
    expect(splitBilledRenewalStep(proofSub, "2026-11-01")).toEqual({
      kind: "roll", nextTermStart: "2026-11-01", newRenewalDate: "2027-11-01",
    });
  });

  it("inclusive row rolls the day after its last covered day", () => {
    const inc = { ...proofSub, start_date: "2025-10-20", renewal_date: "2026-10-19" };
    expect(splitBilledRenewalStep(inc, "2026-10-19").kind).toBe("wait");
    expect(splitBilledRenewalStep(inc, "2026-10-20")).toEqual({
      kind: "roll", nextTermStart: "2026-10-20", newRenewalDate: "2027-10-19",
    });
  });

  it("an open renewal quote is linked → held for a person, never rolled", () => {
    expect(splitBilledRenewalStep({ ...proofSub, renewal_quote_id: "Q-1" }, "2026-11-01")).toEqual({
      kind: "held_open_quote", nextTermStart: "2026-11-01", quoteId: "Q-1",
    });
  });

  it("FIX: after the roll the new year is billed ONCE — four quarters, the year's price, no renewal quote", () => {
    const step = splitBilledRenewalStep(proofSub, "2026-11-01");
    if (step.kind !== "roll") throw new Error("expected roll");
    const plan = plannedInstalments({ ...proofSub, renewal_date: step.newRenewalDate });
    expect(plan.map((p) => p.billOn)).toEqual(["2026-11-01", "2027-02-01", "2027-05-01", "2027-08-01"]);
    expect(plan.reduce((s, p) => s + p.taxableAmount, 0)).toBe(2160 * 12);
    // The year after rolls the same way, so instalments never stop.
    const next = splitBilledRenewalStep({ ...proofSub, renewal_date: step.newRenewalDate }, "2027-11-01");
    expect(next).toEqual({ kind: "roll", nextTermStart: "2027-11-01", newRenewalDate: "2028-11-01" });
  });
});

describe("wiring: every renewal-quote entry point reads the split-billed rule", () => {
  const read = (...p: string[]) => readFileSync(join(process.cwd(), "src", "app", "api", ...p), "utf8");

  it("renewals cron handles split-billed subs BEFORE any renewal quote is made, and the dry run too", () => {
    const src = read("cron", "renewals", "route.ts");
    expect(src).toMatch(/billing_cycle, start_date/);
    const live = src.slice(src.indexOf("async function handle("), src.indexOf("async function planOnly("));
    const at = live.indexOf("splitBilledRenewalStep(");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(live.indexOf("createOrGetRenewalQuote({"));
    expect(at).toBeLessThan(live.indexOf("decideCadence({"));
    // the roll is guarded so two runs cannot roll twice
    expect(live).toContain('.eq("renewal_date", sub.renewal_date!)');
    const dry = src.slice(src.indexOf("async function planOnly("));
    expect(dry).toContain("splitBilledRenewalStep(");
  });

  it.each([
    [["subscriptions", "[id]", "generate-renewal-quote", "route.ts"]],
    [["renewals", "send-now", "route.ts"]],
  ])("%j refuses with code split_billed before creating a quote", (parts) => {
    const src = read(...parts);
    const at = src.indexOf("renewalQuoteBlockedReason(sub.billing_cycle)");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf("createOrGetRenewalQuote({"));
    expect(src).toContain('code: "split_billed"');
  });
});
