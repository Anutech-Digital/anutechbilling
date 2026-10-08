import { describe, it, expect, vi } from "vitest";
import { normalizeUdyam, udyamInputOk, udyamPdfLine, isMissingUdyamColumn, readTenantUdyam } from "./udyam";

describe("Udyam number (R-368)", () => {
  it("normalises: trim + upper-case, empty → null", () => {
    expect(normalizeUdyam("  udyam-dl-01-0012345 ")).toBe("UDYAM-DL-01-0012345");
    expect(normalizeUdyam("   ")).toBeNull();
    expect(normalizeUdyam(null)).toBeNull();
  });
  it("input: empty or the right format only", () => {
    expect(udyamInputOk("")).toBe(true);
    expect(udyamInputOk("UDYAM-DL-01-0012345")).toBe(true);
    expect(udyamInputOk("UDYAM-12345")).toBe(false);
  });
  it("PDF line only when set and valid", () => {
    expect(udyamPdfLine("udyam-hr-05-0001234")).toBe("MSME Udyam: UDYAM-HR-05-0001234");
    expect(udyamPdfLine(null)).toBeNull();
    expect(udyamPdfLine("junk")).toBeNull();
  });
  it("missing column is recognised", () => {
    expect(isMissingUdyamColumn({ code: "42703", message: "column tenants.udyam_number does not exist" })).toBe(true);
    expect(isMissingUdyamColumn({ code: "XX", message: "boom" })).toBe(false);
    expect(isMissingUdyamColumn(null)).toBe(false);
  });
  it("read never throws: value, missing column and a thrown client all handled", async () => {
    const client = (result: unknown) => ({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn(async () => result) }) }) }),
    }) as never;
    expect(await readTenantUdyam(client({ data: { udyam_number: "UDYAM-DL-01-0012345" }, error: null }), "t")).toBe("UDYAM-DL-01-0012345");
    expect(await readTenantUdyam(client({ data: null, error: { code: "42703", message: "does not exist" } }), "t")).toBeNull();
    const throwing = { from: () => { throw new Error("network"); } } as never;
    expect(await readTenantUdyam(throwing, "t")).toBeNull();
  });
});
