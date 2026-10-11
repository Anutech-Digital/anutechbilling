import { describe, it, expect } from "vitest";
import { assessRequest, previewCharge, requestBadge, type SeatRequestFacts } from "./seat-request";

const facts = (over: Partial<SeatRequestFacts> = {}): SeatRequestFacts => ({
  status: "pending",
  currentSeats: 10,
  requestedSeats: 30,
  liveSeats: 10,
  subscriptionStatus: "active",
  renewalDate: "2027-04-01",
  today: "2026-08-16",
  ...over,
});

describe("the happy path", () => {
  it("approves an increase and reports the delta AND the new total", () => {
    /* Both numbers matter: addSeats() takes a delta, the customer asked for a total,
       and confusing them is how a subscription ends up at 50 instead of 30. */
    const v = assessRequest(facts());
    expect(v).toEqual({ canApprove: true, seatsToAdd: 20, newTotal: 30 });
  });
});

describe("the subscription moves underneath a pending request", () => {
  it("REFUSES when seats have changed since the request", () => {
    /* Asked for 30 when it had 10. A rep has since added 30 by hand. Approving would
       set the total from the old figure and silently remove seats people are using —
       from a button that says "approve". */
    const v = assessRequest(facts({ liveSeats: 40 }));
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) {
      expect(v.reason).toMatch(/It now has 40/);
      expect(v.nextStep).toMatch(/already there/);
    }
  });

  it("tells the rep exactly how many are still missing when it moved UP but not enough", () => {
    const v = assessRequest(facts({ liveSeats: 22 }));
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) expect(v.nextStep).toMatch(/Add 8 seats by hand/);
  });

  it("approves normally when nothing has moved", () => {
    expect(assessRequest(facts({ liveSeats: 10 })).canApprove).toBe(true);
  });
});

describe("reductions are not approvals", () => {
  it("refuses a decrease and says why, rather than doing nothing", () => {
    /* addSeats() only adds. Approving a reduction into that path would report
       success and change nothing. */
    const v = assessRequest(facts({ requestedSeats: 4 }));
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) {
      expect(v.reason).toMatch(/reduction — 10 seats down to 4/);
      expect(v.nextStep).toMatch(/credit note/);
      expect(v.nextStep).toMatch(/NCE/);
    }
  });

  it("refuses a no-op request", () => {
    const v = assessRequest(facts({ requestedSeats: 10 }));
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) expect(v.reason).toMatch(/already has/);
  });
});

describe("state and subscription guards", () => {
  it.each(["approved", "rejected", "withdrawn"] as const)("refuses an already-%s request", (status) => {
    const v = assessRequest(facts({ status }));
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) expect(v.reason).toContain(status);
  });

  it("refuses a paused subscription and names the unblock", () => {
    const v = assessRequest(facts({ subscriptionStatus: "paused" }));
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) expect(v.nextStep).toMatch(/Settle what is outstanding/);
  });

  it.each(["expired", "cancelled"] as const)("refuses a %s subscription", (subscriptionStatus) => {
    expect(assessRequest(facts({ subscriptionStatus })).canApprove).toBe(false);
  });

  it("refuses without a renewal date — there is no term to pro-rate across", () => {
    const v = assessRequest(facts({ renewalDate: null }));
    expect(v.canApprove).toBe(false);
    if (!v.canApprove) expect(v.nextStep).toMatch(/Set the renewal date/);
  });

  it("refuses when the term has already ended, including on the day itself", () => {
    expect(assessRequest(facts({ renewalDate: "2026-08-16" })).canApprove).toBe(false);
    expect(assessRequest(facts({ renewalDate: "2026-08-01" })).canApprove).toBe(false);
    expect(assessRequest(facts({ renewalDate: "2026-08-17" })).canApprove).toBe(true);
  });

  it("every refusal carries a reason AND a next step", () => {
    const refusals = [
      facts({ status: "approved" }),
      facts({ subscriptionStatus: "paused" }),
      facts({ requestedSeats: 4 }),
      facts({ liveSeats: 40 }),
      facts({ renewalDate: null }),
    ];
    for (const f of refusals) {
      const v = assessRequest(f);
      expect(v.canApprove).toBe(false);
      if (!v.canApprove) {
        expect(v.reason.length).toBeGreaterThan(15);
        expect(v.nextStep.length).toBeGreaterThan(15);
      }
    }
  });
});

describe("previewCharge", () => {
  const base = {
    currentSeats: 10, currentMrr: 2_700, seatsToAdd: 20,
    remainingDays: 228, termDays: 365, taxRatePct: 18,
  };

  it("prices the added seats at what THIS customer pays, not at list", () => {
    // ₹2,700/mo ÷ 10 = ₹270/seat/mo → ₹3,240/seat/yr. R-837: per seat round(3240 × 228/365)
    // = ₹2,024 × 20 = ₹40,480 (was the all-seats pro-rata ₹40,477.81 → ₹40,478)
    const p = previewCharge(base)!;
    expect(p.perSeat).toBe(2_024);
    expect(p.exGst).toBe(40_480);
    expect(p.tax).toBe(7_286);
    expect(p.total).toBe(47_766);
  });

  it("total is subtotal + tax with no third rounding", () => {
    const p = previewCharge(base)!;
    expect(p.total).toBe(p.exGst + p.tax);
  });

  it("reports the NEW mrr after the change", () => {
    expect(previewCharge(base)!.newMrr).toBe(8_100);   // 30 × ₹270
  });

  it("honours a zero-rated export", () => {
    const p = previewCharge({ ...base, taxRatePct: 0 })!;
    expect(p.tax).toBe(0);
    expect(p.total).toBe(p.exGst);
  });

  it("scales linearly with seats — no per-seat rounding drift", () => {
    const ten = previewCharge({ ...base, seatsToAdd: 10 })!.exGst;
    const twenty = previewCharge({ ...base, seatsToAdd: 20 })!.exGst;
    expect(twenty).toBe(ten * 2);
  });

  it("uses the REAL term length, so a two-year deal is not billed as annual", () => {
    /* The bug addSeats() documents: termDays hardcoded to 365 made a two-year term
       with 400 days left bill as a full year. */
    const annual  = previewCharge({ ...base, remainingDays: 400, termDays: 365 })!;
    const twoYear = previewCharge({ ...base, remainingDays: 400, termDays: 730 })!;
    expect(twoYear.exGst).toBeLessThan(annual.exGst);
  });

  it("returns null on inputs that cannot be priced", () => {
    expect(previewCharge({ ...base, seatsToAdd: 0 })).toBeNull();
    expect(previewCharge({ ...base, currentSeats: 0 })).toBeNull();
    expect(previewCharge({ ...base, termDays: 0 })).toBeNull();
  });

  it("returns whole rupees", () => {
    for (const seatsToAdd of [1, 7, 13]) {
      const p = previewCharge({ ...base, seatsToAdd })!;
      expect(Number.isInteger(p.exGst)).toBe(true);
      expect(Number.isInteger(p.total)).toBe(true);
    }
  });
});

describe("requestBadge", () => {
  it("tells the REP it is their move", () => {
    expect(requestBadge("pending")).toEqual({ label: "Waiting on you", kind: "warning" });
  });

  it("covers every status", () => {
    for (const s of ["pending", "approved", "rejected", "withdrawn"] as const) {
      expect(requestBadge(s).label.length).toBeGreaterThan(0);
    }
  });
});
