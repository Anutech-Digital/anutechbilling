// R-1727: the owner's example — company page "MRR … 1 sub · 0/10 seats" ("0 kya?").
import { describe, it, expect } from "vitest";
import { seatsPhrase, manageSeatsHref, manageSeatsIdFromSearch } from "./seat-words";
import { subscriptionFacts } from "@/lib/subscriptions/facts";

describe("R-1727 seatsPhrase — no unexplained 0/10", () => {
  it("owner's case: 1 subscription, 10 seats, used never synced (0) → '10 seats licensed'", () => {
    const out = seatsPhrase([{ seats: 10, used: 0 }]);
    expect(out).toBe("10 seats licensed");
    expect(out).not.toMatch(/0\/10/);
  });
  it("a real assigned count reads in words", () => {
    expect(seatsPhrase([{ seats: 10, used: 6 }])).toBe("6 of 10 seats used");
  });
  it("mixed measured + unmeasured subscriptions do not claim a used figure", () => {
    expect(seatsPhrase([{ seats: 10, used: 6 }, { seats: 5, used: 0 }])).toBe("15 seats licensed");
  });
  it("no seats → empty, singular seat", () => {
    expect(seatsPhrase([])).toBe("");
    expect(seatsPhrase([{ seats: 1, used: null }])).toBe("1 seat licensed");
  });
  it("same rule as the drawer's Seats fact (one fact, one wording)", () => {
    const seats = (s: { seats: number; used: number }) =>
      subscriptionFacts({ ...s, mrr: 0, status: "active", outstanding_amount: 0 }).find((f) => f.label === "Seats")!.value;
    expect(seats({ seats: 10, used: 0 })).toBe("10 licensed");
    expect(seats({ seats: 10, used: 6 })).toBe("6 of 10 used");
  });
});

describe("R-1727 Manage seats link from the company page", () => {
  it("round-trips the subscription id", () => {
    const href = manageSeatsHref("sub 1");
    expect(href).toBe("/subscriptions?seats=sub%201");
    expect(manageSeatsIdFromSearch(href.slice(href.indexOf("?")))).toBe("sub 1");
    expect(manageSeatsIdFromSearch("?q=x")).toBe("");
  });
});
