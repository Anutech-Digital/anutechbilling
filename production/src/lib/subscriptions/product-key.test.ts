import { describe, expect, it } from "vitest";
import { productKey } from "./product-key";

describe("productKey (R-1763)", () => {
  it("Zoho's old and new item names of one product are one key", () => {
    expect(productKey("Google Workspace - Business Starter ( Email Solutions )"))
      .toBe(productKey("Google Workspace Business Starter - User License (Resale)"));
    expect(productKey("Microsoft 365 Business Basic ( Email Solutions )"))
      .toBe(productKey("Microsoft 365 Business Basic - User License (Resale)"));
    expect(productKey("Google Workspace Starter")).toBe("google|starter|");
  });
  it("editions and the Teams variant stay apart", () => {
    const keys = [
      "Microsoft 365 Business Basic", "Microsoft 365 Business Basic (without Teams)", "Microsoft 365 Business Basic with Teams",
      "Microsoft 365 Business Standard", "Microsoft 365 Business Premium", "Office 365 E3",
      "Google Workspace Business Starter", "Google Workspace Business Standard", "Google Workspace Business Plus",
      "Google Workspace Enterprise Standard", "Google Workspace Enterprise Plus",
    ].map(productKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("unknown products fall back to their words without the selling words", () => {
    expect(productKey("T-Backup Pro - User License (Resale)")).toBe(productKey("T-Backup Pro"));
    expect(productKey("T-Backup Pro")).not.toBe(productKey("T-Backup Lite"));
    expect(productKey("")).toBe("");
  });
});
