/**
 * R-2227 — mid-term plan change (Starter → Standard): one calculation for preview and quote.
 */
import { describe, expect, it } from "vitest";
import { buildPlanChange, isPlanChangeQuote, planChangeLaterPartBlock, planChangeSeatCutBlock, planChangeTargets, type ChangePlanMoney, type ChangePlanSub } from "./change-plan";
import type { CatalogProduct } from "./catalog-options";

const starter: CatalogProduct = {
  id: "GW-STR", name: "Google Workspace Business Starter", vendor: "google_workspace" as CatalogProduct["vendor"],
  annualSellPerSeat: 3240, annualCostPerSeat: 2640, annualMonthlySellPerSeat: 270, annualMonthlyCostPerSeat: 220,
  flexMonthlySellPerSeat: 324, flexMonthlyCostPerSeat: 264,
};
const standard: CatalogProduct = {
  id: "GW-STD", name: "Google Workspace Business Standard", vendor: "google_workspace" as CatalogProduct["vendor"],
  annualSellPerSeat: 10368, annualCostPerSeat: 8640, annualMonthlySellPerSeat: 864, annualMonthlyCostPerSeat: 720,
  flexMonthlySellPerSeat: 1037, flexMonthlyCostPerSeat: 864,
};

const yearly: ChangePlanSub = {
  id: "sub-1", item_id: "GW-STR", plan: "Google Workspace Business Starter", vendor: "google_workspace",
  status: "active", seats: 10, mrr: 2700, billing_cycle: "yearly", term_months: 12,
  start_date: "2026-04-01", renewal_date: "2027-04-01", renewal_quote_id: null,
};
/* Paid in full: 10 × ₹3,240 = ₹32,400 + 18% = ₹38,232. */
const paid: ChangePlanMoney = { billed: true, openDuePaise: 0, receivedPaise: 3_823_200, alreadyCreditedPaise: 0, invoiced: true };
const today = "2026-10-01"; // 182 of 365 days left

describe("R-2227 buildPlanChange — yearly-paid", () => {
  it("charges the new plan for the days left less the unused old plan (paid in full)", () => {
    const r = buildPlanChange({ sub: yearly, target: standard, newSeats: 10, today, taxRatePct: 18, seatCuts: [], laterParts: [], money: paid });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.plan.calc;
    expect(c.chargedDays).toBe(182);
    expect(c.termDays).toBe(365);
    expect(c.oldPerSeat).toBe(1616);   // 3240 × 182 ÷ 365 = 1615.56
    expect(c.newPerSeat).toBe(5170);   // 10368 × 182 ÷ 365 = 5169.80
    expect(c.newCharge).toBe(51700);
    expect(c.unused).toBe(16160);
    expect(c.credit).toBe(16160);
    expect(c.net).toBe(35540);
    expect(c.total).toBe(35540 + 6397);
    expect(c.newMrr).toBe(8640);       // 10 × 10368 ÷ 12
    expect(r.plan.line.qty).toBe(1);
    expect(r.plan.line.rate).toBe(35540);
    expect(r.plan.line.item_id).toBe("GW-STD");
    expect(r.plan.line.plan_change).toMatchObject({
      subscription_id: "sub-1", to_item_id: "GW-STD", seats: 10, new_mrr: 8640, cost_per_seat_month: 720,
      credit: 16160, not_given_paise: 0,
      // R-2589: what it was priced on — record_payment refuses it once the subscription differs
      from_seats: 10, from_mrr: 2700, from_plan: "Google Workspace Business Starter",
    });
    expect(r.plan.line.name).toMatch(/pro-rata from 2026-10-01 to /);
    expect(isPlanChangeQuote({ extension_months: 0, line_items: [r.plan.line] })).toBe(true);
  });

  it("an unpaid invoice: refused — that share needs a credit note on the old invoice, not a line here", () => {
    const r = buildPlanChange({ sub: yearly, target: standard, newSeats: 10, today, taxRatePct: 18, seatCuts: [], laterParts: [],
      money: { billed: true, openDuePaise: 3_823_200, receivedPaise: 0, alreadyCreditedPaise: 0, invoiced: true } });
    expect(!r.ok && r.reason).toMatch(/still has ₹38,232.00 unpaid\. Record that payment first/);
  });

  it("refuses a support plan as the target (server side, not only the dialog list)", () => {
    const r = buildPlanChange({ sub: { ...yearly, vendor: null }, target: { ...standard, id: "SUP-PRO-Y" }, newSeats: 10, today, taxRatePct: 18, seatCuts: [], laterParts: [], money: paid });
    expect(!r.ok && r.reason).toMatch(/support plan/);
  });

  it("R-2255: nothing open and nothing received → no credit (Zoho credited money never received)", () => {
    const r = buildPlanChange({ sub: yearly, target: standard, newSeats: 10, today, taxRatePct: 18, seatCuts: [], laterParts: [],
      money: { billed: true, openDuePaise: 0, receivedPaise: 0, alreadyCreditedPaise: 0, invoiced: true } });
    expect(r.ok && r.plan.calc.credit).toBe(0);
    expect(r.ok && r.plan.calc.net).toBe(51700);
    expect(r.ok && r.plan.line.plan_change.not_given_paise).toBeGreaterThan(0);
  });

  it("partly received: credit only up to it (rounded down, ex-GST)", () => {
    const r = buildPlanChange({ sub: yearly, target: standard, newSeats: 10, today, taxRatePct: 18, seatCuts: [], laterParts: [],
      money: { billed: true, openDuePaise: 0, receivedPaise: 1_180_000, alreadyCreditedPaise: 0, invoiced: true } });
    expect(r.ok && r.plan.calc.credit).toBe(10000); // ₹11,800 incl. GST = ₹10,000 ex-GST
  });

  it("billed outside this app (Zoho import / opening) counts as paid", () => {
    const r = buildPlanChange({ sub: yearly, target: standard, newSeats: 10, today, taxRatePct: 18, seatCuts: [], laterParts: [],
      money: { billed: true, openDuePaise: 0, receivedPaise: 0, alreadyCreditedPaise: 0, invoiced: false, external: true } });
    expect(r.ok && r.plan.calc.credit).toBe(16160);
  });

  it("more seats with the change are charged at the new plan", () => {
    const r = buildPlanChange({ sub: yearly, target: standard, newSeats: 12, today, taxRatePct: 18, seatCuts: [], laterParts: [], money: paid });
    expect(r.ok && r.plan.calc.newCharge).toBe(5170 * 12);
    expect(r.ok && r.plan.line.plan_change.seats).toBe(12);
    expect(r.ok && r.plan.calc.newMrr).toBe(10368);
  });

  it("export (0% GST)", () => {
    const r = buildPlanChange({ sub: yearly, target: standard, newSeats: 10, today, taxRatePct: 0, seatCuts: [], laterParts: [],
      money: { ...paid, receivedPaise: 3_240_000 } });
    expect(r.ok && r.plan.calc.total).toBe(35540);
  });

  it.each([
    ["cheaper plan (annual cannot be reduced mid-term)", { sub: { ...yearly, item_id: "GW-STD", mrr: 8640 }, target: starter, newSeats: 10 }, /takes effect at renewal/],
    ["fewer seats", { sub: yearly, target: standard, newSeats: 9 }, /Manage seats/],
    ["open quote linked", { sub: { ...yearly, renewal_quote_id: "Q-1" }, target: standard, newSeats: 10 }, /open quote \(Q-1\)/],
    ["support plan", { sub: { ...yearly, item_id: "SUP-STD-Y" }, target: standard, newSeats: 10 }, /Upgrade plan/],
    ["cancelled", { sub: { ...yearly, status: "cancelled" }, target: standard, newSeats: 10 }, /Only an active plan/],
    ["same plan", { sub: yearly, target: starter, newSeats: 10 }, /different plan/],
    ["no price", { sub: { ...yearly, mrr: 0 }, target: standard, newSeats: 10 }, /no price/],
  ])("refuses: %s", (_n, a, re) => {
    const r = buildPlanChange({ ...(a as { sub: ChangePlanSub; target: CatalogProduct; newSeats: number }), today, taxRatePct: 18, seatCuts: [], laterParts: [], money: paid });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(re);
  });

  it("refuses when the part has no bill yet (would double-bill with the billing run)", () => {
    const r = buildPlanChange({ sub: yearly, target: standard, newSeats: 10, today, taxRatePct: 18, seatCuts: [], laterParts: [], money: { ...paid, billed: false } });
    expect(!r.ok && r.reason).toMatch(/no bill yet/);
    const r2 = buildPlanChange({ sub: yearly, target: standard, newSeats: 10, today, taxRatePct: 18, seatCuts: [], laterParts: [], money: null });
    expect(r2.ok).toBe(false);
  });

  it("refuses after the term ended", () => {
    const r = buildPlanChange({ sub: yearly, target: standard, newSeats: 10, today: "2027-04-05", taxRatePct: 18, seatCuts: [], laterParts: [], money: paid });
    expect(!r.ok && r.reason).toMatch(/term has ended/);
  });
});

describe("R-2227 + R-2226 — billed in parts: the current part at the part's own rate", () => {
  const monthly: ChangePlanSub = { ...yearly, billing_cycle: "monthly" };
  it("16 days of a 31-day October part = part rate × 16 ÷ 31", () => {
    const r = buildPlanChange({ sub: monthly, target: standard, newSeats: 10, today: "2026-10-16", taxRatePct: 18, seatCuts: [], laterParts: [],
      money: { billed: true, openDuePaise: 0, receivedPaise: 318_600, alreadyCreditedPaise: 0, invoiced: true } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.calc.parts).not.toBeNull();
    expect(r.plan.calc.oldPerSeat).toBe(139); // 270 × 16 ÷ 31 = 139.35
    expect(r.plan.calc.newPerSeat).toBe(446); // 864 × 16 ÷ 31 = 445.94
    expect(r.plan.calc.to).toBe("2026-10-31");
    expect(r.plan.calc.newMrr).toBe(8640);
  });
});

describe("R-2227 — targets and quote shape", () => {
  it("same vendor, not itself, no support plans", () => {
    const sup = { ...standard, id: "SUP-STD-Y", name: "Support Standard" };
    const other = { ...standard, id: "M365-BB", vendor: "microsoft_365" as CatalogProduct["vendor"] };
    expect(planChangeTargets(yearly, [starter, standard, sup, other]).map((p) => p.id)).toEqual(["GW-STD"]);
  });
  it("isPlanChangeQuote needs extension_months 0 and a plan_change line", () => {
    expect(isPlanChangeQuote({ extension_months: 12, line_items: [{ plan_change: {} }] })).toBe(false);
    expect(isPlanChangeQuote({ extension_months: 0, line_items: [{ item_id: "SUP-X" }] })).toBe(false);
  });
});

describe("R-2227 — a plan change quote reads as an upgrade, never a renewal", () => {
  it("document kind + accept hint", async () => {
    const { quoteDocumentKind } = await import("@/lib/pdf/quote-document-kind");
    const { acceptHint } = await import("@/lib/quotes/quote-page-actions");
    const q = { is_renewal: true, is_extension: false, extension_months: 0, line_items: [{ item_id: "GW-STD", plan_change: { seats: 10 } }] };
    expect(quoteDocumentKind(q)).toBe("upgrade");
    expect(acceptHint({ ...q, customer_id: "C1", lead_id: null })).toMatch(/plan and seats change when the payment is recorded/);
    expect(quoteDocumentKind({ ...q, extension_months: 12 })).toBe("renewal");
  });
});

describe("R-2617 — a scheduled end-of-term seat cut refuses the plan change", () => {
  const cut = { id: "R1", timing: "end_of_term", status: "scheduled", seats_before: 10, seats_after: 8, effective_date: "2027-04-01" };
  const run = (seatCuts: Parameters<typeof buildPlanChange>[0]["seatCuts"]) =>
    buildPlanChange({ sub: yearly, target: standard, newSeats: 12, today, taxRatePct: 18, seatCuts, laterParts: [], money: paid });

  it("cut dated this renewal → refused, names the cut and the next step", () => {
    const r = run([cut]);
    expect(!r.ok && r.reason).toBe(
      "A seat cut 10 → 8 is scheduled for the end of this term (1 Apr 2027). " +
      "Remove the scheduled seat cut in Manage seats first, then change the plan.",
    );
  });

  it.each([
    ["seats no longer match", [{ ...cut, seats_before: 9, seats_after: 6 }]],
    ["two cuts for this renewal", [cut, { ...cut, id: "R2" }]],
  ])("a still-scheduled cut the renewal would not apply (%s) → refused too", (_n, rows) => {
    expect(run(rows).ok).toBe(false);
  });

  it.each([
    ["dated an earlier term (R-2584)", { ...cut, effective_date: "2026-04-01" }],
    ["cancelled", { ...cut, status: "cancelled" }],
    ["applied", { ...cut, status: "applied" }],
    ["a 'now' cut (done)", { ...cut, timing: "now", status: "done" }],
  ])("%s → does not block", (_n, row) => {
    expect(run([row]).ok).toBe(true);
    expect(planChangeSeatCutBlock([row], yearly)).toBeNull();
  });

  it("no renewal date → nothing to block", () => {
    expect(planChangeSeatCutBlock([cut], { renewal_date: null, seats: 10 })).toBeNull();
  });
});

describe("R-2626 — a LATER part already billed at the old rate refuses the plan change", () => {
  /* Quarterly from 1 Apr 2026: Q2 = 1 Jul – 30 Sep, Q3 = 1 Oct – 31 Dec, Q4 = 1 Jan – 31 Mar. */
  const quarterly: ChangePlanSub = { ...yearly, billing_cycle: "quarterly" };
  const q2Paid: ChangePlanMoney = { billed: true, openDuePaise: 0, receivedPaise: 955_800, alreadyCreditedPaise: 0, invoiced: true };
  const q3 = { periodIndex: 3, periodStart: "2026-10-01", periodEnd: "2027-01-01", invoiceId: null, requestId: null };
  const q4 = { periodIndex: 4, periodStart: "2027-01-01", periodEnd: "2027-04-01", invoiceId: null, requestId: null };
  const run = (laterParts: Parameters<typeof buildPlanChange>[0]["laterParts"], sub: ChangePlanSub = quarterly) =>
    buildPlanChange({ sub, target: standard, newSeats: 10, today: "2026-08-16", taxRatePct: 18, seatCuts: [], laterParts, money: q2Paid });

  it("Q3 invoiced ahead (paid proforma) → refused with the next step, same words as the SQL trigger", () => {
    const r = run([{ ...q3, invoiceId: "INV-ANUT-27-0042" }, q4]);
    expect(!r.ok && r.reason).toBe(
      "Q3 (1 Oct 2026 – 31 Dec 2026) is already invoiced (INV-ANUT-27-0042) at the current plan's rate. " +
      "Change the plan once that part starts, or on the renewal quote.",
    );
  });

  it("Q4 has an open proforma → refused, names the proforma and Cancel proforma", () => {
    const r = run([q3, { ...q4, requestId: "PI-ANUT-27-0007" }]);
    expect(!r.ok && r.reason).toBe(
      "Q4 (1 Jan 2027 – 31 Mar 2027) already has proforma PI-ANUT-27-0007 at the current plan's rate. " +
      "Cancel that proforma first (open it → Cancel proforma), then change the plan; the part is billed again at the new rate on its date.",
    );
  });

  it("the EARLIEST billed later part is named; invoice wins over a proforma on the same part", () => {
    const r = run([{ ...q4, invoiceId: "INV-4" }, { ...q3, invoiceId: "INV-3", requestId: "PI-3" }]);
    expect(!r.ok && r.reason).toMatch(/^Q3 .* already invoiced \(INV-3\)/);
  });

  it("later parts laid but not billed (or freed / cancelled — the reader returns them without ids) → goes on", () => {
    const r = run([q3, q4]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.calc.to).toBe("2026-09-30");
  });

  it("a billed part that is the CURRENT one or earlier never blocks (R-2255 handles the current part)", () => {
    expect(planChangeLaterPartBlock([{ ...q3, periodStart: "2026-07-01", invoiceId: "INV-2" }], "2026-09-30", "quarterly")).toBeNull();
    expect(planChangeLaterPartBlock([{ ...q3, periodStart: "2026-09-30", invoiceId: "INV-x" }], "2026-09-30", "quarterly")).toBeNull();
  });

  it("monthly / half-yearly name the part like the invoices list (Month N / HN)", () => {
    expect(planChangeLaterPartBlock([{ ...q3, invoiceId: "I" }], "2026-09-30", "monthly")).toMatch(/^Month 3 \(/);
    expect(planChangeLaterPartBlock([{ ...q3, requestId: "P" }], "2026-09-30", "half_yearly")).toMatch(/^H3 \(/);
  });

  it("yearly-paid: nothing after the renewal date → not affected", () => {
    expect(run([], yearly).ok).toBe(true);
  });
});
