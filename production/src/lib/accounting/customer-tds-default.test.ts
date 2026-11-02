/**
 * R-2370 — the customer's own TDS (section + rate) on the customer form.
 * Owner's case (staging 2 Nov): Supreme Media deducts 194C @ 1% but showed "194J @ 10%".
 */
import { describe, it, expect } from "vitest";
import {
  customerTdsPrefill, rateForPickedSection, customerTdsRateProblem, customerTdsPayload, customerTdsLabel,
} from "./customer-tds-default";

describe("customer TDS default (R-2370)", () => {
  it("opens with the saved section + rate", () => {
    expect(customerTdsPrefill({ tds_default_section: "194J", tds_default_rate_pct: 10 })).toEqual({ section: "194J", ratePct: "10" });
    expect(customerTdsPrefill({ tds_default_section: "194c", tds_default_rate_pct: "1.00" })).toEqual({ section: "194C", ratePct: "1" });
  });

  it("nothing saved → No TDS; a rate with no section reads as 194J (the receipt fallback)", () => {
    expect(customerTdsPrefill({ tds_default_section: null, tds_default_rate_pct: null })).toEqual({ section: "", ratePct: "" });
    expect(customerTdsPrefill(null)).toEqual({ section: "", ratePct: "" });
    expect(customerTdsPrefill({ tds_default_section: null, tds_default_rate_pct: 10 })).toEqual({ section: "194J", ratePct: "10" });
  });

  it("picking a section fills its default rate from the one rate table", () => {
    expect(rateForPickedSection("194C")).toBe("2");
    expect(rateForPickedSection("194J")).toBe("10");
    expect(rateForPickedSection("194H")).toBe("2");
    expect(rateForPickedSection("194Q")).toBe("0.1");
    expect(rateForPickedSection("")).toBe("");
  });

  it("a picked section needs a rate between 0 and 100", () => {
    expect(customerTdsRateProblem({ section: "194C", ratePct: "" })).toMatch(/rate/i);
    expect(customerTdsRateProblem({ section: "194C", ratePct: "120" })).toMatch(/0 and 100/);
    expect(customerTdsRateProblem({ section: "194C", ratePct: "abc" })).toMatch(/0 and 100/);
    expect(customerTdsRateProblem({ section: "194C", ratePct: "1" })).toBeNull();
    expect(customerTdsRateProblem({ section: "", ratePct: "" })).toBeNull();
  });

  it("saves 194C @ 1% as the two columns; No TDS saves both null", () => {
    expect(customerTdsPayload({ section: "194C", ratePct: "1" })).toEqual({ tds_default_section: "194C", tds_default_rate_pct: 1 });
    expect(customerTdsPayload({ section: "194Q", ratePct: "0.1" })).toEqual({ tds_default_section: "194Q", tds_default_rate_pct: 0.1 });
    expect(customerTdsPayload({ section: "", ratePct: "10" })).toEqual({ tds_default_section: null, tds_default_rate_pct: null });
  });

  it("reads like the Overview's TDS field", () => {
    expect(customerTdsLabel({ section: "194C", ratePct: "1" })).toBe("194C @ 1%");
    expect(customerTdsLabel({ section: "", ratePct: "" })).toBeNull();
  });
});
