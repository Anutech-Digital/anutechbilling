/* R-2178 — Add subscription: a typed price cleared by a switch to Flexible must come back when the
   operator switches straight back (R-876's round trip covered ÷12/×12 only; Flexible lost it). */
import { describe, expect, it } from "vitest";
import { billingTerms, convertPriceForChoice, rateAndBillText, subscriptionProducts, type PriceSwitchMemo } from "./catalog-options";

describe("R-2178 Add subscription — typed price is reversible across Flexible", () => {
  it("₹1,800/yr → Flexible (cleared, says why) → Annual yearly restores ₹1,800", () => {
    const toFlex = convertPriceForChoice("1800", "annual_yearly", "monthly_flex");
    expect(toFlex.text).toBe("");
    expect(toFlex.hint).toMatch(/Flex has its own price/);
    const memo: PriceSwitchMemo = { fromText: "1800", fromChoice: "annual_yearly", toText: "" };
    expect(convertPriceForChoice("", "monthly_flex", "annual_yearly", memo)).toEqual({ text: "1800", hint: null });
  });
  it("frequency only (Yearly → Quarterly) converts with a visible hint and comes back exactly", () => {
    const q = convertPriceForChoice("1800", "annual_yearly", "annual_quarterly");
    expect(q).toEqual({ text: "150", hint: "Converted to a monthly price: ₹1,800/yr ÷ 12." });
    const memo: PriceSwitchMemo = { fromText: "1800", fromChoice: "annual_yearly", toText: "150" };
    expect(convertPriceForChoice("150", "annual_quarterly", "annual_yearly", memo).text).toBe("1800");
  });
});

/* R-2178 OWNER RULE (Pardeep, 31 Oct): rates differ by COMMITMENT (Flexible one rate, Annual
   another — GW Starter cost ₹318 vs ₹264/seat/month). Under Annual, PAYMENT FREQUENCY never changes
   the rate: the per-seat-per-month rate stays, only the amount per bill changes (×1/×3/×6/×12). */

const STARTER = subscriptionProducts([{
  id: "GW-ST", name: "Google Workspace Business Starter", vendor: "google", kind: "main", item_type: "subscription",
  is_active: true, msrp: 300, wholesale: 264,
  prices: { annual: { msrp: 300, wholesale: 264 }, monthly: { msrp: 360, wholesale: 318 } },
} as never])[0];

describe("R-2178 owner rule — the rate is set by the commitment, not the payment frequency", () => {
  it("Annual commitment: cost ₹264/seat/month whether billed monthly, quarterly, half-yearly or yearly", () => {
    const perMonth = (c: Parameters<typeof billingTerms>[0]) => {
      const t = billingTerms(c, STARTER);
      return t.unit === "per_seat_year" ? (t.costPerSeat ?? 0) / 12 : t.costPerSeat;
    };
    for (const c of ["annual_monthly", "annual_quarterly", "annual_half_yearly", "annual_yearly"] as const) {
      expect(perMonth(c)).toBe(264);
    }
  });
  it("Flexible has its own rate (₹318), not the annual one", () => {
    expect(billingTerms("monthly_flex", STARTER).costPerSeat).toBe(318);
  });
  it("₹264/month billed yearly is ₹3,168 per bill — the per-month rate is still ₹264", () => {
    expect(rateAndBillText(264, "per_seat_month", "yearly")).toBe("Rate ₹264/seat/month · ₹3,168 a seat each yearly bill");
    expect(rateAndBillText(3168, "per_seat_year", "yearly")).toBe("Rate ₹264/seat/month · ₹3,168 a seat each yearly bill");
    expect(rateAndBillText(264, "per_seat_month", "half_yearly")).toBe("Rate ₹264/seat/month · ₹1,584 a seat each half-yearly bill");
    expect(rateAndBillText(264, "per_seat_month", "quarterly")).toBe("Rate ₹264/seat/month · ₹792 a seat each quarterly bill");
    expect(rateAndBillText(264, "per_seat_month", "monthly")).toBe("Rate ₹264/seat/month · ₹264 a seat each monthly bill");
  });
  it("LOOK BOOK FLY: ₹1,800 a YEAR reads as ₹150/seat/month — never ₹1,800 a month", () => {
    expect(rateAndBillText(1800, "per_seat_year", "yearly")).toBe("Rate ₹150/seat/month · ₹1,800 a seat each yearly bill");
  });
  it("a typed yearly price switched to quarterly keeps the per-month rate (₹3,168/yr → ₹264/mo)", () => {
    const q = convertPriceForChoice("3168", "annual_yearly", "annual_quarterly");
    expect(q.text).toBe("264");
    expect(rateAndBillText(Number(q.text), "per_seat_month", "quarterly")).toBe("Rate ₹264/seat/month · ₹792 a seat each quarterly bill");
  });
});
