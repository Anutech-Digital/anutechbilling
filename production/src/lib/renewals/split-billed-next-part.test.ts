/* R-2095 (staging, 30 Oct): Renewals → Generate on a monthly-billed subscription whose month ended
   refused ("billed monthly…") with no part bill anywhere — month 2 could not be billed. */
import { describe, expect, it } from "vitest";
import { istToday } from "@/lib/dates/ist";
import { nextPartMessage, rolledRenewalDate, billDueTermsOldestFirst, partsDue, termsMessage, type TermBill } from "./split-billed-next-part";

const monthly = { billing_cycle: "monthly" as const, term_months: 1, start_date: "2026-09-01", renewal_date: "2026-09-30", renewal_quote_id: null };

describe("R-2095 Generate on a subscription billed in parts → the next part", () => {
  it("a monthly term that ended 30 Sep rolls to October on 29 Oct", () => {
    expect(rolledRenewalDate(monthly, "2026-10-29")).toEqual({ renewalDate: "2026-10-31", rolls: 1, heldBy: null });
  });
  it("two months behind → rolls twice", () => {
    expect(rolledRenewalDate(monthly, "2026-11-05").rolls).toBe(2);
  });
  it("a term still running is not rolled", () => {
    expect(rolledRenewalDate(monthly, "2026-09-20")).toEqual({ renewalDate: "2026-09-30", rolls: 0, heldBy: null });
  });
  it("an open renewal quote holds it (paying it would bill twice)", () => {
    expect(rolledRenewalDate({ ...monthly, renewal_quote_id: "Q-1" }, "2026-10-29").heldBy).toBe("Q-1");
  });
  it("says what was made and links to it", () => {
    expect(nextPartMessage("Greentin", { raised: [], requests: [{ period_index: 1, quote_id: "Q-9" }], requestsOpen: [] }, null))
      .toEqual({ ok: true, text: expect.stringMatching(/Payment request Q-9/), href: "/quotes/Q-9" });
    expect(nextPartMessage("Greentin", { raised: [{ period_index: 1, invoice_id: "INV-7" }], requests: [], requestsOpen: [] }, null).href).toBe("/invoices/INV-7");
    expect(nextPartMessage("Greentin", { raised: [], requests: [], requestsOpen: [] }, null).ok).toBe(false);
  });
});

/* R-2095 (staging, 30 Oct, P0 money): Greentin, monthly, renewal_date 11 Sep. Generate rolled the
   term TWICE (11 Sep → 11 Nov) and billed only 11 Oct–10 Nov (Q-A378-27-0122): 11 Sep–10 Oct was
   never billed. Rule: the oldest unbilled period first, renewal_date one period per bill. */

describe("R-2095 Generate on a monthly sub months behind bills every month, oldest first", () => {
  const greentin = { billing_cycle: "monthly" as const, term_months: 1, start_date: "2026-08-11", renewal_date: "2026-09-11", renewal_quote_id: null };

  function harness(billFor: (renewalDate: string) => TermBill) {
    let renewal = greentin.renewal_date;
    const rolls: [string, string][] = [];
    const billedAt: string[] = [];
    return {
      rolls, billedAt, now: () => renewal,
      roll: async (from: string, to: string) => { expect(from).toBe(renewal); rolls.push([from, to]); renewal = to; },
      billCurrentTerm: async () => { billedAt.push(renewal); return billFor(renewal); },
    };
  }
  const req = (q: string): TermBill => ({ raised: [], requests: [{ period_index: 1, quote_id: q }], requestsOpen: [], skip: null });

  it("2 months behind on 30 Oct → 11 Sep–10 Oct billed first, then 11 Oct–10 Nov; renewal_date moves one month per bill", async () => {
    const h = harness((r) => req(r === "2026-10-11" ? "Q-SEP" : "Q-OCT"));
    const out = await billDueTermsOldestFirst({ sub: greentin, todayISO: "2026-10-30", roll: h.roll, billCurrentTerm: h.billCurrentTerm });
    expect(h.rolls).toEqual([["2026-09-11", "2026-10-11"], ["2026-10-11", "2026-11-11"]]);
    expect(h.billedAt).toEqual(["2026-10-11", "2026-11-11"]);
    expect(out.terms.map((t) => [t.periodStart, t.periodEnd, t.bill.requests[0]?.quote_id])).toEqual([
      ["2026-09-11", "2026-10-10", "Q-SEP"],
      ["2026-10-11", "2026-11-10", "Q-OCT"],
    ]);
    expect(out.error).toBeNull();
  });

  it("a month that cannot be billed is not skipped over: renewal_date goes back and nothing later is billed", async () => {
    const h = harness(() => ({ raised: [], requests: [], requestsOpen: [], skip: { code: "no_schedule", reason: "No MRR" } }));
    const out = await billDueTermsOldestFirst({ sub: greentin, todayISO: "2026-10-30", roll: h.roll, billCurrentTerm: h.billCurrentTerm });
    expect(h.now()).toBe("2026-09-11");
    expect(h.billedAt).toEqual(["2026-10-11"]);
    expect(out.terms).toHaveLength(0);
    expect(out.stoppedReason).toBe("No MRR");
  });

  it("a failing bill stops the run with the month billed so far kept", async () => {
    const h = harness((r) => { if (r === "2026-11-11") throw new Error("customer has no state"); return req("Q-SEP"); });
    const out = await billDueTermsOldestFirst({ sub: greentin, todayISO: "2026-10-30", roll: h.roll, billCurrentTerm: h.billCurrentTerm });
    expect(out.terms.map((t) => t.bill.requests[0]?.quote_id)).toEqual(["Q-SEP"]);
    expect(out.error).toMatch(/no state/);
    expect(h.now()).toBe("2026-10-11"); // rolled back to the failed month — never past it
  });

  it("a term still running bills its own due part, no roll (as before)", async () => {
    const h = harness(() => req("Q-NOW"));
    const out = await billDueTermsOldestFirst({ sub: greentin, todayISO: "2026-09-05", roll: h.roll, billCurrentTerm: h.billCurrentTerm });
    expect(h.rolls).toEqual([]);
    expect(out.terms.map((t) => t.bill.requests[0]?.quote_id)).toEqual(["Q-NOW"]);
  });

  it("the Renewals screen says '2 months due' for Greentin on 30 Oct", () => {
    expect(partsDue(greentin, "2026-10-30")).toEqual({ count: 2, from: "2026-09-11", text: "2 months due" });
    expect(partsDue(greentin, "2026-09-05")).toBeNull();
    expect(partsDue({ ...greentin, billing_cycle: "yearly" as const, term_months: 12 }, "2026-10-30")).toBeNull();
    expect(partsDue({ ...greentin, renewal_date: "2026-10-11" }, "2026-10-30")?.text).toBe("1 month due");
  });

  it("says every bill made, oldest first, and opens the oldest", () => {
    const m = termsMessage("Greentin", { heldBy: null, error: null, stoppedReason: null, terms: [
      { periodStart: "2026-09-11", periodEnd: "2026-10-10", bill: req("Q-SEP") },
      { periodStart: "2026-10-11", periodEnd: "2026-11-10", bill: req("Q-OCT") },
    ] });
    expect(m.ok).toBe(true);
    expect(m.href).toBe("/quotes/Q-SEP");
    expect(m.text).toMatch(/2 periods.*Q-SEP.*11 Sep.*Q-OCT/s);
  });
});

/* R-2398 (staging, 3 Nov ~02:xx UTC = 08:xx IST): Renewals → Generate on Abraf (monthly, 15th–14th)
   made Q-0905 for 15 Sep–14 Oct AND Q-0906 for 15 Oct–14 Nov; Farmagain (monthly, calendar month)
   made Q-0907 for Oct AND Q-0908 for Nov. Both second periods had STARTED by 3 Nov — the code bills
   only periods whose start ≤ today (IST), so this was correct catch-up, not a double period. Pinned
   here: one due month → one bill, two → two (oldest first), a month starting tomorrow → none. */
describe("R-2398 Generate bills only the periods whose start has come (IST today)", () => {
  const req = (q: string): TermBill => ({ raised: [], requests: [{ period_index: 1, quote_id: q }], requestsOpen: [], skip: null });
  function run(sub: { billing_cycle: "monthly"; term_months: number; start_date: string; renewal_date: string; renewal_quote_id: null }, todayISO: string) {
    let renewal = sub.renewal_date;
    let n = 0;
    return billDueTermsOldestFirst({
      sub, todayISO,
      roll: async (_from, to) => { renewal = to; },
      billCurrentTerm: async () => req(`Q-${++n}@${renewal}`),
    });
  }
  const abraf = { billing_cycle: "monthly" as const, term_months: 1, start_date: "2026-08-15", renewal_date: "2026-09-14", renewal_quote_id: null };
  const farmagain = { billing_cycle: "monthly" as const, term_months: 1, start_date: "2026-08-01", renewal_date: "2026-09-30", renewal_quote_id: null };
  const periods = (o: Awaited<ReturnType<typeof run>>) => o.terms.map((t) => [t.periodStart, t.periodEnd]);

  it("Abraf on 3 Nov: 15 Sep–14 Oct and 15 Oct–14 Nov have both started → two bills, oldest first", async () => {
    expect(periods(await run(abraf, "2026-11-03"))).toEqual([["2026-09-15", "2026-10-14"], ["2026-10-15", "2026-11-14"]]);
    expect(partsDue(abraf, "2026-11-03")?.text).toBe("2 months due");
  });
  it("Farmagain on 3 Nov: Oct and Nov have both started → two bills", async () => {
    expect(periods(await run(farmagain, "2026-11-03"))).toEqual([["2026-10-01", "2026-10-31"], ["2026-11-01", "2026-11-30"]]);
  });
  it("exactly one due month → exactly one bill", async () => {
    expect(periods(await run(farmagain, "2026-10-31"))).toEqual([["2026-10-01", "2026-10-31"]]);
    expect(periods(await run(abraf, "2026-10-14"))).toEqual([["2026-09-15", "2026-10-14"]]);
    expect(partsDue(farmagain, "2026-10-31")?.text).toBe("1 month due");
  });
  it("a month starting tomorrow is not billed (not yet due → no roll, no bill)", async () => {
    const out = await run({ ...farmagain, renewal_date: "2026-11-30" }, "2026-11-30");
    expect(out.terms.map((t) => t.periodStart)).toEqual(["2026-11-01"]); // the running month's own part only
    expect(partsDue({ ...farmagain, renewal_date: "2026-11-30" }, "2026-11-30")).toBeNull();
  });
  it("around IST midnight: 1 Nov starts at 18:30 UTC on 31 Oct, not before", async () => {
    expect(istToday(new Date("2026-10-31T18:29:59Z"))).toBe("2026-10-31");
    expect(istToday(new Date("2026-10-31T18:30:00Z"))).toBe("2026-11-01");
    expect(periods(await run(farmagain, istToday(new Date("2026-10-31T18:29:59Z"))))).toHaveLength(1);
    expect(periods(await run(farmagain, istToday(new Date("2026-10-31T18:30:00Z"))))).toHaveLength(2);
  });
  it("the result names every period made", () => {
    const m = termsMessage("Abraf", { heldBy: null, error: null, stoppedReason: null, terms: [
      { periodStart: "2026-09-15", periodEnd: "2026-10-14", bill: req("Q-0905") },
      { periodStart: "2026-10-15", periodEnd: "2026-11-14", bill: req("Q-0906") },
    ] });
    expect(m.text).toBe("2 periods billed for Abraf, oldest first: Q-0905 (15 Sep–14 Oct), Q-0906 (15 Oct–14 Nov).");
  });
});
