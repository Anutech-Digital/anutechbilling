/**
 * R-800 — Add seats with an "Effective date": the pro-rata charge runs from the date the seats
 * were provisioned, not from today. Range: current term start ≤ date ≤ today.
 *
 * Real-shaped case from Abhishek's report: Google Workspace Business Starter, 10 seats at
 * ₹2,700/mo (₹3,240/seat/yr), term 1 Apr 2026 → 1 Apr 2027 (365 days), today 10 Oct 2026.
 */
import { describe, it, expect } from "vitest";
import { checkSeatEffectiveDate, seatEffectiveBounds } from "./seat-effective-date";
import { seatChargeWindow } from "./seat-charge-window";
import { prorate, rupeesToPaise, paiseToRupees } from "./proration";
import { addSeats, type AddSeatsInput } from "./add-seats";
import type { BillingCycle } from "@/lib/supabase/database.types";

const TODAY = "2026-10-10";
const SUB = {
  mrr: 2700,
  seats: 10,
  billing_cycle: "yearly" as BillingCycle,
  term_months: 12,
  start_date: "2026-04-01",
  renewal_date: "2027-04-01",
};

describe("checkSeatEffectiveDate — allowed range", () => {
  it("empty means today, not backdated", () => {
    expect(checkSeatEffectiveDate(undefined, SUB, TODAY)).toEqual({ ok: true, date: TODAY, backdated: false });
    expect(checkSeatEffectiveDate("", SUB, TODAY)).toEqual({ ok: true, date: TODAY, backdated: false });
  });

  it("today is allowed", () => {
    expect(checkSeatEffectiveDate(TODAY, SUB, TODAY)).toEqual({ ok: true, date: TODAY, backdated: false });
  });

  it("a backdated date inside the term is allowed and flagged", () => {
    expect(checkSeatEffectiveDate("2026-09-25", SUB, TODAY)).toEqual({ ok: true, date: "2026-09-25", backdated: true });
  });

  it("the term start itself is allowed; the day before is refused", () => {
    expect(checkSeatEffectiveDate("2026-04-01", SUB, TODAY).ok).toBe(true);
    const r = checkSeatEffectiveDate("2026-03-31", SUB, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/before this term started/);
  });

  it("a future date is refused", () => {
    const r = checkSeatEffectiveDate("2026-10-11", SUB, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/future/);
  });

  it("garbage and impossible dates are refused", () => {
    expect(checkSeatEffectiveDate("10/09/2026", SUB, TODAY).ok).toBe(false);
    expect(checkSeatEffectiveDate("2026-02-30", SUB, TODAY).ok).toBe(false);
  });

  it("bounds feed the date picker: min = term start, max = today", () => {
    expect(seatEffectiveBounds(SUB, TODAY)).toEqual({ min: "2026-04-01", max: TODAY });
  });

  /* R-801: was min 2026-04-01 (renewal − 365). With no start_date renewal_date is read as the
     INCLUSIVE last day, so the 365-day term ending 1 Apr 2027 starts on 2 Apr 2026. */
  it("without a start_date the term is the 365 days ending ON the (inclusive) renewal date", () => {
    expect(seatEffectiveBounds({ ...SUB, start_date: null }, TODAY)).toEqual({ min: "2026-04-02", max: TODAY });
  });
});

describe("pro-rata from the effective date (integer paise engine)", () => {
  const annualPerSeatPaise = rupeesToPaise(3240);
  const charge = (from: string) => {
    const w = seatChargeWindow(SUB, TODAY, from)!;
    return { w, c: prorate({ annualPerSeatPaise, seats: 2, remainingDays: w.remainingDays, termDays: w.termDays, taxRatePct: 18 }) };
  };

  it("today: 173 of 365 days — same as before R-800", () => {
    const { w, c } = charge(TODAY);
    expect(w.remainingDays).toBe(173);
    expect(w).toEqual(seatChargeWindow(SUB, TODAY)); // default unchanged
    // 324000 × 2 × 173 / 365 = 307134.25 → 307134 paise
    expect(c.subtotalPaise).toBe(307134);
  });

  it("backdated 15 days: 188 of 365 days, charged more", () => {
    const { w, c } = charge("2026-09-25");
    expect(w.remainingDays).toBe(188);
    // 324000 × 2 × 188 / 365 = 333764.38 → 333764 paise
    expect(c.subtotalPaise).toBe(333764);
    expect(c.subtotalPaise).toBeGreaterThan(charge(TODAY).c.subtotalPaise);
  });

  it("term start: the full term, exactly the annual price", () => {
    const { w, c } = charge("2026-04-01");
    expect(w.remainingDays).toBe(365);
    expect(c.subtotalPaise).toBe(648000);
  });

  it("split-billed: the instalment is picked by today, the days run from the effective date", () => {
    const q = { ...SUB, billing_cycle: "quarterly" as BillingCycle };
    const now = seatChargeWindow(q, TODAY)!;            // quarter 1 Oct 2026 → 1 Jan 2027
    const back = seatChargeWindow(q, TODAY, "2026-09-25")!;
    expect(now.instalmentPeriod).toBe(true);
    expect(now.remainingDays).toBe(83);
    expect(back.instalmentPeriod).toBe(true);
    expect(back.chargeTo).toBe(now.chargeTo);
    expect(back.remainingDays).toBe(98);                // 15 more days, into the invoiced quarter
  });
});

/* ── addSeats() writes the effective date on the quote line + note ────────── */

function fakeSupabase(quotes: Record<string, unknown>[]) {
  const table = (name: string) => ({
    select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    insert: (row: Record<string, unknown>) => {
      if (name === "quotes") quotes.push(row);
      return Promise.resolve({ error: null });
    },
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  });
  return {
    from: (name: string) => table(name),
    rpc: () => Promise.resolve({ data: "Q-TEST-0001", error: null }),
  } as unknown as AddSeatsInput["supabase"];
}

function run(over: Partial<AddSeatsInput>) {
  const quotes: Record<string, unknown>[] = [];
  const p = addSeats({
    supabase: fakeSupabase(quotes),
    subscriptionId: "sub-1", tenantId: "t-1", customerId: "c-1", customerName: "HOK Agrichem",
    plan: "Google Workspace Business Starter", vendor: "google", domain: "hok.in",
    currentSeats: 10, currentMrr: 2700, additionalSeats: 2,
    renewalDate: "2027-04-01", graceDays: 7, taxRatePct: 18, termDays: 365,
    todayISO: TODAY,
    ...over,
  });
  return { p, quotes };
}

describe("addSeats — effective date", () => {
  it("backdated: charges 188 days, names the period on the line, records who chose it", async () => {
    const { p, quotes } = run({ effectiveDate: "2026-09-25", effectiveDateSetBy: "Abhishek" });
    const r = await p;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proRataDays).toBe(188);
    expect(r.effectiveDate).toBe("2026-09-25");
    expect(quotes[0].subtotal).toBe(paiseToRupees(333764));
    const line = (quotes[0].line_items as { name: string }[])[0];
    expect(line.name).toContain("pro-rata from 2026-09-25 to 2027-04-01");
    expect(quotes[0].notes).toContain("Effective date 2026-09-25 (backdated by Abhishek on 2026-10-10)");
  });

  it("default: today, no backdated note", async () => {
    const { p, quotes } = run({});
    const r = await p;
    expect(r.ok && r.proRataDays).toBe(173);
    expect(String(quotes[0].notes)).not.toContain("backdated");
  });

  it("a future effective date is refused and nothing is written", async () => {
    const { p, quotes } = run({ effectiveDate: "2026-10-11" });
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_effective_date");
    expect(quotes).toHaveLength(0);
  });
});
