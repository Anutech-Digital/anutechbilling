/**
 * R-1851 — share capital + shareholders register rules (pure). Written before share-capital.ts.
 */
import { describe, it, expect } from "vitest";
import {
  showsShareCapital, shareCapitalSummary, capitalFormErrors, shareholderFormErrors, normaliseShareholderInput,
  looksLikeShareCapitalLine, type Shareholder,
} from "./share-capital";

const sh = (id: string, name: string, shares: number, pan: string | null = null): Shareholder =>
  ({ id, name, pan, shares, allotted_on: "2024-04-01" });

describe("who sees it", () => {
  it("only a Pvt Ltd (empty type = Pvt Ltd)", () => {
    expect(showsShareCapital("pvt_ltd")).toBe(true);
    expect(showsShareCapital(null)).toBe(true);
    expect(showsShareCapital("proprietor")).toBe(false);
    expect(showsShareCapital("llp")).toBe(false);
  });
});

describe("the summary (card example: authorised ₹10L, FV ₹10, 50,000 + 50,000 shares)", () => {
  const capital = { authorised_capital: 1000000, face_value: 10 };
  it("paid-up = shares × face value = ₹10,00,000; each holder 50%", () => {
    const s = shareCapitalSummary(capital, [sh("a", "Asha", 50000), sh("b", "Bimal", 50000)]);
    expect(s.paidUpShares).toBe(100000);
    expect(s.paidUpCapital).toBe(1000000);
    expect(s.unissuedCapital).toBe(0);
    expect(s.overAuthorised).toBe(false);
    expect(s.holders.map((h) => h.pct)).toEqual([50, 50]);
  });
  it("percentages to 2 decimals and they add up to 100", () => {
    const s = shareCapitalSummary(capital, [sh("a", "A", 1), sh("b", "B", 1), sh("c", "C", 1)]);
    expect(s.holders.map((h) => h.pct)).toEqual([33.33, 33.33, 33.33]);
    expect(s.paidUpShares).toBe(3);
  });
  it("no capital set yet or no shareholders: paid-up 0", () => {
    expect(shareCapitalSummary(null, [sh("a", "A", 100)]).paidUpCapital).toBe(0);
    expect(shareCapitalSummary(capital, []).paidUpCapital).toBe(0);
  });
  it("more than authorised is flagged (1,10,000 shares × ₹10 > ₹10L)", () => {
    const s = shareCapitalSummary(capital, [sh("a", "A", 110000)]);
    expect(s.paidUpCapital).toBe(1100000);
    expect(s.overAuthorised).toBe(true);
  });
});

describe("the capital form", () => {
  it("authorised and face value are whole rupees above 0", () => {
    expect(capitalFormErrors({ authorised_capital: "1000000", face_value: "10" }, 0)).toEqual({});
    expect(capitalFormErrors({ authorised_capital: "", face_value: "10" }, 0).authorised).toBe("Enter the authorised capital in whole rupees, e.g. 1000000.");
    expect(capitalFormErrors({ authorised_capital: "10,00,000", face_value: "10" }, 0)).toEqual({});
    expect(capitalFormErrors({ authorised_capital: "1000000", face_value: "0" }, 0).faceValue).toBe("Enter the face value of one share in whole rupees, e.g. 10.");
    expect(capitalFormErrors({ authorised_capital: "1000000", face_value: "2.5" }, 0).faceValue).toBe("Enter the face value of one share in whole rupees, e.g. 10.");
  });
  it("cannot go below what is already issued", () => {
    // 1,00,000 shares issued: authorised ₹5L at ₹10 is too low
    expect(capitalFormErrors({ authorised_capital: "500000", face_value: "10" }, 100000).authorised)
      .toBe("The shareholders already hold 1,00,000 shares × ₹10 = ₹10,00,000 — the authorised capital cannot be less.");
  });
});

describe("the shareholder form", () => {
  const capital = { authorised_capital: 1000000, face_value: 10 };
  const holders = [sh("a", "Asha", 50000, "ABCPV1234K")];
  it("a valid holder passes", () => {
    expect(shareholderFormErrors({ name: "Bimal", pan: "", shares: "50000", allotted_on: "2024-04-01" }, holders, null, capital)).toEqual({});
  });
  it("shares must be a whole number above 0", () => {
    expect(shareholderFormErrors({ name: "B", pan: "", shares: "0", allotted_on: "" }, holders, null, capital).shares).toBe("Enter the number of shares, a whole number above 0.");
    expect(shareholderFormErrors({ name: "B", pan: "", shares: "1.5", allotted_on: "" }, holders, null, capital).shares).toBe("Enter the number of shares, a whole number above 0.");
  });
  it("shares beyond the authorised capital are refused (card: 1,10,000 shares)", () => {
    expect(shareholderFormErrors({ name: "B", pan: "", shares: "60000", allotted_on: "" }, holders, null, capital).shares)
      .toBe("That makes 1,10,000 shares × ₹10 = ₹11,00,000 — more than the authorised capital of ₹10,00,000. Raise the authorised capital first.");
  });
  it("editing a holder counts their new shares, not old + new", () => {
    expect(shareholderFormErrors({ name: "Asha", pan: "ABCPV1234K", shares: "100000", allotted_on: "" }, holders, "a", capital)).toEqual({});
  });
  it("no capital set yet: asks for it first", () => {
    expect(shareholderFormErrors({ name: "B", pan: "", shares: "10", allotted_on: "" }, [], null, null).shares).toBe("Set the authorised capital and face value first.");
  });
  it("name required; PAN format and duplicate PAN refused", () => {
    expect(shareholderFormErrors({ name: " ", pan: "", shares: "1", allotted_on: "" }, holders, null, capital).name).toBe("Enter the shareholder's name.");
    expect(shareholderFormErrors({ name: "B", pan: "ABC", shares: "1", allotted_on: "" }, holders, null, capital).pan).toMatch(/PAN must be 10 characters/);
    expect(shareholderFormErrors({ name: "B", pan: "abcpv1234k", shares: "1", allotted_on: "" }, holders, null, capital).pan).toBe("PAN ABCPV1234K is already used by another shareholder.");
  });
  it("normalises", () => {
    expect(normaliseShareholderInput({ name: " Bimal ", pan: " bcdpr2345l ", shares: "50,000", allotted_on: "" }))
      .toEqual({ name: "Bimal", pan: "BCDPR2345L", shares: 50000, allotted_on: null });
  });
});

describe("a hand-entered Share capital line (would count the same money twice)", () => {
  it("matches share-capital words, not securities premium or reserves", () => {
    expect(looksLikeShareCapitalLine({ label: "Share capital", notes: null })).toBe(true);
    expect(looksLikeShareCapitalLine({ label: "Equity share capital", notes: null })).toBe(true);
    expect(looksLikeShareCapitalLine({ label: "Paid-up capital", notes: null })).toBe(true);
    expect(looksLikeShareCapitalLine({ label: "Owner's capital", notes: null })).toBe(true);
    expect(looksLikeShareCapitalLine({ label: "Securities premium", notes: null })).toBe(false);
    expect(looksLikeShareCapitalLine({ label: "General reserve", notes: null })).toBe(false);
  });
});
