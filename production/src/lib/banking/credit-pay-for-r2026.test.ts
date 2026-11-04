/* R-2026 — Reconcile → "A new sale": Commitment first (Annual (1-yr) / Monthly flex / One-time),
   the price from the catalogue for that commitment, then Payment (Annual: yearly / half-yearly /
   quarterly / monthly; Monthly flex: monthly only). Due now = the first bill. Pardeep 27 Oct
   (staging: JAK GROUP, Business Starter 35 seats). */
import { describe, expect, it } from "vitest";
import {
  commitmentOptions, customerOptionLabel, customerOptions, laterBillsText, paymentChoice, rateFromShownPrice,
  repriceLine, resultLines, saleBillingCycle, saleLineFromItem, saleSchedule, shownPriceUnit, shownUnitPrice,
  type PayForResult,
} from "./credit-pay-for";
import { newSaleArgs, raiseFirstInstalment, relinkArgs } from "@/lib/queries/bank-credit-pay-for";
import { formatDate } from "@/lib/utils";

/* A per-seat Google Workspace row with its own annual and monthly-flex tiers (₹/seat/MONTH) at the
   list price (R-2050: a row below the R-205 floor is lifted to it — see credit-pay-for-r2050.test.ts). */
const STARTER = {
  id: "GW-ST", name: "Google Workspace Business Starter", vendor: "google", msrp: 270, wholesale: 110,
  item_type: "subscription", prices: { annual: { msrp: 270, wholesale: 110 }, monthly: { msrp: 325, wholesale: 132 } },
} as never;
const SETUP = { id: "MIG", name: "Email migration", vendor: null, msrp: 199, wholesale: 0, item_type: "one_time", billing_unit: "one_time", prices: {} } as never;

describe("R-2026 price by commitment (catalogue tier, editable; R-2050: Annual ₹/user/year)", () => {
  it("Annual commitment takes prices.annual, Monthly flex takes prices.monthly — cost from the same tier", () => {
    const annual = saleLineFromItem(STARTER, "annual_yearly", 35);
    expect(annual).toMatchObject({ rate: 270 * 12, cost: 110 * 12, qty: 35, monthPriced: true });
    expect(shownUnitPrice(annual)).toBe(3240);              // R-2050: Annual shows ₹/user/YEAR
    expect(shownPriceUnit(annual)).toBe("₹/user/year");
    const flex = repriceLine(annual, STARTER, "monthly");
    expect(flex).toMatchObject({ cycle: "monthly", rate: 325, cost: 132, qty: 35 });
    expect(shownUnitPrice(flex)).toBe(325);
    expect(shownPriceUnit(flex)).toBe("₹/user/month");
    expect(repriceLine(flex, STARTER, "annual_yearly")).toMatchObject({ rate: 3240, cost: 1320 });
  });
  it("R-2050: a typed price is stored as typed — ₹/seat/year (annual, no × 12) or ₹/seat/month (monthly)", () => {
    const annual = saleLineFromItem(STARTER, "annual_yearly", 35);
    expect(rateFromShownPrice(annual, 3360)).toBe(3360);
    expect(rateFromShownPrice({ cycle: "monthly", monthPriced: true }, 165)).toBe(165);
    expect(rateFromShownPrice({ cycle: "one_time", monthPriced: false }, 199)).toBe(199);
  });
  it("commitments: Annual first, then Monthly flex, then One-time (builder labels); a one-time row is One-time only", () => {
    expect(commitmentOptions(false).map((c) => [c.cycle, c.label])).toEqual([
      ["annual_yearly", "Annual commitment"], ["monthly", "Flexible (monthly)"], ["one_time", "One-time"],
    ]);
    expect(commitmentOptions(true).map((c) => c.cycle)).toEqual(["one_time"]);
    expect(shownPriceUnit(saleLineFromItem(SETUP))).toBe("₹ once");
  });
});

describe("R-2026 payment frequency follows the commitment", () => {
  it("Annual commitment offers Yearly / Half-yearly / Quarterly / Monthly", () => {
    const p = paymentChoice([saleLineFromItem(STARTER, "annual_yearly", 5)]);
    expect(p.options.map((o) => o.id)).toEqual(["yearly", "half_yearly", "quarterly", "monthly"]);
    expect(p.why).toBeNull();
  });
  it("Monthly flex → Monthly only, with a line saying why; the saved cycle is monthly whatever was picked", () => {
    const lines = [saleLineFromItem(STARTER, "monthly", 5)];
    const p = paymentChoice(lines);
    expect(p.options.map((o) => o.id)).toEqual(["monthly"]);
    expect(p.why).toMatch(/Flexible \(monthly\) has no commitment, so it is paid monthly only/);
    expect(saleBillingCycle(lines, "quarterly")).toBe("monthly");
  });
  it("one-time only → nothing to ask, saved yearly (not split)", () => {
    expect(paymentChoice([saleLineFromItem(SETUP)]).options).toEqual([]);
    expect(saleBillingCycle([saleLineFromItem(SETUP)], "quarterly")).toBe("yearly");
  });
});

describe("R-2026 amount due now = the first bill", () => {
  const lines = [{ ...saleLineFromItem(STARTER, "annual_yearly", 10), rate: 1632 }];   // ₹16,320 a year
  it("Annual + Quarterly: due now = one quarter + GST (₹4,080 + ₹734 = ₹4,814), three more bills", () => {
    const s = saleSchedule(lines, 18, "quarterly", "2026-10-21");
    expect(s).toMatchObject({ dueNow: 4814, dueTaxable: 4080, everyMonth: false });
    expect(s.later).toEqual([
      { billOn: "2027-01-21", gross: 4814 }, { billOn: "2027-04-21", gross: 4814 }, { billOn: "2027-07-21", gross: 4814 },
    ]);
    expect(laterBillsText(s, "quarterly")).toBe("Next 3 bills ₹4,814 each, on 21 Jan 2027, 21 Apr 2027 and 21 Jul 2027.");
  });
  it("Annual + Yearly: due now = the whole year + GST, no later bills", () => {
    const s = saleSchedule(lines, 18, "yearly", "2026-10-21");
    expect(s).toMatchObject({ dueNow: 19258, dueTaxable: 16320, later: [] });
    expect(laterBillsText(s, "yearly")).toBeNull();
  });
  it("Annual + Monthly: 1/12 now, 11 more summarised", () => {
    const s = saleSchedule(lines, 18, "monthly", "2026-10-21");
    expect(s.dueNow).toBe(1360 + 245);
    expect(s.later).toHaveLength(11);
    expect(laterBillsText(s, "monthly")).toBe(`Next 11 bills ₹1,605 each, monthly from ${formatDate("2026-11-21")} to ${formatDate("2027-09-21")}.`);
  });
  it("Monthly flex: the month's bill now, then the same every month", () => {
    const s = saleSchedule([saleLineFromItem(STARTER, "monthly", 10)], 18, "quarterly", "2026-10-21");
    expect(s).toMatchObject({ dueNow: 3835, dueTaxable: 3250, later: [], everyMonth: true });
    expect(laterBillsText(s, "monthly")).toBe("Then ₹3,835 every month while the Flexible (monthly) plan runs.");
  });
});

describe("R-2026 the subscription gets the commitment + cycle (server args)", () => {
  const base = {
    transactionId: "t", customerId: "c1", createSubscription: true, subStart: "2026-10-21", subRenewal: null, tdsAmount: 0, tdsRatePct: null,
    lines: [saleLineFromItem(STARTER, "annual_yearly", 10)],
  };
  it("new sale sends the line commitment and p_billing_cycle", () => {
    const a = newSaleArgs({ ...base, billingCycle: "quarterly" });
    expect(a.p_lines[0]).toMatchObject({ commitment: "annual_yearly", rate: 3240 });
    expect(a.p_billing_cycle).toBe("quarterly");
    expect(newSaleArgs(base).p_billing_cycle).toBeNull();
  });
  it("relink of an old one-off sale passes billing_cycle in its target", () => {
    expect(relinkArgs({ path: "new_sale", ...base, billingCycle: "half_yearly" }).p_target).toMatchObject({ billing_cycle: "half_yearly" });
  });
  it("split-billed: the first bill's invoice is raised (raise-instalments); yearly: no call", async () => {
    const r = { quote_id: "Q-9", invoice_issued: null, already_recorded: false, subscriptions: [] } as unknown as PayForResult;
    const calls: string[] = [];
    const post = (async (url: string) => { calls.push(url); return new Response(JSON.stringify({ raised: [{ invoice_id: "INV-77" }], errors: [] })); }) as unknown as typeof fetch;
    expect((await raiseFirstInstalment(r, "quarterly", post)).invoice_issued).toBe("INV-77");
    expect(calls).toEqual(["/api/quotes/Q-9/raise-instalments"]);
    expect(await raiseFirstInstalment(r, "yearly", post)).toBe(r);
    expect(calls).toHaveLength(1);
    const failing = (async () => new Response(JSON.stringify({ raised: [], errors: [{ message: "Customer has no state." }] }))) as unknown as typeof fetch;
    expect((await raiseFirstInstalment(r, "quarterly", failing)).instalment_error).toBe("Customer has no state.");
  });
  it("after save: the subscription says how it is billed; the rest of the year is not 'still due'", () => {
    const lines = resultLines({
      kind: "new", quote_id: "Q-9", invoice_id: null, invoice_issued: "INV-77", payment_id: "p", receipt_voucher_no: null,
      amount: 4814, tds_amount: 0, outstanding: 14444, is_fully_paid: false, overpaid_credit: 0, renewal_rolled_forward: false,
      subscription_skipped: false, already_recorded: false, new_quote: true,
      subscriptions: [{ id: "s", plan: "Google Workspace Business Starter", seats: 10, start_date: "2026-10-21", renewal_date: "2027-10-21", billing_cycle: "quarterly" }],
    }).map((l) => l.text);
    expect(lines).toContain("Subscription created: Google Workspace Business Starter × 10 · billed quarterly, renews 21 Oct 2027");
    expect(lines.some((t) => /still due/.test(t))).toBe(false);
    expect(lines).toContain("The rest of the year is billed quarterly — a payment request goes out on each date; its invoice is raised when it is paid.");
  });
});

describe("R-2026 (5) customer dropdown shows each name once", () => {
  it("a name stored twice over is shown once; normal names untouched", () => {
    expect(customerOptionLabel("JAK GROUP PRIVATE LIMITEDJAK GROUP PRIVATE LIMITED")).toBe("JAK GROUP PRIVATE LIMITED");
    expect(customerOptionLabel("JAK GROUP PRIVATE LIMITED JAK GROUP PRIVATE LIMITED")).toBe("JAK GROUP PRIVATE LIMITED");
    expect(customerOptionLabel("Acme Traders")).toBe("Acme Traders");
    expect(customerOptionLabel("Duran Duran")).toBe("Duran Duran");
    expect(customerOptionLabel("AA")).toBe("AA");
  });
  it("the same customer twice in the list is listed once", () => {
    expect(customerOptions([{ id: "1", name: "JAK" }, { id: "1", name: "JAK" }, { id: "2", name: "Acme" }])).toEqual([
      { id: "1", label: "JAK" }, { id: "2", label: "Acme" },
    ]);
  });
});
