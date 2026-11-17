import { describe, expect, it } from "vitest";
import { businessBrief, profileBrief } from "./social-page-brief";

describe("17 Nov 2026 — the AI learns the business from the Facebook Page", () => {
  it("turns the Page's about, services, products and recent posts into one text", () => {
    const text = profileBrief(
      { name: "Test Cloud Co", category: "IT Services", about: "Google Workspace partner", products: "Workspace, Microsoft 365, domains", website: "https://example.invalid" },
      ["Move your team email to Workspace in a day", "", "5 tips for safer passwords"],
    );
    expect(text).toContain("Page: Test Cloud Co");
    expect(text).toContain("Services and products: Workspace, Microsoft 365, domains");
    expect(text).toContain("- Move your team email to Workspace in a day");
    expect(text).toContain("- 5 tips for safer passwords");
  });

  it("a Page that says nothing gives an empty text", () => {
    expect(profileBrief(null, [])).toBe("");
    expect(profileBrief({ about: "   " })).toBe("");
  });

  it("the owner's box is optional: Page only, owner + Page, or a safe default", () => {
    expect(businessBrief("", "About: Workspace partner")).toBe("About: Workspace partner");
    expect(businessBrief("Push schools offer", "About: Workspace partner")).toBe("Push schools offer\n\nFrom the Facebook Page:\nAbout: Workspace partner");
    expect(businessBrief("Push schools offer", "")).toBe("Push schools offer");
    expect(businessBrief("  ", "")).toMatch(/cloud services reseller/);
  });

  it("long Page text is cut so the AI prompt stays small", () => {
    const text = profileBrief({ description: "x".repeat(5000) }, Array(20).fill("y".repeat(500)));
    expect(text.length).toBeLessThan(2600);
  });
});
