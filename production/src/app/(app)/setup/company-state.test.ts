import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isValidGstin } from "@/lib/utils";
import {
  GST_STATE_OPTIONS,
  initialStateCode,
  normalizeStateCode,
  resolveCompanyState,
} from "./company-state";

const DELHI_GSTIN = "07ABDCA0298H1ZP";

describe("R-250 company state", () => {
  it("test GSTIN is checksum-valid (fixture sanity)", () => {
    expect(isValidGstin(DELHI_GSTIN)).toBe(true);
  });

  it("no state chosen and no GSTIN → nothing to save (Continue blocked)", () => {
    expect(resolveCompanyState("", "")).toBeNull();
    expect(resolveCompanyState(null, null)).toBeNull();
  });

  it("a chosen state is saved as a 2-digit code", () => {
    expect(resolveCompanyState("06", "")).toEqual({ code: "06", name: "Haryana" });
    expect(resolveCompanyState("7", "")).toEqual({ code: "07", name: "Delhi" });
  });

  it("no choice but a valid GSTIN → state derived from GSTIN", () => {
    expect(resolveCompanyState("", DELHI_GSTIN)).toEqual({ code: "07", name: "Delhi" });
  });

  it("an invalid GSTIN does not decide the state", () => {
    expect(resolveCompanyState("", "07ABDCA0298H1ZX")).toBeNull();
  });

  it("unknown codes are rejected", () => {
    expect(normalizeStateCode("25")).toBeNull();
    expect(normalizeStateCode("abc")).toBeNull();
    expect(normalizeStateCode("123")).toBeNull();
  });

  it("initial value: saved code, else saved name, else empty — never a default", () => {
    expect(initialStateCode("Delhi", "7")).toBe("07");
    expect(initialStateCode("Haryana", null)).toBe("06");
    expect(initialStateCode("Hariyana", null)).toBe("");
    expect(initialStateCode(null, null)).toBe("");
  });

  it("every option is a 2-digit code", () => {
    expect(GST_STATE_OPTIONS.length).toBeGreaterThan(30);
    for (const o of GST_STATE_OPTIONS) expect(o.code).toMatch(/^\d{2}$/);
  });

  it("wizard has no Maharashtra default and gates Continue on the state", () => {
    const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(src).not.toMatch(/"Maharashtra \(27\)"/);
    expect(src).toContain("Choose your state");
    expect(src).toMatch(/resolveCompanyState\(/);
  });

  it("Settings uses the same state select, not free text", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "settings", "page.tsx"), "utf8");
    expect(src).toContain("GST_STATE_OPTIONS");
    expect(src).toContain("Choose your state");
    expect(src).not.toMatch(/\{\.\.\.register\("state"\)\}/);
  });
});
