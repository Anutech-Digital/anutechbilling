/**
 * R-1861 — "What do you sell?" hides menu rows, never blocks them.
 *
 * The answer filters ONLY the sidebar model (Sidebar + mobile drawer). The route guard
 * (allowedRoutesForRole → middleware), Ctrl+K (paletteHrefs) and homeForRole read APP_NAV
 * through filterNavForRole, which ignores the tag — so every page opens exactly as before.
 */
import { describe, expect, it } from "vitest";
import {
  APP_NAV, allowedRoutesForRole, filterNavForRole, flattenNav, homeForRole, isRouteAllowed,
  visibleForSellMode, type NavItem, type NavSection, type UserRole,
} from "./nav";
import { USER_ROLES } from "@/lib/auth/roles";
import { buildSidebarApps, forSellMode, paletteHrefs, sidebarHrefs } from "./nav-apps";

const ROLES: UserRole[] = [...USER_ROLES];

/** APP_NAV with every sellModes tag removed — "before R-1861". */
function untagged(nav: NavSection[]): NavSection[] {
  const strip = (i: NavItem): NavItem => {
    const { sellModes: _s, ...rest } = i;
    return {
      ...rest,
      ...(i.children ? { children: i.children.map(strip) } : {}),
      ...(i.directory ? { directory: i.directory.map(strip) } : {}),
    };
  };
  return nav.map((s) => ({ ...s, items: s.items.map(strip) }));
}

const SUBSCRIPTION_ROWS = ["subscriptions", "renewals", "provisioning", "saas-metrics"];

describe("sell mode tags (R-1861)", () => {
  it("only the subscription screens are tagged, for Subscriptions + Both", () => {
    const tagged = flattenNav(APP_NAV).filter((e) => e.item.sellModes).map((e) => e.item.id).sort();
    expect(tagged).toEqual([...SUBSCRIPTION_ROWS].sort());
    for (const e of flattenNav(APP_NAV).filter((x) => x.item.sellModes)) {
      expect(e.item.sellModes).toEqual(["subscriptions", "both"]);
    }
  });
});

describe("never blocks: guard, Ctrl+K and home are the same as before the tag", () => {
  it.each(ROLES)("%s: allowedRoutesForRole is unchanged", (role) => {
    const before = flattenNav(filterNavForRole(untagged(APP_NAV), role)).map((e) => e.item.href);
    expect(allowedRoutesForRole(role)).toEqual(before);
  });

  it.each(ROLES)("%s: Ctrl+K lists the same pages", (role) => {
    expect(paletteHrefs(role)).toEqual(paletteHrefs(role, untagged(APP_NAV)));
  });

  it("an owner can still open /renewals, /subscriptions and SaaS metrics by URL", () => {
    for (const href of ["/renewals", "/subscriptions", "/provisioning", "/accounting/saas-metrics"]) {
      expect(isRouteAllowed("owner", href)).toBe(true);
    }
    expect(paletteHrefs("owner")).toContain("/renewals");
    expect(isRouteAllowed("owner", homeForRole("owner"))).toBe(true);
  });
});

describe("visibleForSellMode", () => {
  const renewals = { id: "renewals", href: "/renewals", label: "Renewals", icon: "clock", sellModes: ["subscriptions", "both"] } as NavItem;
  const invoices = { id: "invoices", href: "/invoices", label: "Invoices", icon: "receipt" } as NavItem;

  it("untagged rows always show", () => {
    expect(visibleForSellMode(invoices, "one_time", {})).toBe(true);
  });
  it("tagged rows hide only for a one-time business", () => {
    expect(visibleForSellMode(renewals, "one_time", {})).toBe(false);
    expect(visibleForSellMode(renewals, "both", {})).toBe(true);
    expect(visibleForSellMode(renewals, "subscriptions", {})).toBe(true);
  });
  it("Show all modules, or data, brings them back", () => {
    expect(visibleForSellMode(renewals, "one_time", { showAll: true })).toBe(true);
    expect(visibleForSellMode(renewals, "one_time", { hasData: true })).toBe(true);
    expect(visibleForSellMode(renewals, "one_time", { hasData: false })).toBe(false);
  });
});

describe("forSellMode — the sidebar model", () => {
  const owner = buildSidebarApps("owner");
  const ids = (m: ReturnType<typeof buildSidebarApps>) =>
    [...m.pinned, ...m.apps.flatMap((a) => a.items)].map((i) => i.id);

  it("one-time, no subscriptions: Subscriptions, Renewals and Activation Queue leave the menu", () => {
    const m = forSellMode(owner, "one_time", { showAll: false, hasData: false });
    for (const id of ["subscriptions", "renewals", "provisioning"]) expect(ids(m)).not.toContain(id);
    expect(ids(m)).toContain("invoices");
    expect(ids(m)).toContain("projects");
    expect(sidebarHrefs(m)).not.toContain("/renewals");
  });

  it("Both and Subscriptions: the menu is exactly as before", () => {
    expect(forSellMode(owner, "both", {})).toEqual(owner);
    expect(forSellMode(owner, "subscriptions", {})).toEqual(owner);
  });

  it("Show all modules, or a subscription on file: everything is back", () => {
    expect(forSellMode(owner, "one_time", { showAll: true })).toEqual(owner);
    expect(forSellMode(owner, "one_time", { hasData: true })).toEqual(owner);
  });

  it("an app left empty is dropped, and the flat flag is recomputed", () => {
    const m = forSellMode(owner, "one_time", {});
    for (const a of m.apps) expect(a.items.length).toBeGreaterThan(0);
  });
});
