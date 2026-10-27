import { describe, it, expect } from "vitest";
import { isSeatLine, quoteSeatCount, leadSeatCount } from "./seat-lines";

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

/* R-1673 (4): staging T-3R — a lead quote for 25 Workspace + 5 M365 + 1 domain showed
   "31 seats". A domain registration is not a seat. */
describe("R-1673 (4): a domain line is not a seat", () => {
  const t3r = [
    { qty: 25, name: "Google Workspace Business Starter", commitment: "annual_yearly" },
    { qty: 5, name: "Microsoft 365 Business Basic", commitment: "annual_yearly" },
    { qty: 1, name: "Domain registration (.in)", commitment: "annual_yearly", domain: "acme.in" },
  ];
  it("T-3R is 30 seats, not 31", () => {
    expect(quoteSeatCount(t3r)).toBe(30);
  });
  it("a domain line is caught by name, by its registrant, or by being the domain itself", () => {
    expect(isSeatLine(t3r[2])).toBe(false);
    expect(isSeatLine({ qty: 1, name: "acme.in", domain: "acme.in", commitment: "annual_yearly" })).toBe(false);
    expect(isSeatLine({ qty: 1, name: ".com", domain: "x.com", registrant: { name: "X" }, commitment: "annual_yearly" })).toBe(false);
  });
  it("a Workspace line that only NAMES its domain is still seats", () => {
    expect(isSeatLine({ qty: 25, name: "Google Workspace Business Starter", domain: "acme.in", commitment: "annual_yearly" })).toBe(true);
  });
});

/* R-1959: Pardeep, localhost (lead L-MVNY6VXO / Q-4786-27-0001) — an empty catalogue, so the
   quote's line was a "Custom item" (no commitment) for 10 seats, and the lead it made showed
   Seats "—". quoteSeatCount only counts licence lines, so it gave null and the new lead got 0. */
describe("R-1959: leadSeatCount — licence lines first, else Σqty of the real product lines", () => {
  const custom = { qty: 10, name: "GW Business Starter (1 year)" };
  it("a custom line with no commitment still gives the lead its 10 seats", () => {
    expect(quoteSeatCount([custom])).toBeNull();
    expect(leadSeatCount([custom])).toBe(10);
  });
  it("licence lines win when there are any (Kapoor stays 25, not 27)", () => {
    expect(leadSeatCount(kapoor)).toBe(25);
  });
  it("the fallback leaves out support and domain lines", () => {
    expect(leadSeatCount([
      custom,
      { qty: 1, name: "Standard Support" },
      { qty: 1, name: "SUP", item_id: "SUP-STANDARD-YR-x" },
      { qty: 1, name: "Domain registration (.in)", domain: "acme.in" },
    ])).toBe(10);
  });
  it("nothing worth calling seats → null (never 0)", () => {
    expect(leadSeatCount([{ qty: 1, name: "Premium Support" }])).toBeNull();
    expect(leadSeatCount([])).toBeNull();
    expect(leadSeatCount(null)).toBeNull();
  });
});
