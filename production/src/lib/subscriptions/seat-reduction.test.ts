/**
 * R-2252 (Zoho Billing audit A17): Reduce seats shows the credit before saving.
 * Owner's path: Manage seats → Reduce → 2 of 10 seats → "credit ₹x (+GST)" → Now.
 */
import { describe, it, expect } from "vitest";
import { seatReductionValue, seatReductionPreview, SEAT_CUT_END_OF_TERM_ENABLED, type SeatReductionSub, type SeatReductionValueOk } from "./seat-reduction";
import { seatIncreaseCharge } from "./seat-increase-charge";

/* 10 seats × ₹1,800/seat/year = mrr ₹1,500, yearly, term 1 Apr 2026 → renews 1 Apr 2027. */
const YEARLY: SeatReductionSub = {
  seats: 10, mrr: 1500, billing_cycle: "yearly", term_months: 12, start_date: "2026-04-01", renewal_date: "2027-04-01",
};
const TODAY = "2026-11-08";

function ok(v: ReturnType<typeof seatReductionValue>): SeatReductionValueOk {
  if (!v.ok) throw new Error(`expected ok, got ${v.code}: ${v.message}`);
  return v;
}

describe("seatReductionValue (R-2252)", () => {
  it("prices the removed seats' unused days exactly like Add seats (same window, same rate)", () => {
    const v = ok(seatReductionValue({ sub: YEARLY, seatsRemoved: 2, today: TODAY, taxRatePct: 18 }));
    const add = seatIncreaseCharge({ currentSeats: 10, currentMrr: 1500, additionalSeats: 2, remainingDays: v.days, termDays: 365, taxRatePct: 18 });
    expect(v.days).toBe(144);                 // 8 Nov 2026 → 1 Apr 2027
    expect(v.annualPerSeat).toBe(1800);
    expect(v.subtotal).toBe(1420);            // 2 × round(1,800 × 144 ÷ 365) = 2 × 710
    expect(v.subtotal).toBe(add.subtotal);
    expect(v.total).toBe(add.total);
    expect(v.tax).toBe(v.total - v.subtotal);
    expect(v.unusedPaise).toBe(v.total * 100);
    expect(v.seatsAfter).toBe(8);
    expect(v.newMrr).toBe(1200);              // 8 × 1,800 ÷ 12
  });

  it("export (0% GST): no tax on the credit", () => {
    const v = ok(seatReductionValue({ sub: YEARLY, seatsRemoved: 2, today: TODAY, taxRatePct: 0 }));
    expect(v.tax).toBe(0);
    expect(v.total).toBe(v.subtotal);
  });

  it("at least one seat must stay; zero or fractional seats are refused", () => {
    expect(seatReductionValue({ sub: YEARLY, seatsRemoved: 10, today: TODAY, taxRatePct: 18 })).toMatchObject({ ok: false, code: "too_many" });
    expect(seatReductionValue({ sub: YEARLY, seatsRemoved: 0, today: TODAY, taxRatePct: 18 })).toMatchObject({ ok: false, code: "invalid_seats" });
    expect(seatReductionValue({ sub: YEARLY, seatsRemoved: 1.5, today: TODAY, taxRatePct: 18 })).toMatchObject({ ok: false, code: "invalid_seats" });
  });

  it("an ended term has no unused days to credit", () => {
    expect(seatReductionValue({ sub: YEARLY, seatsRemoved: 1, today: "2027-04-05", taxRatePct: 18 })).toMatchObject({ ok: false, code: "term_ended" });
  });

  it("renewed early (renewal_date already past the next term): not priced — no whole-next-term credit", () => {
    const early: SeatReductionSub = { ...YEARLY, renewal_date: "2028-04-01" };
    expect(seatReductionValue({ sub: early, seatsRemoved: 1, today: TODAY, taxRatePct: 18 })).toMatchObject({ ok: false, code: "renewed_early" });
  });

  it("billed quarterly: only the CURRENT quarter's unused days, at the quarter's own rate", () => {
    const q: SeatReductionSub = { ...YEARLY, billing_cycle: "quarterly" };
    const v = ok(seatReductionValue({ sub: q, seatsRemoved: 2, today: TODAY, taxRatePct: 18 }));
    expect(v.instalmentPart).toBe(true);
    expect(v.partEnd).toBe("2026-12-31");     // Oct–Dec quarter
    expect(v.days).toBe(54);                  // 8 Nov → 1 Jan
    expect(v.subtotal).toBeLessThan(ok(seatReductionValue({ sub: YEARLY, seatsRemoved: 2, today: TODAY, taxRatePct: 18 })).subtotal);
  });
});

describe("seatReductionPreview (R-2252 + R-2255 split)", () => {
  const v = ok(seatReductionValue({ sub: YEARLY, seatsRemoved: 2, today: TODAY, taxRatePct: 18 }));
  const AMOUNT = 21240; // 10 × 1,800 + 18%

  it("paid invoice: the whole unused value is the customer's credit, on one credit note", () => {
    const p = seatReductionPreview(v, { id: "INV-1", openDue: 0, received: AMOUNT, alreadyCredited: 0, creditable: AMOUNT });
    expect(p.canReduceNow).toBe(true);
    expect(p.split.creditPaise).toBe(v.unusedPaise);
    expect(p.split.lowerOpenPaise).toBe(0);
    expect(p.split.document).toBe("credit-note");
    expect(p.split.documentPaise).toBe(v.unusedPaise);
  });

  it("unpaid invoice: NO credit — the unused value only lowers what they still owe", () => {
    const p = seatReductionPreview(v, { id: "INV-1", openDue: AMOUNT, received: 0, alreadyCredited: 0, creditable: AMOUNT });
    expect(p.split.creditPaise).toBe(0);
    expect(p.split.lowerOpenPaise).toBe(v.unusedPaise);
    expect(p.split.stillOwedPaise).toBe(AMOUNT * 100 - v.unusedPaise);
    expect(p.split.lines.find((l) => l.kind === "credit")?.text).toContain("nothing received yet");
  });

  it("part paid: open first, then credit only from money received", () => {
    const p = seatReductionPreview(v, { id: "INV-1", openDue: 1000, received: AMOUNT - 1000, alreadyCredited: 0, creditable: AMOUNT });
    expect(p.split.lowerOpenPaise).toBe(100000);
    expect(p.split.creditPaise).toBe(v.unusedPaise - 100000);
  });

  it("credit note can never take more than the invoice has left to credit", () => {
    const p = seatReductionPreview(v, { id: "INV-1", openDue: 0, received: AMOUNT, alreadyCredited: 0, creditable: 500 });
    expect(p.split.documentPaise).toBe(50000);
    expect(p.split.notGivenPaise).toBe(v.unusedPaise - 50000);
    expect(p.split.lines.at(-1)?.kind).toBe("not-given");
  });

  it("no tax invoice for the part yet: Now is blocked with the way forward (R-2584: never points at the hidden end-of-term choice)", () => {
    const p = seatReductionPreview(v, null);
    expect(p.canReduceNow).toBe(false);
    expect(p.blockedReason).toMatch(/after the part is invoiced/i);
    expect(p.blockedReason).not.toMatch(/end of term/i);
  });

});

describe("R-2584 — end-of-term cut stays hidden until renewal applies it (R-2583)", () => {
  it("the end-of-term choice is OFF: a scheduled cut is never applied at renewal yet, so it would over-bill", () => {
    expect(SEAT_CUT_END_OF_TERM_ENABLED).toBe(false);
  });
});
