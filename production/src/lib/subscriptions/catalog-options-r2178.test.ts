/* R-2178 — Add subscription: a typed price cleared by a switch to Flexible must come back when the
   operator switches straight back (R-876's round trip covered ÷12/×12 only; Flexible lost it). */
import { describe, expect, it } from "vitest";
import { convertPriceForChoice, type PriceSwitchMemo } from "./catalog-options";

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
