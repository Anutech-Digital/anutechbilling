/** R-2761 — open 'held' undo moves → one RenewalHeld per subscription (held.ts). */
import { describe, it, expect } from "vitest";
import { openHoldsBySubscription } from "./held";

describe("R-2761 openHoldsBySubscription", () => {
  it("newest open hold per subscription wins; dates trimmed; unknown kind → null", () => {
    const m = openHoldsBySubscription([
      { id: 5, subscription_id: "s1", from_date: "2027-09-30", to_date: "2026-09-30", hold_kind: "not_active" },
      { id: 9, subscription_id: "s1", from_date: "2027-09-30", to_date: "2026-09-30", hold_kind: "quote_linked" },
      { id: 7, subscription_id: "s2", from_date: "2027-03-31T00:00:00", to_date: "2026-12-31", hold_kind: "weird" },
    ]);
    expect(m.get("s1")).toEqual({ kind: "quote_linked", from: "2027-09-30", to: "2026-09-30" });
    expect(m.get("s2")).toEqual({ kind: null, from: "2027-03-31", to: "2026-12-31" });
    expect(m.size).toBe(2);
  });
  it("no rows → empty", () => {
    expect(openHoldsBySubscription([]).size).toBe(0);
  });
});
