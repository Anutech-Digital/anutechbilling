import { describe, it, expect } from "vitest";
import { mockGstinVerification } from "./mock-gstin";

describe("R-526 — GSTIN mock lookup follows the GSTIN's state", () => {
  it("a Delhi GSTIN (07…) gets a Delhi address, not Mumbai", () => {
    const v = mockGstinVerification("07AAACA1234B1Z5");
    expect(v.state_code).toBe("07");
    expect(v.principal_address?.city).toBe("New Delhi");
    expect(v.principal_address?.pin_code).toBe("110001");
    expect(v.principal_address?.state).toBe("Delhi");
    expect(v.address).not.toMatch(/Mumbai/);
  });
  it("Maharashtra still gets Mumbai", () => {
    expect(mockGstinVerification("27AAACA1234B1Z5").principal_address?.city).toBe("Mumbai");
  });
  it("a state outside the short list gets its name and no PIN — never another state's PIN", () => {
    const v = mockGstinVerification("18AAACA1234B1Z5"); // Assam
    expect(v.principal_address?.pin_code).toBeNull();
    expect(v.principal_address?.city).toBe(v.principal_address?.state);
    expect(v.source).toBe("mock");
  });
});
