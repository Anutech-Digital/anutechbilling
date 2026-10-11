/**
 * Workflow tests — the six operational journeys, composed from the REAL modules.
 *
 * ─── WHY THESE ARE VITEST AND NOT SIX MORE PLAYWRIGHT SPECS ─────────────────
 * The Playwright suite exists and is well written, but 70 of its 78 auth-gated tests
 * `test.skip` because there is no `.env.test`, and lighting them up needs a
 * SUPABASE_SERVICE_ROLE_KEY plus seeded fixture tenants. Adding six more specs would
 * add six more tests that never run — coverage that looks like a safety net and
 * catches nothing. `e2e/README.md` documents exactly what is still missing.
 *
 * ─── WHAT THESE CATCH THAT UNIT TESTS DO NOT ────────────────────────────────
 * Every module here is already tested on its own. What no per-module test can see is
 * the SEAM: whether the number one module produces is the number the next one
 * expects. Those are the bugs that survive a green suite —
 *
 *   • a quote priced by volume band, then approved against a different total
 *   • a seat request previewed at one figure and charged at another
 *   • a co-termed add-on whose aligned date does not match the schedule built from it
 *   • dunning that fires on an invoice the payment path already settled
 *
 * Each test below walks one journey end to end through the same functions the
 * application calls, in the same order, and asserts the handoffs.
 */
import { describe, it, expect } from "vitest";

// Quote side
import { slabPricing, slabLineTotals, type SeatSlab } from "@/lib/quotes/volume-tiers";
import { lineEconomics } from "@/lib/quotes/approval-economics";
import { requiredApproval, canSend, canApprove, type ApprovalRecord } from "@/lib/quotes/approval";
import { configureQuote } from "@/lib/quotes/configure";
import { quoteLifecycle } from "@/lib/quotes/lifecycle";
import { grossAmount } from "@/lib/quotes/amounts";
import { planProvisioning, overallProvisionStatus } from "@/lib/provisioning/plan";

// Subscription side
import { previewCharge, assessRequest } from "@/lib/subscriptions/seat-request";
import { prorate, rupeesToPaise, paiseToRupees } from "@/lib/subscriptions/proration";
import { coTerm } from "@/lib/billing/co-term";
import { buildBillingSchedule, scheduleTotal, addMonthsClamped } from "@/lib/billing/schedule";
import { subscriptionCogs } from "@/lib/vendor/cogs";
import { assessLeakage } from "@/lib/vendor/leakage";
import { decideDunning } from "@/lib/invoices/dunning";
import { describeAmendment, seatHistory, seatHistoryReconciles } from "@/lib/subscriptions/amendments";

import type { Item, QuoteLineItem, ContractAmendment } from "@/lib/supabase/database.types";

// ────────────────────────────────────────────────────────────────────────────
// Shared fixtures — one catalogue, used by every workflow, so a change to the
// price list shows up in all six rather than in whichever copy was remembered.
// ────────────────────────────────────────────────────────────────────────────
const SLABS: SeatSlab[] = [
  { minSeats: 1,  maxSeats: 10,   msrp: 270, wholesale: 110 },
  { minSeats: 11, maxSeats: 50,   msrp: 250, wholesale: 105 },
  { minSeats: 51, maxSeats: null, msrp: 230, wholesale: 100 },
];

const GWS: Item = {
  id: "item-gws", tenant_id: "t1", name: "Google Workspace Business Starter", vendor: "google",
  kind: "main", item_type: "subscription", covered_product: null, hsn: "998313", msrp: 270, wholesale: 110,
  prices: { annual: { msrp: 270, wholesale: 110 }, slabs: SLABS },
  margin_pct: 0, is_active: true, is_partner_visible: false, partner_price: null,
  synced_from_partner_id: null, created_at: "2026-01-01T00:00:00Z",
};
const BACKUP: Item = { ...GWS, id: "item-backup", name: "Acronis Cyber Backup", vendor: "other", msrp: 150, wholesale: 90, prices: { annual: { msrp: 150, wholesale: 90 } } };
const CATALOG = [GWS, BACKUP];

const rec = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  status: "not_required", tier: null, requestedBy: null, approvedBy: null,
  approvedDiscountBps: null, approvedMarginBps: null, rejectionReason: null,
  ...over,
});

// ════════════════════════════════════════════════════════════════════════════
describe("WORKFLOW 1 — Quote → sign → pay → subscription → GST invoice", () => {
  /* A 25-seat Workspace deal. Priced from the volume band, checked against the
     approval matrix, configured by the customer, then walked along the lifecycle. */
  const priced = slabPricing(GWS, 25);
  const totals = slabLineTotals(priced, 25);

  const line: QuoteLineItem = {
    id: "l1", item_id: GWS.id, name: GWS.name, qty: 25,
    rate: totals.ratePerSeatYear, list_rate: totals.ratePerSeatYear,
    cost: totals.costPerSeatYear, commitment: "annual_yearly",
  };

  it("prices from the 11–50 band, and the quote line carries that exact rate", () => {
    /* The seam: the builder computes a band rate, then writes it onto the line.
       If those two disagree the customer is quoted one number and billed another. */
    expect(priced.label).toBe("11–50 seats");
    expect(line.rate).toBe(3000);                 // ₹250 × 12
    expect(line.qty * line.rate).toBe(totals.lineRevenue);
  });

  it("the economics read back off the line match what priced it", () => {
    const e = lineEconomics([line]);
    expect(e.subtotal).toBe(75_000);
    expect(e.totalCost).toBe(31_500);             // ₹105 × 12 × 25
    expect(e.costUnknown).toBe(false);
    expect(e.subtotal - e.totalCost).toBe(totals.grossMargin);
  });

  it("goes out without approval — full price, healthy margin", () => {
    const need = requiredApproval(lineEconomics([line]));
    expect(need.tier).toBe("none");
    expect(canSend(rec(), need)).toEqual({ allowed: true });
  });

  it("the customer leaving it unchanged can self-accept", () => {
    const c = configureQuote([line], [], CATALOG);
    expect(c.changed).toBe(false);
    expect(c.selfAcceptable).toBe(true);
    expect(grossAmount(c.subtotal, 18)).toBe(88_500);   // 75,000 + 13,500 GST
  });

  it("signing then paying moves the lifecycle without skipping a step", () => {
    const signed = quoteLifecycle({
      status: "accepted", paymentStatus: "none", invoiceId: null,
      hasSignature: true, provisionStatus: "not_required",
    });
    expect(signed.steps.find((s) => s.stage === "signed")!.state).toBe("done");
    expect(signed.steps.find((s) => s.stage === "paid")!.state).toBe("current");

    const paid = quoteLifecycle({
      status: "accepted", paymentStatus: "received", invoiceId: "INV-ADPL-2026-27-0001",
      hasSignature: true, provisionStatus: "pending",
    });
    expect(paid.steps.find((s) => s.stage === "paid")!.state).toBe("done");
    expect(paid.steps.find((s) => s.stage === "invoiced")!.state).toBe("done");
    /* Provisioning is still outstanding and does NOT block the invoice — under
       CGST §31 the invoice is issued on supply. */
    expect(paid.steps.find((s) => s.stage === "provisioned")!.state).toBe("current");
  });

  it("payment raises provisioning work that names the real product and seat count", () => {
    const plan = planProvisioning({ lines: [line], fallbackDomain: "acme.in" });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ vendor: "google", seats: 25, domain: "acme.in", mode: "manual" });
    expect(overallProvisionStatus(["pending"])).toBe("pending");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("WORKFLOW 2 — Mid-cycle seat addition", () => {
  /* 10 seats at ₹2,700/mo, 228 days left of a 365-day term, customer wants 20 more. */
  const currentSeats = 10, currentMrr = 2_700, seatsToAdd = 20;
  const remainingDays = 228, termDays = 365;

  it("the request is approvable and reports the delta the charge is based on", () => {
    const v = assessRequest({
      status: "pending", currentSeats, requestedSeats: 30, liveSeats: 10,
      subscriptionStatus: "active", renewalDate: "2027-04-01", today: "2026-08-16",
    });
    expect(v).toEqual({ canApprove: true, seatsToAdd: 20, newTotal: 30 });
  });

  it("the PREVIEW is the quote line: whole-rupee rate per seat × seats (R-837)", () => {
    /* The seam that matters most here: the queue shows a figure and the approval
       charges one. Different code paths, and they must not diverge. */
    const preview = previewCharge({ currentSeats, currentMrr, seatsToAdd, remainingDays, termDays, taxRatePct: 18 })!;
    const raw = prorate({
      annualPerSeatPaise: Math.round(rupeesToPaise(currentMrr / currentSeats) * 12),
      seats: seatsToAdd, remainingDays, termDays, taxRatePct: 18,
    });
    /* R-837 (R-834 rule): per seat = the one-seat pro-rata in whole rupees; subtotal = that × seats. */
    const onePaise = prorate({ annualPerSeatPaise: Math.round(rupeesToPaise(currentMrr / currentSeats) * 12), seats: 1, remainingDays, termDays, taxRatePct: 18 }).subtotalPaise;
    expect(preview.perSeat).toBe(paiseToRupees(onePaise));
    expect(preview.exGst).toBe(preview.perSeat * seatsToAdd);
    expect(Math.abs(preview.exGst - paiseToRupees(raw.subtotalPaise))).toBeLessThanOrEqual(seatsToAdd);
    expect(preview.total).toBe(grossAmount(preview.exGst, 18));
    expect(preview.total).toBe(preview.exGst + preview.tax);
  });

  it("the arithmetic is the documented one: per seat rounded once, × seats (R-837)", () => {
    const p = previewCharge({ currentSeats, currentMrr, seatsToAdd, remainingDays, termDays, taxRatePct: 18 })!;
    // ₹270/seat/mo → ₹3,240/seat/yr × 228/365 = ₹2,023.89 → ₹2,024 × 20 = ₹40,480 (R-837)
    expect(p.exGst).toBe(40_480);
    expect(p.newMrr).toBe(8_100);
  });

  it("a TWO-YEAR term is not billed as an annual one", () => {
    /* The bug add-seats.ts records: termDays hardcoded to 365 made a 730-day term
       with 400 days left bill as a full year. */
    const annual  = previewCharge({ currentSeats, currentMrr, seatsToAdd, remainingDays: 400, termDays: 365, taxRatePct: 18 })!;
    const twoYear = previewCharge({ currentSeats, currentMrr, seatsToAdd, remainingDays: 400, termDays: 730, taxRatePct: 18 })!;
    // 400 days is clamped to the 365-day term, so an annual deal bills the full year.
    expect(annual.exGst).toBe(64_800);            // ₹3,240 × 20
    // On a 730-day term the same 400 days is 400/730 of it.
    expect(twoYear.exGst).toBe(35_500);           // round(₹3,240 × 400/730) = ₹1,775 × 20 (R-837)
    expect(twoYear.exGst).toBeLessThan(annual.exGst);
  });

  it("an export customer is charged NO GST on the same expansion", () => {
    const domestic = previewCharge({ currentSeats, currentMrr, seatsToAdd, remainingDays, termDays, taxRatePct: 18 })!;
    const exported = previewCharge({ currentSeats, currentMrr, seatsToAdd, remainingDays, termDays, taxRatePct: 0 })!;
    expect(exported.tax).toBe(0);
    expect(exported.total).toBe(domestic.exGst);
  });

  it("the seats land in the amendment ledger and reconcile with the subscription", () => {
    const amendments: ContractAmendment[] = [{
      id: "a1", tenant_id: "t1", subscription_id: "s1", customer_name: "Acme",
      kind: "seats_added+price_changed",
      changes: { seats: { from: 10, to: 30 }, mrr: { from: 2700, to: 8100 } },
      seats_from: 10, seats_to: 30, mrr_from: 2700, mrr_to: 8100,
      changed_by: null, source: "system", note: null, created_at: "2026-08-16T10:00:00Z",
    }];
    expect(seatHistory(amendments)).toEqual([
      { at: "2026-08-16T10:00:00Z", from: 10, to: 30, delta: 20, source: "system" },
    ]);
    expect(seatHistoryReconciles(amendments, 30)).toBe(true);
    expect(describeAmendment(amendments[0]).map((l) => l.text)).toEqual([
      "Seats: 10 → 30 (+20)",
      "Monthly price: ₹2,700 → ₹8,100",
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("WORKFLOW 3 — Co-terming an add-on to the main anniversary", () => {
  const anniversary = "2027-04-01";
  const result = coTerm({ anniversary, addOnStart: "2026-09-20", annualPerSeat: 1_800, seats: 10, taxRatePct: 18 });

  it("aligns the add-on to the main plan's date and charges only the stub", () => {
    expect(result.alignedTo).toBe(anniversary);
    expect(result.chargedDays).toBe(193);
    expect(result.firstChargeExGst).toBeLessThan(1_800 * 10);
  });

  it("the schedule built from the aligned date starts where co-terming said it would", () => {
    /* The seam: coTerm decides an alignment date, buildBillingSchedule lays the term
       out from it. If they disagree, the add-on renews on a different day from the
       plan it was co-termed to — the exact problem co-terming exists to remove. */
    const schedule = buildBillingSchedule({
      startDate: result.alignedTo, termMonths: 12, cycle: "yearly", termAmount: 18_000,
    });
    expect(schedule[0].periodStart).toBe(anniversary);
    expect(schedule[0].periodEnd).toBe(addMonthsClamped(anniversary, 12));
    expect(scheduleTotal(schedule)).toBe(18_000);
  });

  it("the main plan and the co-termed add-on renew on the SAME day", () => {
    const main = buildBillingSchedule({ startDate: "2026-04-01", termMonths: 12, cycle: "yearly", termAmount: 32_400 });
    expect(main[0].periodEnd).toBe(result.alignedTo);
  });

  it("a stub too short to invoice is given away, and the first term is a full year", () => {
    const late = coTerm({ anniversary, addOnStart: "2027-03-28", annualPerSeat: 1_800, seats: 10, taxRatePct: 18 });
    expect(late.stubAbsorbed).toBe(true);
    expect(late.firstChargeExGst).toBe(18_000);
    expect(late.alignedTo).toBe("2028-04-01");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("WORKFLOW 4 — Vendor reconciliation and the leakage it reveals", () => {
  const sub = {
    seats: 10, mrr: 2_700, item_id: GWS.id,
    vendor_cost_per_seat_month: null, vendor_synced_at: null,
  };

  it("before a sync, cost comes from the catalogue and leakage is UNKNOWN", () => {
    const cogs = subscriptionCogs(sub as never, CATALOG);
    expect(cogs.source).toBe("catalog");
    expect(cogs.perSeatMonth).toBe(110);

    const leak = assessLeakage({
      vendorSeats: null, billedSeats: 10, assignedSeats: null,
      costPerSeatMonth: cogs.perSeatMonth, pricePerSeatMonth: 270,
    });
    expect(leak.kind).toBe("unknown");
    expect(leak.monthlyImpact).toBeNull();
  });

  it("after a sync showing 14 provisioned seats, the gap is priced at what we PAY", () => {
    /* The seam: the reconcile dialog writes vendor_seats, cogs supplies the rate,
       leakage multiplies them. Using the customer's rate here would overstate the
       loss by the whole margin. */
    const cogs = subscriptionCogs(sub as never, CATALOG);
    const leak = assessLeakage({
      vendorSeats: 14, billedSeats: 10, assignedSeats: 8,
      costPerSeatMonth: cogs.perSeatMonth, pricePerSeatMonth: 270,
    });
    expect(leak.kind).toBe("under_billed");
    expect(leak.seatGap).toBe(4);
    expect(leak.monthlyImpact).toBe(440);        // 4 × ₹110, not 4 × ₹270
    expect(leak.annualImpact).toBe(5_280);
  });

  it("a vendor BILL overrides the catalogue, and the leakage figure follows it", () => {
    const withBill = { ...sub, vendor_cost_per_seat_month: 135, vendor_synced_at: "2026-08-16T00:00:00Z" };
    const cogs = subscriptionCogs(withBill as never, CATALOG);
    expect(cogs.source).toBe("vendor");
    const leak = assessLeakage({
      vendorSeats: 14, billedSeats: 10, assignedSeats: 8,
      costPerSeatMonth: cogs.perSeatMonth, pricePerSeatMonth: 270,
    });
    expect(leak.monthlyImpact).toBe(540);        // 4 × ₹135
  });

  it("over-billing is priced at the CUSTOMER's rate — it is a refund, not a gain", () => {
    const cogs = subscriptionCogs(sub as never, CATALOG);
    const leak = assessLeakage({
      vendorSeats: 6, billedSeats: 10, assignedSeats: 6,
      costPerSeatMonth: cogs.perSeatMonth, pricePerSeatMonth: 270,
    });
    expect(leak.kind).toBe("over_billed");
    expect(leak.monthlyImpact).toBe(1_080);      // 4 × ₹270
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("WORKFLOW 5 — Seat reduction and the credit note it needs", () => {
  it("a reduction is REFUSED by the seat-request path, with the reason", () => {
    /* addSeats() only adds. Approving a reduction into that path would report
       success and change nothing, which is worse than refusing. */
    const v = assessRequest({
      status: "pending", currentSeats: 30, requestedSeats: 10, liveSeats: 30,
      subscriptionStatus: "active", renewalDate: "2027-04-01", today: "2026-08-16",
    });
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) {
      expect(v.reason).toMatch(/reduction — 30 seats down to 10/);
      expect(v.nextStep).toMatch(/credit note/);
      expect(v.nextStep).toMatch(/NCE/);
    }
  });

  it("the credit for the removed seats is the same proration, with negative seats", () => {
    /* prorate() is symmetric by design, so a giveback is priced by the identical
       expression rather than by a second, subtly different one. */
    const charge = prorate({ annualPerSeatPaise: rupeesToPaise(3_240), seats: 20, remainingDays: 228, termDays: 365, taxRatePct: 18 });
    const credit = prorate({ annualPerSeatPaise: rupeesToPaise(3_240), seats: -20, remainingDays: 228, termDays: 365, taxRatePct: 18 });
    expect(credit.subtotalPaise).toBe(-charge.subtotalPaise);
    expect(credit.totalPaise).toBe(-charge.totalPaise);
  });

  it("the reduction shows in the ledger as a decrease, not as an addition", () => {
    const a: ContractAmendment = {
      id: "a2", tenant_id: "t1", subscription_id: "s1", customer_name: "Acme",
      kind: "seats_reduced", changes: { seats: { from: 30, to: 10 } },
      seats_from: 30, seats_to: 10, mrr_from: null, mrr_to: null,
      changed_by: "u1", source: "user", note: null, created_at: "2026-09-01T10:00:00Z",
    };
    const lines = describeAmendment(a);
    expect(lines[0]).toEqual({ text: "Seats: 30 → 10 (−20)", tone: "decrease" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("WORKFLOW 6 — Renewal due, invoice unpaid, dunning escalates", () => {
  const NOW = new Date("2026-08-16T12:00:00+05:30");
  const dueDaysAgo = (n: number) => {
    const d = new Date(NOW.getTime() - n * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const inv = (days: number, lastStep: "none" | "reminder" | "retry" | "grace_warning" | "final" = "none") =>
    decideDunning({ dueDate: dueDaysAgo(days), status: "pending", amountDue: 24_000, lastStepSent: lastStep }, NOW);

  it("walks day 1 → 3 → 7 → 14 in order, one step at a time", () => {
    expect(inv(1).step).toBe("reminder");
    expect(inv(3, "reminder").step).toBe("retry");
    expect(inv(7, "retry").step).toBe("grace_warning");
    expect(inv(14, "grace_warning").step).toBe("final");
  });

  it("does not re-send a step already sent", () => {
    expect(inv(4, "retry").shouldSend).toBe(false);
    expect(inv(8, "grace_warning").shouldSend).toBe(false);
  });

  it("catches up rather than skipping when the cron missed a day", () => {
    const d = inv(5, "reminder");
    expect(d.step).toBe("retry");
    expect(d.shouldSend).toBe(true);
  });

  it("day 14 ESCALATES rather than suspending, by default", () => {
    /* Suspension means a customer's staff cannot read email, and driving it from an
       invoice clock can cut off a subscription over an unrelated bill. */
    const d = decideDunning({
      dueDate: dueDaysAgo(14), status: "pending", amountDue: 24_000,
      subscriptionId: "sub-1", lastStepSent: "grace_warning",
    }, NOW);
    expect(d.action).toBe("escalate");
  });

  it("STOPS the moment the invoice is settled — mid-sequence", () => {
    /* The seam with the payment path: a customer chased for an invoice they already
       paid stops reading these emails entirely. */
    for (const status of ["paid", "void"] as const) {
      expect(decideDunning({ dueDate: dueDaysAgo(10), status, amountDue: 0, lastStepSent: "retry" }, NOW).step).toBe("none");
    }
    expect(decideDunning({ dueDate: dueDaysAgo(10), status: "pending", amountDue: 0, lastStepSent: "retry" }, NOW).step).toBe("none");
  });

  it("never chases an invoice with no due date", () => {
    expect(decideDunning({ dueDate: null, status: "pending", amountDue: 24_000 }, NOW).step).toBe("none");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("CROSS-CUTTING — a customer's change cannot bypass the approval matrix", () => {
  /* Not one of the six, but the seam that ties workflows 1 and 2 together and is the
     easiest place for a money bug to hide: the public quote page recomputes a price,
     and that recomputation must face the same rules an internal quote does. */
  const negotiated: QuoteLineItem = {
    id: "l1", item_id: GWS.id, name: GWS.name, qty: 10,
    rate: 1_300, list_rate: 3_240, cost: 1_320,
    seats_adjustable: true, commitment: "annual_yearly",
  };

  it("a seat increase that drops margin under the floor becomes a CHANGE REQUEST", () => {
    const c = configureQuote([negotiated], [{ lineId: "l1", seats: 60 }], CATALOG);
    expect(c.changed).toBe(true);
    expect(c.approval.tier).toBe("owner");
    expect(c.selfAcceptable).toBe(false);
  });

  it("an unchanged quote stays self-acceptable whatever its margin", () => {
    const c = configureQuote([{ ...negotiated, seats_adjustable: false }], [], CATALOG);
    expect(c.selfAcceptable).toBe(true);
  });

  it("a healthy change goes straight through", () => {
    const catalogueRate: QuoteLineItem = { ...negotiated, rate: 3_240 };
    const c = configureQuote([catalogueRate], [{ lineId: "l1", seats: 20 }], CATALOG);
    expect(c.approval.tier).toBe("none");
    expect(c.selfAcceptable).toBe(true);
  });

  it("nobody approves their own quote, at any tier", () => {
    const need = requiredApproval(lineEconomics([negotiated]));
    const r = canApprove({ id: "u1", role: "owner" }, rec({ requestedBy: "u1", status: "pending" }), need);
    expect(r.allowed).toBe(false);
  });
});
