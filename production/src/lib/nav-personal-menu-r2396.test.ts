/**
 * R-2396 (G-PERSONAL) — a personal login's menu has only personal pages: Money, My digital
 * assets, Support and "Upgrade to business". No GST, CRM, billing, accounting or settings row,
 * and none of those pages opens for it by URL (nav-route-guard.test.ts walks every page).
 */
import { describe, expect, it } from "vitest";
import { APP_NAV, filterNavForRole, flattenNav, isRouteAllowed } from "./nav";

const personalRows = () => filterNavForRole(APP_NAV, "personal").flatMap((s) => s.items);

describe("R-2396 personal menu", () => {
  it("only personal rows, ending with Upgrade to business", () => {
    expect(personalRows().map((i) => i.label)).toEqual(["Money", "My digital assets", "Support", "Upgrade to business"]);
  });

  it("no business word anywhere in the menu", () => {
    const text = personalRows().map((i) => `${i.label} ${i.href}`).join(" | ");
    expect(text).not.toMatch(/GST|CRM|lead|invoice|quote|customer|subscription|accounting|compliance|settings|team/i);
  });

  it("no business page opens for a personal login", () => {
    for (const p of ["/dashboard", "/invoices", "/quotes", "/customers", "/leads", "/accounting", "/compliance", "/settings", "/vault"]) {
      expect(isRouteAllowed("personal", p), p).toBe(false);
    }
    for (const p of ["/money", "/vault/personal", "/assets", "/support/my", "/upgrade"]) {
      expect(isRouteAllowed("personal", p), p).toBe(true);
    }
  });

  it("the business owner's menu does not get the personal rows", () => {
    const owner = flattenNav(filterNavForRole(APP_NAV, "owner")).map((i) => i.href);
    expect(owner).not.toContain("/upgrade");
    expect(owner).not.toContain("/money");
  });
});
