import { describe, it, expect } from "vitest";
import { buyWorkspaceHref, parseBuyParams, tierForEdition } from "./buy-link";

describe("buy link (R-120)", () => {
  it("maps Google editions and leaves M365 / Zoho without an online buy", () => {
    expect(tierForEdition("GW Business Standard")).toBe("standard");
    expect(buyWorkspaceHref("GW Business Plus", 12)).toBe("/buy/workspace?tier=plus&seats=12&buy=1");
    expect(buyWorkspaceHref("M365 Business Basic", 5)).toBeNull();
    expect(buyWorkspaceHref("Zoho Workplace", 5)).toBeNull();
  });
  it("clamps seats", () => {
    expect(buyWorkspaceHref("GW Business Starter", 0)).toContain("seats=1&");
    expect(buyWorkspaceHref("GW Business Starter", 999)).toContain("seats=300&");
  });
  it("parses back, rejecting anything unexpected", () => {
    expect(parseBuyParams({ tier: "standard", seats: "12", buy: "1" })).toEqual({ tier: "standard", seats: 12, openBuy: true, coupon: null });
    expect(parseBuyParams({ tier: "enterprise", seats: "abc", buy: "1" })).toEqual({ tier: null, seats: null, openBuy: false, coupon: null });
    expect(parseBuyParams({ seats: "5000" }).seats).toBe(300);
  });
});
