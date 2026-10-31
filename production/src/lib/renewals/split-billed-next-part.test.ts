/* R-2095 (staging, 30 Oct): Renewals → Generate on a monthly-billed subscription whose month ended
   refused ("billed monthly…") with no part bill anywhere — month 2 could not be billed. */
import { describe, expect, it } from "vitest";
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
