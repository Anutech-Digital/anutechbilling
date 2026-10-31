/* R-2053 — Reconcile → "A new sale". (1) A price the owner TYPED is kept when Commitment changes,
   converted Annual ₹/user/year ↔ Monthly ₹/user/month (÷12 / ×12, whole rupees); an untouched
   line takes the floored catalogue price (R-2050); one-time keeps the typed number. (2) The term
   is said once: "1 year: 23-10-2026 to 22-10-2027 · renews 23-10-2027" — the saved renewal date
   (start + whole terms) is unchanged. Decisions: Pardeep delegated, 28 Oct. */
import { describe, expect, it } from "vitest";
import { convertTypedPrice, paidUpText, repriceLine, saleLineFromItem, salePaidUp, saleSchedule, saleTermText, typedPriceCheck, type SaleLine } from "./credit-pay-for";

const STARTER = {
  id: "GW-ST", name: "Google Workspace Business Starter", vendor: "google", msrp: 270, wholesale: 110,
  item_type: "subscription", prices: { annual: { msrp: 270, wholesale: 110 }, monthly: { msrp: 325, wholesale: 132 } },
} as never;
const typed = (l: SaleLine, rate: number): SaleLine => ({ ...l, rate, priceTyped: true });

/* R-2178 (staging 31 Oct): the silent ÷12 / ×12 below chained through One-time into a ×12 of a typed
   ₹1,800/user/year. A typed price is now KEPT as typed; the conversion is an explicit button
   (credit-pay-for-r2178.test.ts). These keep R-2053's intent: the deal price survives. */
describe("R-2053 (1) a typed price survives a Commitment change", () => {
  it("owner's example: Annual typed 3000 → Monthly flex keeps 3000 (and asks) → Annual 3000", () => {
    const a = typed(saleLineFromItem(STARTER, "annual_yearly", 10), 3000);
    const m = repriceLine(a, STARTER, "monthly");
    expect(m).toMatchObject({ cycle: "monthly", rate: 3000, priceTyped: true, cost: 132 });
    expect(typedPriceCheck(m)).toMatchObject({ convertRate: 250 });
    expect(repriceLine(m, STARTER, "annual_yearly")).toMatchObject({ cycle: "annual_yearly", rate: 3000, cost: 1320 });
  });
  it("whole rupees: typed ₹3,250 a year → the explicit ÷ 12 gives ₹271 a month", () => {
    const m = repriceLine(typed(saleLineFromItem(STARTER, "annual_yearly", 1), 3250), STARTER, "monthly");
    expect(m.rate).toBe(3250);
    expect({ ...m, ...convertTypedPrice(m) }.rate).toBe(271);
  });
  it("an untouched line takes the floored catalogue price for the new commitment", () => {
    const a = saleLineFromItem(STARTER, "annual_yearly", 10);
    expect(a.priceTyped).toBeFalsy();
    const m = repriceLine(a, STARTER, "monthly");
    expect(m.rate).toBe(325);
    expect(repriceLine(m, STARTER, "annual_yearly").rate).toBe(3240);
  });
  it("one-time keeps the typed number as it is, both ways", () => {
    const o = repriceLine(typed(saleLineFromItem(STARTER, "annual_yearly", 1), 3000), STARTER, "one_time");
    expect(o).toMatchObject({ cycle: "one_time", rate: 3000 });
    expect(repriceLine(o, STARTER, "annual_yearly").rate).toBe(3000);
  });
  it("a new product line starts untouched", () => {
    expect(saleLineFromItem(STARTER, "monthly", 3).priceTyped).toBeFalsy();
  });
});

describe("R-2053 (2) the term, said once", () => {
  it("1 year: 23-10-2026 to 22-10-2027 · renews 23-10-2027", () => {
    expect(saleTermText("2026-10-23", "2027-10-23")).toBe("1 year: 23-10-2026 to 22-10-2027 · renews 23-10-2027");
  });
  it("Monthly flex: 1 month", () => {
    expect(saleTermText("2026-10-23", "2026-11-23")).toBe("1 month: 23-10-2026 to 22-11-2026 · renews 23-11-2026");
  });
  it("an edited renewal date: 'Term'; renewal not after start: nothing", () => {
    expect(saleTermText("2026-10-23", "2027-04-01")).toBe("Term: 23-10-2026 to 31-03-2027 · renews 01-04-2027");
    expect(saleTermText("2026-10-23", "2026-10-23")).toBeNull();
  });
  it("whole year paid by extra money: the year end is not said again in the paid-up line", () => {
    const lines = [saleLineFromItem(STARTER, "annual_yearly", 10)];
    const p = salePaidUp(saleSchedule(lines, 18, "half_yearly", "2026-10-23"), 19116, "2027-10-23")!;
    expect(paidUpText(p)).toBe("The whole year is paid.");
  });
});
