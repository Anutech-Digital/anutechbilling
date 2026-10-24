import { describe, it, expect } from "vitest";
import { correctionVerdict, mrrForSeats, seatCutWarning, type CorrectionFacts } from "./correct-terms";

/* T-12: annual, 15 seats, MRR ₹16,200, term 1 Oct 2026 – 30 Sep 2027, checked 19 Oct 2026. */
const base: CorrectionFacts = {
  role: "owner", seatsNow: 15, seatsNext: 15, mrrNow: 16_200, mrrNext: 16_200,
  itemNow: "GW-STD", itemNext: "GW-STD", termMonths: 12,
  startDate: "2026-10-01", renewalDate: "2027-09-30", today: "2026-10-19",
};

describe("R-1684: Correct details — seats / plan / price", () => {
  it("T-12: 15 → 10 seats mid-term on an annual plan is a commitment cut", () => {
    const v = correctionVerdict({ ...base, seatsNext: 10, mrrNext: 10_800 });
    expect(v).toMatchObject({ changed: true, seatCut: true, midTermCommitmentCut: true, roleBlock: null });
  });

  it("a monthly (flex) term is not an annual commitment", () => {
    const v = correctionVerdict({ ...base, termMonths: 1, renewalDate: "2026-10-31", seatsNext: 10 });
    expect(v.midTermCommitmentCut).toBe(false);
  });

  it("seat cut / plan change: owner or manager only; billing may correct a price", () => {
    expect(correctionVerdict({ ...base, role: "billing", seatsNext: 10 }).roleBlock).toMatch(/owner or manager/);
    expect(correctionVerdict({ ...base, role: "billing", itemNext: "GW-PLUS" }).roleBlock).toMatch(/owner or manager/);
    expect(correctionVerdict({ ...base, role: "billing", mrrNext: 16_000 }).roleBlock).toBeNull();
    expect(correctionVerdict({ ...base, role: "sales", mrrNext: 16_000 }).roleBlock).toMatch(/accountant or billing/);
    expect(correctionVerdict({ ...base, role: "sales" }).roleBlock).toBeNull();   // nothing changed
  });

  it("MRR follows the seats at the subscription's own per-seat price", () => {
    expect(mrrForSeats(16_200, 15, 10)).toBe(10_800);
    expect(mrrForSeats(16_200, 15, 0)).toBe(0);
    expect(mrrForSeats(500, 0, 3)).toBe(500);
  });

  it("the warning says no refund and names the credit note", () => {
    const w = seatCutWarning({ seatsNow: 15, seatsNext: 10, renewalDate: "2027-09-30", fmt: (d) => d });
    expect(w).toContain("Cutting 5 seats now refunds nothing");
    expect(w).toContain("credit note");
    expect(w).toContain("until 2027-09-30");
  });
});
