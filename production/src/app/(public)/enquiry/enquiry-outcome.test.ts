/**
 * R-456 — the /enquiry thank-you text follows the real email result, and the optional
 * State field stores a real state.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enquiryThanksText, enquiryStateName, ENQUIRY_STATES } from "./enquiry-outcome";

describe("enquiryThanksText", () => {
  it("promises an inbox copy only when it was sent", () => {
    expect(enquiryThanksText("Acme", true)).toMatch(/confirmation is on its way to your inbox/);
    const failed = enquiryThanksText("Acme", false);
    expect(failed).not.toMatch(/inbox/);
    expect(failed).toMatch(/could not email you a copy/);
    expect(failed).toMatch(/no need to send it again/);
    expect(failed).toMatch(/someone from Acme will get back to you/);
  });
});

describe("enquiry State field", () => {
  it("lists real states A-Z, not the GST 97/99 codes", () => {
    expect(ENQUIRY_STATES.find((s) => s.code === "07")?.name).toBe("Delhi");
    expect(ENQUIRY_STATES.some((s) => s.code === "97" || s.code === "99")).toBe(false);
    const names = ENQUIRY_STATES.map((s) => s.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
  it("maps a code to a name; blank or unknown is null", () => {
    expect(enquiryStateName("27")).toBe("Maharashtra");
    expect(enquiryStateName("")).toBeNull();
    expect(enquiryStateName(undefined)).toBeNull();
    expect(enquiryStateName("97")).toBeNull();
  });
});

describe("wiring", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const client = strip(readFileSync(join(__dirname, "enquiry-client.tsx"), "utf8"));
  const route = strip(readFileSync(join(__dirname, "..", "..", "api", "public", "enquiry", "general", "route.ts"), "utf8"));
  it("the form reads ackSent from the server and the fixed promise is gone", () => {
    expect(client).toMatch(/setAckSent\(json\.ackSent === true\)/);
    expect(client).toMatch(/enquiryThanksText\(brandName, ackSent\)/);
    expect(client).not.toMatch(/A confirmation is on its way/);
  });
  it("the form sends stateCode and the route saves state + state_code on the lead", () => {
    expect(client).toMatch(/register\("stateCode"\)/);
    expect(route).toMatch(/state:\s+stateName/);
    expect(route).toMatch(/state_code:/);
  });
});
