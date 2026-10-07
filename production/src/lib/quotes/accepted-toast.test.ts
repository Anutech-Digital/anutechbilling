import { describe, it, expect } from "vitest";
import { acceptedToast, createdBeforeRequest } from "./accepted-toast";

describe("acceptedToast (R-379 h)", () => {
  it("existing customer matched → 'linked to <name>', not 'customer record created'", () => {
    const s = acceptedToast({ convertedNow: true, matchedExisting: true, customerName: "Test Sharma Traders" });
    expect(s).toBe("Quote accepted · linked to Test Sharma Traders · awaiting payment");
    expect(s).not.toMatch(/created/);
  });
  it("matched without a name still says linked", () => {
    expect(acceptedToast({ convertedNow: true, matchedExisting: true })).toMatch(/linked to existing customer/);
  });
  it("new customer → created; already a customer quote → plain accepted", () => {
    expect(acceptedToast({ convertedNow: true, matchedExisting: false })).toMatch(/customer record created/);
    expect(acceptedToast({ convertedNow: false })).toBe("Quote accepted · awaiting payment");
  });
});

describe("createdBeforeRequest", () => {
  const start = Date.parse("2026-10-07T07:00:00Z");
  it("a customer from yesterday existed before; one stamped in this request did not", () => {
    expect(createdBeforeRequest("2026-10-06T07:00:00Z", start)).toBe(true);
    expect(createdBeforeRequest("2026-10-07T07:00:00.300Z", start)).toBe(false);
    expect(createdBeforeRequest("2026-10-07T06:59:59.500Z", start)).toBe(false); // clock skew
  });
  it("unknown → false", () => {
    expect(createdBeforeRequest(null, start)).toBe(false);
    expect(createdBeforeRequest("nonsense", start)).toBe(false);
  });
});
