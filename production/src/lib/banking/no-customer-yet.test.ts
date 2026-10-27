import { describe, it, expect } from "vitest";
import { isNoCustomerYet, noCustomerYet } from "./no-customer-yet";

describe("R-1863 Money in · no customer yet", () => {
  const customers = [{ id: "c1", name: "Acme Traders" }];
  const t = (id: string, o: Partial<{ credit: number; matched_to_type: string | null; description: string }>) =>
    ({ id, credit: 1000, matched_to_type: null as string | null, description: "NEFT XYZ", ...o });

  it("only unmatched credits nobody can be guessed for", () => {
    const list = [
      t("a", { description: "NEFT ACME TRADERS" }),   // guessed by name
      t("b", {}),                                      // nobody
      t("c", { matched_to_type: "payment" }),          // reconciled
      t("d", { credit: 0 }),                           // money out
      t("e", { description: "IMPS 99812" }),           // nobody
    ];
    expect(noCustomerYet(list, customers).map((x) => x.id)).toEqual(["b", "e"]);
  });

  it("a certain invoice match of one customer counts as a guess", () => {
    expect(isNoCustomerYet(t("b", {}), customers, [{ customerName: "Acme Traders", confidence: "certain" }])).toBe(false);
    expect(isNoCustomerYet(t("b", {}), customers)).toBe(true);
  });
});
