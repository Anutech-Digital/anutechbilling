/**
 * Sidebar "apps" — R-088 (1 Oct 2026).
 *
 * WHY: APP_NAV has ~44 sidebar rows for an owner (plus accordion and directory rows),
 * shown as seven accordion groups. A new user opening the app saw a long wall and got
 * lost. Now the sidebar shows a small app switcher (Sales · Billing · Accounts ·
 * Delivery · Team · Settings) and ONLY the chosen app's rows — 5 to 10 each — with
 * Today and Dashboard pinned above it.
 *
 * WHAT DID NOT CHANGE: APP_NAV, its roles, breadcrumbs and allowedRoutesForRole() (the
 * middleware route guard). An app is a VIEW over APP_NAV's top-level rows, picked by id,
 * so moving a row between apps cannot change who may open it. The command palette
 * (Ctrl+K) still lists every page the role is allowed — nav-apps.test.ts checks that
 * the apps together hold exactly the same pages as the role's filtered nav.
 *
 * Small menus stay flat: a role that sees few rows (sales, accountant, support…) gets
 * every row at once, under app headings, with no switcher — a switcher for nine links
 * is one more thing to learn.
 *
 * Plans: the tenant has no paid-plan / feature column yet (only `tier`
 * distributor|reseller), so there is nothing to gate on. When plans arrive, filter the
 * items in buildSidebarApps() — the same place roles are applied.
 */
import { APP_NAV, filterNavForRole, flattenNav, itemWithDescendants, type NavItem, type NavSection, type UserRole } from "@/lib/nav";
import { getModulesForRoute } from "@/lib/modules/registry";

export interface NavAppDef {
  id: string;
  label: string;
  icon: string;
  /** Top-level APP_NAV item ids, in display order. */
  itemIds: string[];
}

/** Always shown above the switcher, for the roles that can see them. */
export const PINNED_ITEM_IDS = ["today", "dashboard", "ai-entry"] as const;

export const NAV_APPS: NavAppDef[] = [
  {
    id: "sales", label: "Sales", icon: "target",
    itemIds: ["leads", "deals", "enquiries", "online-orders", "tasks", "quotes", "customers", "items", "marketing-hub", "referrals", "partners"],
  },
  {
    /* Money in and money out: what the customer pays, what we pay vendors. */
    id: "billing", label: "Billing", icon: "rupee",
    itemIds: ["subscriptions", "renewals", "invoices", "payments", "purchase-inbox", "purchase-orders", "vendors", "bills", "bill-payments", "expenses"],
  },
  {
    id: "accounts", label: "Accounts", icon: "chart",
    itemIds: ["acc-overview", "banking", "ledger", "acc-close", "reports", "compliance-calendar"],
  },
  {
    /* The queues of turning a sale into a working service. */
    id: "delivery", label: "Delivery", icon: "package",
    itemIds: ["whatsapp", "support", "provisioning", "projects", "hosting-domains"],
  },
  {
    id: "team", label: "Team", icon: "users",
    itemIds: ["my-attendance", "my-expenses", "employees", "attendance-reg", "payroll", "team"],
  },
  {
    id: "settings", label: "Settings", icon: "settings",
    itemIds: ["settings", "automation", "vault", "documents", "help"],
  },
];

/** At or under this many sidebar rows, show every app at once (no switcher). */
export const FLAT_MENU_MAX_ROWS = 12;

export interface SidebarApp {
  id: string;
  label: string;
  icon: string;
  items: NavItem[];
}

export interface SidebarModel {
  pinned: NavItem[];
  apps: SidebarApp[];
  /** True when the role sees few enough rows that the switcher is skipped. */
  flat: boolean;
}

/**
 * The sidebar for a role: pinned rows + the apps that have at least one row it can see.
 * Rows (and their children / directory rows) are already pruned by filterNavForRole.
 */
export function buildSidebarApps(
  role: UserRole | undefined,
  nav: NavSection[] = APP_NAV,
  apps: NavAppDef[] = NAV_APPS,
): SidebarModel {
  const visible = new Map<string, NavItem>();
  for (const s of filterNavForRole(nav, role)) for (const i of s.items) visible.set(i.id, i);

  const pick = (ids: readonly string[]) =>
    ids.map((id) => visible.get(id)).filter((i): i is NavItem => !!i);

  const pinned = pick(PINNED_ITEM_IDS);
  const out = apps
    .map((a) => ({ id: a.id, label: a.label, icon: a.icon, items: pick(a.itemIds) }))
    .filter((a) => a.items.length > 0);
  const rows = out.reduce((n, a) => n + a.items.length, 0);
  return { pinned, apps: out, flat: out.length <= 1 || rows <= FLAT_MENU_MAX_ROWS };
}

/** Every page reachable from the sidebar model — rows, accordion children, directory rows. */
export function sidebarHrefs(model: SidebarModel): string[] {
  return [...model.pinned, ...model.apps.flatMap((a) => a.items)]
    .flatMap(itemWithDescendants)
    .map((i) => i.href);
}

/**
 * Which app holds this page — exact match on any row/child/directory href first, then the
 * nearest parent path (/customers/<id>/edit → /customers → Sales). null for pinned pages
 * and pages outside the nav; the sidebar then keeps whatever app was showing.
 */
export function appForPath(model: SidebarModel, pathname: string): string | null {
  const cleanPath = pathname.split("?")[0];
  const byHref = new Map<string, string>();
  for (const a of model.apps) {
    for (const it of a.items) {
      for (const d of itemWithDescendants(it)) {
        const cleanHref = d.href.split("?")[0];
        if (!byHref.has(cleanHref)) {
          byHref.set(cleanHref, a.id);
        }
      }
    }
  }
  if (byHref.has(cleanPath)) return byHref.get(cleanPath)!;
  const segs = cleanPath.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 1; i--) {
    const hit = byHref.get("/" + segs.slice(0, i).join("/"));
    if (hit) return hit;
  }
  return null;
}

/**
 * The name the command palette shows under a page: the sidebar app that holds it
 * ("Billing", "Accounts"…), or "Home" for Today/Dashboard — so Ctrl+K and the sidebar
 * use the same words. null when the page is in no app (the palette then falls back to
 * the old section name).
 */
export function appLabelForHref(model: SidebarModel, href: string): string | null {
  if (model.pinned.some((p) => itemWithDescendants(p).some((d) => d.href === href))) return "Home";
  const id = appForPath(model, href);
  return id ? model.apps.find((a) => a.id === id)?.label ?? null : null;
}

/** The pages the command palette lists for a role (same source as the route guard). */
export function paletteHrefs(role: UserRole | undefined, nav: NavSection[] = APP_NAV): string[] {
  return [...new Set(flattenNav(filterNavForRole(nav, role)).map((e) => e.item.href))];
}

/**
 * R-472 — rows that only mean something to a DISTRIBUTOR (a tenant with sub-resellers).
 * Partners showed every ordinary reseller a dead end ("a distributor feature … currently a
 * DB-only setting") in the Sales menu. The route stays open (a link or bookmark still lands
 * on a page that explains and points to Referrals); only the menu row is hidden.
 */
export const DISTRIBUTOR_ONLY_ITEM_IDS: readonly string[] = ["partners"];

/**
 * Drop distributor-only rows unless the tenant is a distributor. `isDistributor` undefined
 * (still loading) hides them too, so the row never flashes in and out. A partner_agent keeps
 * Partners: it is that role's home page (ROLE_HOME) and almost its only row.
 */
export function withoutDistributorOnly(
  model: SidebarModel,
  role: UserRole | undefined,
  isDistributor: boolean | undefined,
): SidebarModel {
  if (isDistributor === true || role === "partner_agent") return model;
  const keep = (i: NavItem) => !DISTRIBUTOR_ONLY_ITEM_IDS.includes(i.id);
  const apps = model.apps
    .map((a) => ({ ...a, items: a.items.filter(keep) }))
    .filter((a) => a.items.length > 0);
  const rows = apps.reduce((n, a) => n + a.items.length, 0);
  return { pinned: model.pinned.filter(keep), apps, flat: apps.length <= 1 || rows <= FLAT_MENU_MAX_ROWS };
}

export const SALARIED_PRO_CHILDREN: NavItem[] = [
  {
    id: "sp-budget",
    href: "/employee-hub?tab=budget",
    label: "Budget & Overview",
    icon: "pie_chart",
    hint: "Monthly spending limit, 50-30-20 rule & category caps",
  },
  {
    id: "sp-expenses",
    href: "/employee-hub?tab=expenses",
    label: "Income & Expenses Ledger",
    icon: "tag",
    hint: "Record manual salary credits & daily UPI spends",
  },
  {
    id: "sp-banks",
    href: "/employee-hub?tab=banks",
    label: "Bank Accounts & Statement Import",
    icon: "building",
    hint: "HDFC, SBI, ICICI accounts with 1-click statement CSV parser",
  },
  {
    id: "sp-vault",
    href: "/employee-hub?tab=vault",
    label: "Digital Document Vault",
    icon: "file",
    hint: "Form 16, Payslips, AIS/26AS, Rent Agreements & Tax Proofs",
  },
  {
    id: "sp-tax",
    href: "/employee-hub?tab=tax",
    label: "ITR-1 Tax Assistant",
    icon: "rupee",
    hint: "Old vs New Regime comparison, 87A rebate & ITR-1 Sahaj JSON",
  },
];

export const EMPLOYEE_HUB_ITEM: NavItem = {
  id: "employee-hub",
  href: "/employee-hub",
  label: "Salaried Pro Hub",
  icon: "award",
  hint: "Budget & spending limit, income & daily expenses ledger, bank accounts & statement import, vault & ITR assistant",
  children: SALARIED_PRO_CHILDREN,
};

/**
 * Filter the sidebar apps model based on the tenant's active modules.
 * If activeModuleIds is omitted/undefined, the model is returned as-is (e.g. for SSR / unit tests).
 *
 * Rules:
 * 1. Routes with 0 matching modules in registry (e.g. /dashboard, /today, /settings) are core platform routes and always allowed.
 * 2. Routes with matching modules require at least one of those modules to be in activeModuleIds.
 * 3. Items with children are pruned: children are filtered, and parent is kept if parent is allowed OR has active children.
 * 4. If salaried_pro is active, injects "Salaried Pro Hub" (/employee-hub) with rich sub-tools.
 *    If teamops is not active (individual mode), re-labels the app from "Team" to "Salaried Pro" with icon "award" and places it first.
 * 5. Apps with 0 remaining items are removed.
 * 6. Flat menu layout (model.flat = true) is automatically enabled when remaining apps <= 1 or total rows <= FLAT_MENU_MAX_ROWS.
 */
export function filterSidebarModelForModules(
  model: SidebarModel,
  activeModuleIds?: string[],
): SidebarModel {
  if (!activeModuleIds) return model;

  const isRouteAllowed = (href: string) => {
    // Match base route before query params
    const baseHref = href.split("?")[0];
    const modules = getModulesForRoute(baseHref);
    if (modules.length === 0) return true;
    return modules.some((m) => activeModuleIds.includes(m.id));
  };

  const filterItem = (item: NavItem): NavItem | null => {
    let activeChildren: NavItem[] | undefined;
    if (item.children && item.children.length > 0) {
      activeChildren = item.children
        .map(filterItem)
        .filter((c): c is NavItem => c !== null);
    }

    const selfAllowed = isRouteAllowed(item.href);
    const hasActiveChildren = activeChildren && activeChildren.length > 0;

    if (!selfAllowed && !hasActiveChildren) {
      return null;
    }

    return {
      ...item,
      children: hasActiveChildren ? activeChildren : item.children,
    };
  };

  const filteredPinned = model.pinned
    .map(filterItem)
    .filter((i): i is NavItem => i !== null);

  let apps = model.apps.map((app) => {
    let items = app.items
      .map(filterItem)
      .filter((i): i is NavItem => i !== null);

    // If salaried_pro is active, ensure Employee Hub is in Team / Salaried Pro app
    if (app.id === "team" && activeModuleIds.includes("salaried_pro")) {
      const alreadyHas = items.some((i) => i.id === "employee-hub" || i.href.startsWith("/employee-hub"));
      if (!alreadyHas) {
        items = [EMPLOYEE_HUB_ITEM, ...items];
      }

      // If user is an individual without corporate TeamOps, rebrand Team -> Salaried Pro
      if (!activeModuleIds.includes("teamops")) {
        return {
          id: "salaried-pro",
          label: "Salaried Pro",
          icon: "award",
          items,
        };
      }
    }

    return {
      ...app,
      items,
    };
  });

  // If Salaried Pro / Team app was completely pruned or wasn't present, but salaried_pro is active:
  if (activeModuleIds.includes("salaried_pro")) {
    const hasSalariedOrTeam = apps.some((a) => (a.id === "salaried-pro" || a.id === "team") && a.items.length > 0);
    if (!hasSalariedOrTeam) {
      apps.unshift({
        id: "salaried-pro",
        label: "Salaried Pro",
        icon: "award",
        items: [EMPLOYEE_HUB_ITEM],
      });
    } else if (!activeModuleIds.includes("teamops")) {
      // Bring Salaried Pro to the top position so the individual user sees it first
      const spIndex = apps.findIndex((a) => a.id === "salaried-pro");
      if (spIndex > 0) {
        const [spApp] = apps.splice(spIndex, 1);
        apps.unshift(spApp);
      }
    }
  }

  // Filter out empty apps
  const activeApps = apps.filter((a) => a.items.length > 0);
  const totalRows = activeApps.reduce((sum, a) => sum + a.items.length, 0);

  return {
    pinned: filteredPinned,
    apps: activeApps,
    flat: activeApps.length <= 1 || totalRows <= FLAT_MENU_MAX_ROWS,
  };
}
