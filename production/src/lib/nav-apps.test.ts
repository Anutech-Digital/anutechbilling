/**
 * R-088 — the sidebar app switcher is a VIEW over APP_NAV. It must not lose a page, must
 * not show a page the role cannot open, and must keep each app short.
 */
import { describe, it, expect } from "vitest";
import { appLabelForHref } from "./nav-apps";

import { APP_NAV, allowedRoutesForRole, type UserRole } from "./nav";
import { USER_ROLES } from "./auth/roles";
import {
  FLAT_MENU_MAX_ROWS, NAV_APPS, PINNED_ITEM_IDS,
  appForPath, buildSidebarApps, paletteHrefs, sidebarHrefs,
  DISTRIBUTOR_ONLY_ITEM_IDS, withoutDistributorOnly,
} from "./nav-apps";

const sorted = (a: string[]) => [...new Set(a)].sort();
const rowIds = (m: ReturnType<typeof buildSidebarApps>) => m.apps.flatMap((a) => a.items.map((i) => i.id));

describe("structure", () => {
  const topIds = APP_NAV.flatMap((s) => s.items.map((i) => i.id));

  it("puts every top-level nav row in exactly one app (or pinned)", () => {
    const placed = [...PINNED_ITEM_IDS, ...NAV_APPS.flatMap((a) => a.itemIds)];
    expect(sorted(placed)).toEqual(sorted(topIds));
    expect(placed.length).toBe(new Set(placed).size);
  });

  it("names only ids that exist (a typo would silently drop a row)", () => {
    for (const a of NAV_APPS) for (const id of a.itemIds) expect(topIds).toContain(id);
  });

  it("keeps every app at 12 rows or fewer for the owner", () => {
    const owner = buildSidebarApps("owner");
    for (const a of owner.apps) expect(a.items.length, a.label).toBeLessThanOrEqual(12);
    expect(owner.apps.map((a) => a.label)).toEqual(["Sales", "Billing", "Accounts", "Delivery", "Team", "Settings"]);
  });

  it("uses short plain-English labels and unique ids", () => {
    expect(new Set(NAV_APPS.map((a) => a.id)).size).toBe(NAV_APPS.length);
    for (const a of NAV_APPS) expect(a.label).toMatch(/^[A-Z][a-z]+$/);
  });
});

describe.each(USER_ROLES.map((r) => [r as UserRole]))("role %s", (role) => {
  const model = buildSidebarApps(role);

  it("reaches through the sidebar exactly the pages the route guard allows", () => {
    expect(sorted(sidebarHrefs(model))).toEqual(sorted(allowedRoutesForRole(role)));
  });

  it("finds every allowed page in Ctrl+K", () => {
    expect(sorted(paletteHrefs(role))).toEqual(sorted(allowedRoutesForRole(role)));
  });

  it("shows no empty app", () => {
    for (const a of model.apps) expect(a.items.length).toBeGreaterThan(0);
  });

  it("skips the switcher only for a short menu", () => {
    const rows = rowIds(model).length;
    expect(model.flat).toBe(model.apps.length <= 1 || rows <= FLAT_MENU_MAX_ROWS);
  });
});

describe("what each role sees", () => {
  it("owner: Today + Dashboard pinned, six apps behind a switcher", () => {
    const m = buildSidebarApps("owner");
    expect(m.pinned.map((i) => i.id)).toEqual(["today", "dashboard", "ai-entry"]);
    expect(m.flat).toBe(false);
    expect(m.apps).toHaveLength(6);
  });

  it("accountant: books + purchases + sales read-only, no pipeline, marketing or delivery rows (R-255)", () => {
    const m = buildSidebarApps("accountant");
    const ids = rowIds(m);
    expect(ids).toEqual(expect.arrayContaining(["acc-overview", "ledger", "reports", "vendors", "bills", "bill-payments", "expenses", "customers", "invoices", "payments"]));
    for (const id of ["leads", "deals", "quotes", "whatsapp", "support", "team", "marketing-hub", "settings", "purchase-orders"]) expect(ids).not.toContain(id);
    /* 16 rows since R-255 — past FLAT_MENU_MAX_ROWS, so the accountant gets the app switcher. */
    expect(m.flat).toBe(false);
  });

  it("sales and sales_senior: their own pipeline, no money or books rows", () => {
    for (const role of ["sales", "sales_senior"] as const) {
      const m = buildSidebarApps(role);
      const ids = rowIds(m);
      expect(ids).toEqual(expect.arrayContaining(["leads", "deals", "enquiries", "tasks", "quotes"]));
      for (const id of ["invoices", "payments", "acc-overview", "reports", "settings", "dashboard"]) {
        expect([...ids, ...m.pinned.map((i) => i.id)]).not.toContain(id);
      }
      expect(m.flat).toBe(true);
    }
  });

  it("partner agent: Partners and Help only", () => {
    expect(rowIds(buildSidebarApps("partner_agent")).sort()).toEqual(["help", "partners"]);
  });
});

describe("appForPath", () => {
  const owner = buildSidebarApps("owner");

  it("finds the app of a row, a child and a directory page", () => {
    expect(appForPath(owner, "/leads")).toBe("sales");
    expect(appForPath(owner, "/customers/groups")).toBe("sales");
    expect(appForPath(owner, "/accounting/pnl")).toBe("accounts");
    expect(appForPath(owner, "/marketing/spend")).toBe("sales");
    expect(appForPath(owner, "/settings/backup")).toBe("settings");
  });

  it("walks up for detail pages", () => {
    expect(appForPath(owner, "/invoices/abc-123")).toBe("billing");
    expect(appForPath(owner, "/customers/abc/edit")).toBe("sales");
  });

  it("returns null for pinned and unknown pages (the sidebar keeps the current app)", () => {
    expect(appForPath(owner, "/dashboard")).toBeNull();
    expect(appForPath(owner, "/platform")).toBeNull();
  });
});

describe("appLabelForHref (Ctrl+K labels match the sidebar)", () => {
  const model = buildSidebarApps("owner");
  it("names the app that holds a page", () => {
    expect(appLabelForHref(model, "/invoices")).toBe("Billing");
    expect(appLabelForHref(model, "/accounting/pnl")).toBe("Accounts");
    expect(appLabelForHref(model, "/leads")).toBe("Sales");
  });
  it("Today and Dashboard are Home", () => {
    expect(appLabelForHref(model, "/dashboard")).toBe("Home");
  });
  it("null for a page outside every app", () => {
    expect(appLabelForHref(model, "/no-such-page")).toBeNull();
  });
});

/* R-472: Partners is a dead end for a plain reseller — the menu row shows only to a
   distributor (and to partner_agent, whose home page it is). */
describe("distributor-only rows", () => {
  const ids = (m: ReturnType<typeof buildSidebarApps>) => m.apps.flatMap((a) => a.items.map((i) => i.id));
  it("hides Partners from a reseller owner, and while the tier is still loading", () => {
    const owner = buildSidebarApps("owner");
    expect(ids(owner)).toContain("partners");
    expect(ids(withoutDistributorOnly(owner, "owner", false))).not.toContain("partners");
    expect(ids(withoutDistributorOnly(owner, "owner", undefined))).not.toContain("partners");
    expect(ids(withoutDistributorOnly(owner, "owner", false))).toContain("referrals");
  });
  it("keeps Partners for a distributor and for partner_agent", () => {
    expect(ids(withoutDistributorOnly(buildSidebarApps("owner"), "owner", true))).toContain("partners");
    expect(ids(withoutDistributorOnly(buildSidebarApps("partner_agent"), "partner_agent", false))).toContain("partners");
  });
  it("lists only real nav ids", () => {
    const all = new Set(APP_NAV.flatMap((s) => s.items.map((i) => i.id)));
    for (const id of DISTRIBUTOR_ONLY_ITEM_IDS) expect(all.has(id)).toBe(true);
  });
});
