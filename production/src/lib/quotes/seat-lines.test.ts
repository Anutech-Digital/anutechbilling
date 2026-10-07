import { describe, it, expect } from "vitest";
import { isSeatLine, quoteSeatCount } from "./seat-lines";

/* Q-FBB9-27-0013 line_items, as saved (7 Oct). */
const kapoor = [
  { qty: 25, name: "Google Workspace Standard", commitment: "annual_yearly" },
  { qty: 1, name: "ANUTECH DIGITAL PVT LTD Standard Support (Yearly)", item_id: "SUP-STANDARD-YR-fbb976f190904f1097260901bd144e42", commitment: "annual_yearly" },
  { qty: 1, name: "Data migration (one-time service)" },
];

describe("R-389 (F7): seats = licence lines only", () => {
  it("Kapoor quote is 25 seats, not 27", () => {
    expect(quoteSeatCount(kapoor)).toBe(25);
  });
  it("support and one-time lines are not seats", () => {
    expect(isSeatLine(kapoor[1])).toBe(false);
    expect(isSeatLine(kapoor[2])).toBe(false);
    expect(isSeatLine({ qty: 1, name: "Premium Support", commitment: "monthly" })).toBe(false);
  });
  it("monthly flex and annual licences both count", () => {
    expect(quoteSeatCount([{ qty: 5, name: "M365 Basic", commitment: "monthly" }, { qty: 3, name: "GW Starter", commitment: "annual_yearly" }])).toBe(8);
  });
  it("no licence lines → null", () => {
    expect(quoteSeatCount([kapoor[2]])).toBeNull();
    expect(quoteSeatCount(null)).toBeNull();
  });
});
