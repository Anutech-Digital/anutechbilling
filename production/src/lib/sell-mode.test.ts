import { describe, expect, it } from "vitest";
import { DEFAULT_SELL_MODE, SELL_MODES, SELL_MODE_LABEL, isSellMode, parseSellMode, sellsSubscriptions } from "./sell-mode";

describe("sell mode (R-1860)", () => {
  it("has exactly three answers, default Both", () => {
    expect(SELL_MODES).toEqual(["subscriptions", "one_time", "both"]);
    expect(DEFAULT_SELL_MODE).toBe("both");
    expect(SELL_MODE_LABEL.both).toBe("Both");
  });

  it("reads anything unknown as Both — a missing column or null never hides a screen", () => {
    expect(parseSellMode(null)).toBe("both");
    expect(parseSellMode(undefined)).toBe("both");
    expect(parseSellMode("One_time")).toBe("both");
    expect(parseSellMode(3)).toBe("both");
    expect(parseSellMode("one_time")).toBe("one_time");
    expect(parseSellMode("subscriptions")).toBe("subscriptions");
  });

  it("isSellMode only accepts the three stored values", () => {
    expect(isSellMode("both")).toBe(true);
    expect(isSellMode("")).toBe(false);
  });

  it("only a one-time business drops subscription screens", () => {
    expect(sellsSubscriptions("one_time")).toBe(false);
    expect(sellsSubscriptions("both")).toBe(true);
    expect(sellsSubscriptions("subscriptions")).toBe(true);
  });
});
