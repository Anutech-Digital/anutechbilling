import { describe, it, expect } from "vitest";
import { leadQuoteHref } from "./lead-quote-href";

describe("R-389 (F5): no personal data in the quote link", () => {
  it("carries only leadId, plan and seats", () => {
    const href = leadQuoteHref({ id: "L-1", plan: "Google Workspace Standard", seats: 25 });
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/quotes/new");
    expect([...url.searchParams.keys()].sort()).toEqual(["leadId", "plan", "seats"]);
    expect(url.searchParams.get("leadId")).toBe("L-1");
  });
  it("never includes email, phone, contact or company", () => {
    const lead = { id: "L-2", plan: null, seats: null, contact_email: "a@b.in", contact_phone: "9876543210", company: "Kapoor" };
    const href = leadQuoteHref(lead);
    expect(href).toBe("/quotes/new?leadId=L-2");
    expect(href).not.toMatch(/email|phone|contact|company|a%40b|9876/);
  });
  it("revise keeps the duplicate id", () => {
    expect(leadQuoteHref({ id: "L-3" }, { duplicate: "Q-1" })).toBe("/quotes/new?duplicate=Q-1&leadId=L-3");
  });
});
