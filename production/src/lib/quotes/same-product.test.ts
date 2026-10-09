import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sameProductSubscriptions, sameProductNote, type SubLike } from "./same-product";

const sub = (over: Partial<SubLike> = {}): SubLike => ({
  id: "S1", customer_id: "C1", item_id: "I-STARTER", plan: "Business Starter", seats: 10,
  status: "active", renewal_date: "2027-10-08", domain: "sharma.in", customer_name: "Sharma Traders", ...over,
});
const starter = { item_id: "I-STARTER", name: "Business Starter", commitment: "annual_yearly" };

describe("R-468 (2): same product already subscribed", () => {
  it("finds the live subscription to the same product (Sharma Traders case)", () => {
    expect(sameProductSubscriptions("C1", [starter], [sub()]).map((s) => s.id)).toEqual(["S1"]);
  });
  it("matches by plan name when the subscription has no item id", () => {
    expect(sameProductSubscriptions("C1", [starter], [sub({ item_id: null })])).toHaveLength(1);
  });
  it("ignores other customers, other products, cancelled ones and one-time lines", () => {
    expect(sameProductSubscriptions("C2", [starter], [sub()])).toEqual([]);
    expect(sameProductSubscriptions("C1", [starter], [sub({ item_id: "I-PLUS", plan: "Business Plus" })])).toEqual([]);
    expect(sameProductSubscriptions("C1", [starter], [sub({ status: "cancelled" })])).toEqual([]);
    expect(sameProductSubscriptions("C1", [{ ...starter, commitment: null }], [sub()])).toEqual([]);
    expect(sameProductSubscriptions(null, [starter], [sub()])).toEqual([]);
  });
  it("the note names the plan, seats and the way to keep one subscription", () => {
    const n = sameProductNote(sub(), "8 Oct 2027");
    expect(n).toContain("Business Starter (10 seats, renews 8 Oct 2027)");
    expect(n).toContain("Add seats");
  });
  it("the builder shows the banner", () => {
    const src = readFileSync(join(__dirname, "../../components/features/quotes/quote-builder.tsx"), "utf8");
    expect(src).toMatch(/sameProductSubscriptions\(customerId, lineItems, allSubscriptions/);
    expect(src).toMatch(/sameProductNote\(/);
  });
});
