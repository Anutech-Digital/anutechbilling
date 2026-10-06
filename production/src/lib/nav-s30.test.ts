/**
 * S30 — the nav regroup (81 rows → 7 groups) must not lose a page or change who may open
 * it. Everything here is measured against __fixtures__/nav-before-s30.json, a snapshot of
 * the OLD nav.ts taken before the edit (base 73b52146). Never regenerate that file from
 * the current nav: the test would then compare the nav with itself and pass forever.
 *
 * Three questions, each asked per role:
 *   1. REACHABLE — can this role still click its way to every page it could click to
 *      before? (sidebar row, accordion child, or a directory row on a landing page)
 *   2. GATED THE SAME — does allowedRoutesForRole(), which middleware uses to bounce
 *      requests, give exactly the same answer? A page moved into a directory must not
 *      become a page the guard redirects.
 *   3. NOTHING GAINED — no role got a page it did not have, except the ones named below
 *      (four for owner/manager, whom middleware does not gate at all; /help for everyone, S36).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import snapshot from "./__fixtures__/nav-before-s30.json";
import {
  APP_NAV, ROLE_HOME, SCREEN_TITLES, allowedRoutesForRole, isRouteAllowed, filterNavForRole, flattenNav,
  getCrumb, groupDirectory, sectionCrumb, type NavItem, type UserRole,
} from "./nav";
import { USER_ROLES } from "./auth/roles";

/**
 * Removed from the nav ON PURPOSE after S30, each with its reason. Anything else missing is
 * still a regression. The route itself still exists (it renders a notice), but for gated
 * roles the middleware now bounces it — which is the intent for a page with nothing real on it.
 *   /vendor-portal — S35, 28 Sep 2026: hardcoded demo vendor bids saved to localStorage;
 *                    replaced by a "not built yet" notice that links to Vendors / POs.
 */
const REMOVED_ON_PURPOSE = ["/vendor-portal"];
const kept = (hrefs: string[]) => hrefs.filter((h) => !REMOVED_ON_PURPOSE.includes(h));

const OLD_HREFS: string[] = kept(snapshot.hrefs);
const OLD_ALLOWED = Object.fromEntries(
  Object.entries(snapshot.allowedRoutesByRole as Record<string, string[]>).map(([r, hs]) => [r, kept(hs)]),
);
const OLD_MENU = Object.fromEntries(
  Object.entries(snapshot.menuHrefsByRole as Record<string, string[]>).map(([r, hs]) => [r, kept(hs)]),
);
const OLD_CRUMBS = snapshot.crumbs as Record<string, string[]>;

/** S28 (29 Sep 2026): the WhatsApp renewal / invoice reminders settings page, a Marketing Hub
 *  directory row for owner / manager — the same roles as every other row there. */
const ADDED_S28 = ["/marketing/whatsapp/reminders"];
/** New in S29/S30, owner/manager only. Everything else must match the snapshot exactly. */
const ADDED_FOR_OWNER_MANAGER = ["/today", "/activity", "/purchases/inbox", "/scorecard", ...ADDED_S28];
/** New in S33 (Trial Balance, Day Book) — same roles that already see P&L / Balance Sheet. */
const ADDED_FOR_BOOKS = ["/accounting/trial-balance", "/accounting/day-book"];
const BOOKS_ROLES = ["owner", "manager", "billing", "accountant"];
/** S36: Help & Tutorial opened to every role (it was owner / manager / billing / partner).
 *  Named here, not snapshotted over — the snapshot stays the pre-S30 nav. */
const ADDED_FOR_EVERY_ROLE = ["/help"];
/** S34: the IndiaMART key screen, a Marketing Hub directory row for the OWNER only — its API
 *  (/api/leads/indiamart) is owner-only, so a manager gets no row (middleware does not gate
 *  managers, and the page tells one who can do it). */
const ADDED_FOR_OWNER = ["/marketing/indiamart"];
/** 30 Sep 2026: Deals back in Sell, for the roles that see Sales & Pipeline. R-057 moved WON
 *  leads to /deals only; with no nav entry a sales user could not open /deals at all (the
 *  guard bounced it to /leads), so this is a real, named grant — not a snapshot drift. */
const ADDED_DEALS = ["/deals"];
const DEALS_ROLES = ["owner", "manager", "sales", "sales_senior"];
/** 3 Oct 2026 — "koi bhi hidden link nahi rahna chahiye" (Pardeep): pages that existed but
 *  had no menu row, plus AI Entry / Packages / UX & UI Insights. Each at the roles the page
 *  was already built for. Real route grants (not only menu rows): billing → /ai-entry and
 *  /online-orders; sales / sales_senior → /ai-entry. Everything else here was already
 *  reachable by the guard (owner/manager are ungated; /accounting/* was already BOOKS). */
const ADDED_3OCT_OM = ["/ai-entry", "/online-orders", "/items/packages", "/accounting/advances", "/accounting/reimbursements",
  "/accounting/banking/brs", "/accounting/banking/rules", "/accounting/assets", "/accounting/business-loans",
  "/accounting/profitability", "/reports/profit", "/accounting/saas-metrics", "/reports/purchases",
  "/accounting/tds-receivable/year-end", "/compliance/gst", "/compliance/income-tax", "/compliance/roc",
  "/performance", "/assessments", "/ux-insights", "/ui-insights"];
/** 4 Oct 2026 — the two catalogs (tabs on /items) get their own menu rows next to Packages
 *  (Pardeep: "subscription catalog aur product catalog bhi hone chahiye"). Same page, same
 *  owner/manager roles as /items — new addresses, not new access. */
/** …and Apprentice Academy (R-149), owner / manager in phase 1. */
const ADDED_4OCT_OM = ["/items/subscriptions", "/items/products", "/marketing/landing-pages", "/academy"];
/** R-163 (5 Oct 2026): Payment Runs, a child of Payments Made — same owner/manager/billing roles. */
const ADDED_5OCT_OMB = ["/accounting/payment-runs", "/accounting/google-bill-check"];
const ADDED_3OCT_OWNER = ["/vault/personal/banking", "/vault/personal/expenses", "/vault/personal/wealth"];
const ADDED_3OCT_BOOKS = ["/accounting/banking/brs", "/accounting/banking/rules", "/accounting/assets", "/accounting/business-loans",
  "/accounting/profitability", "/reports/purchases", "/accounting/tds-receivable/year-end", "/compliance/gst", "/compliance/income-tax", "/compliance/roc"];
const ADDED_3OCT_BILLING = ["/ai-entry", "/online-orders", "/accounting/advances", "/accounting/reimbursements"];
const ADDED_3OCT_SALES = ["/ai-entry"];
/** R-061 (6 Oct 2026): the accountant could already open these by URL (the guard admits all of
 *  /accounting/* through BOOKS) but had no menu row. A menu row only — the guard answer is unchanged. */
const ADDED_6OCT_ACCOUNTANT = ["/accounting/payroll", "/accounting/salary-register"];
/** R-263 (6 Oct 2026): Quality Score, owner / manager — a new page, next to Bug Reports. */
const ADDED_6OCT_OM = ["/quality"];
/** R-138 (3 Oct 2026): billing loses the Balance Sheet — salaries are hidden from it by RLS,
 *  so its Balance Sheet showed salary payable and statutory dues as Rs 0 (Pardeep's call). */
const REMOVED_3OCT: Record<string, string[]> = { billing: ["/accounting/balance-sheet"] };
const removedFor = (role: string) => REMOVED_3OCT[role] ?? [];
const addedFor = (role: string) => [
  ...(role === "owner" || role === "manager" ? ADDED_3OCT_OM : []),
  ...(role === "owner" || role === "manager" ? ADDED_4OCT_OM : []),
  ...(role === "owner" || role === "manager" || role === "billing" ? ADDED_5OCT_OMB : []),
  ...(role === "owner" ? ADDED_3OCT_OWNER : []),
  ...(BOOKS_ROLES.includes(role) ? ADDED_3OCT_BOOKS : []),
  ...(role === "billing" ? ADDED_3OCT_BILLING : []),
  ...(role === "sales" || role === "sales_senior" ? ADDED_3OCT_SALES : []),
  ...(role === "accountant" ? ADDED_6OCT_ACCOUNTANT : []),
  ...(role === "owner" || role === "manager" ? ADDED_6OCT_OM : []),
  ...(role === "owner" || role === "manager" ? ADDED_FOR_OWNER_MANAGER : []),
  ...(role === "owner" ? ADDED_FOR_OWNER : []),
  ...(DEALS_ROLES.includes(role) ? ADDED_DEALS : []),
  ...(BOOKS_ROLES.includes(role) ? ADDED_FOR_BOOKS : []),
  ...ADDED_FOR_EVERY_ROLE,
];

/** What a role can actually click: sidebar rows, their accordion children, and the
 *  directory rows on landing pages it can open. */
function clickable(role: UserRole): Set<string> {
  return new Set(flattenNav(filterNavForRole(APP_NAV, role)).map((e) => e.item.href));
}

/** Middleware's own test: pathname === a || pathname.startsWith(a + "/"). */
const permits = (allowed: string[], p: string) => allowed.some((a) => p === a || p.startsWith(a + "/"));

const APP_DIR = path.join(__dirname, "..", "app", "(app)");
/** Every page route on disk under (app), as a URL path ([param] segments kept). */
function pageRoutes(dir = APP_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const seg = d.name.startsWith("(") ? "" : "/" + d.name;
    const sub = path.join(dir, d.name);
    if (fs.existsSync(path.join(sub, "page.tsx"))) out.push(prefix + seg || "/");
    out.push(...pageRoutes(sub, prefix + seg));
  }
  return out;
}

describe("the snapshot is the OLD nav (guard the guard)", () => {
  it("has the 81 rows and 72 distinct hrefs the old file had", () => {
    expect(snapshot.itemCount).toBe(81);
    expect(snapshot.hrefs).toHaveLength(72);
    expect(OLD_HREFS).toHaveLength(72 - REMOVED_ON_PURPOSE.length);
    // A snapshot regenerated from the new nav would contain /today; the old one cannot.
    expect(OLD_HREFS).not.toContain("/today");
    expect(OLD_HREFS).toContain("/accounting/pnl");
  });
});

describe("1. every old href is still in the nav", () => {
  const all = new Set(flattenNav(APP_NAV).map((e) => e.item.href));
  it.each(OLD_HREFS)("%s", (href) => {
    expect(all.has(href), `${href} fell out of APP_NAV — it would be reachable only by URL`).toBe(true);
  });

  it("adds the three orphans the old nav never linked", () => {
    for (const h of ["/activity", "/purchases/inbox", "/scorecard"]) expect(all).toContain(h);
  });
});

describe.each(USER_ROLES.map((r) => [r]))("role %s", (role) => {
  const r = role as UserRole;

  it("can still click to every page it could before", () => {
    const now = clickable(r);
    const lost = OLD_MENU[r].filter((h) => !now.has(h) && !removedFor(r).includes(h));
    expect(lost, `${r} lost: ${lost.join(", ")}`).toEqual([]);
  });

  it("gained no page, except the named owner/manager additions", () => {
    const before = new Set([...OLD_MENU[r], ...addedFor(r)]);
    const gained = [...clickable(r)].filter((h) => !before.has(h));
    expect(gained, `${r} gained: ${gained.join(", ")}`).toEqual([]);
  });

  it("gets the same allowedRoutesForRole() as before (the middleware route guard)", () => {
    const expected = [...new Set([...OLD_ALLOWED[r], ...addedFor(r)])].filter((h) => !removedFor(r).includes(h)).sort();
    expect([...new Set(allowedRoutesForRole(r))].sort()).toEqual(expected);
  });

  it("is permitted or refused on every page route on disk exactly as before", () => {
    /* The guard is a PREFIX match, so the set test above is not the whole story: this
       asks the middleware's own question for every real route. */
    const oldAllowed = OLD_ALLOWED[r];
    const newAllowed = allowedRoutesForRole(r);
    const added = addedFor(r);
    const changed = pageRoutes().filter((p) =>
      permits(oldAllowed, p) !== permits(newAllowed, p) && !permits(added, p) && !permits(REMOVED_ON_PURPOSE, p),
    );
    expect(changed, `${r}: guard answer changed for ${changed.join(", ")}`).toEqual([]);
  });

  it("the guard refuses exactly the pages removed on purpose", () => {
    for (const h of removedFor(r)) expect(isRouteAllowed(r, h), `${r} still opens ${h}`).toBe(false);
  });

  it("can reach its own ROLE_HOME (no login loop)", () => {
    expect(permits(allowedRoutesForRole(r), ROLE_HOME[r])).toBe(true);
  });
});

describe("2. structure", () => {
  const flat = flattenNav(APP_NAV);

  it("is the seven groups, in order", () => {
    expect(APP_NAV.map((s) => s.section)).toEqual(["Home", "Sell", "Bill", "Buy", "Books", "Team", "Settings"]);
  });

  it("has ~40 sidebar rows, none of the groups over 8", () => {
    const rows = APP_NAV.reduce((n, s) => n + s.items.length, 0);
    expect(rows).toBeGreaterThanOrEqual(35);
    // 46 since R-204 (6 Oct 2026): Orders (website) left Payments Received's accordion for its own Sell row.
    expect(rows).toBeLessThanOrEqual(46);
    for (const s of APP_NAV) expect(s.items.length, s.section).toBeLessThanOrEqual(8);
  });

  it("lists every href exactly once (the old nav had 9 duplicates)", () => {
    const hrefs = flat.map((e) => e.item.href);
    const dupes = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
    expect(dupes).toEqual([]);
  });

  it("keeps ids unique across sidebar, children and directories", () => {
    const ids = flat.map((e) => e.item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts roles on every item and none on sections — so moving an item cannot change who sees it", () => {
    expect(APP_NAV.filter((s) => s.roles).map((s) => s.section)).toEqual([]);
    expect(flat.filter((e) => !e.item.roles?.length).map((e) => e.item.href)).toEqual([]);
  });

  it("never nests a row under a parent with fewer roles (it would be unreachable for the rest)", () => {
    const bad = flat
      .filter((e) => e.parent)
      .flatMap((e) => (e.item.roles ?? []).filter((r) => !(e.parent!.roles ?? []).includes(r)).map((r) => `${e.item.href} (${r}) under ${e.parent!.href}`));
    expect(bad).toEqual([]);
  });

  it("renders every directory on its landing page", () => {
    const withDir = APP_NAV.flatMap((s) => s.items).filter((i): i is NavItem & { directory: NavItem[] } => !!i.directory?.length);
    expect(withDir.map((i) => i.href).sort()).toEqual(["/marketing", "/reports"]);
    for (const i of withDir) {
      const file = path.join(APP_DIR, i.href, "page.tsx");
      const src = fs.readFileSync(file, "utf8");
      expect(src, `${i.href}/page.tsx must render <NavDirectory parentId="${i.id}" />`).toContain(`<NavDirectory parentId="${i.id}"`);
    }
  });

  it("gives every row in the tree a page that exists", () => {
    const missing = flat.map((e) => e.item.href).filter((h) => !fs.existsSync(path.join(APP_DIR, h, "page.tsx")));
    expect(missing).toEqual([]);
  });

  it("groups the Marketing Hub into five and the Reports directory by kind", () => {
    const hub = flat.find((e) => e.item.id === "marketing-hub")!.item;
    expect(groupDirectory(hub.directory!).map((g) => g.group)).toHaveLength(5);
    expect(hub.directory).toHaveLength(14 + ADDED_S28.length + 2); // 14 at S30 + S28 reminders + the IndiaMART key screen (S34) + Ads landing pages (4 Oct 2026)

    const reports = flat.find((e) => e.item.id === "reports")!.item;
    expect(reports.directory!.map((d) => d.href)).toEqual(expect.arrayContaining([
      "/accounting/pnl", "/accounting/balance-sheet", "/accounting/cash-flow", "/accounting/gst",
      "/accounting/tds-receivable", "/accounting/itr", "/accounting/aging", "/accounting/esi-register", "/activity",
    ]));
  });

  it("prunes children by role, not just sidebar rows", () => {
    const managerTree = flattenNav(filterNavForRole(APP_NAV, "manager")).map((e) => e.item.href);
    expect(managerTree).toContain("/vault");
    expect(managerTree).not.toContain("/vault/personal");   // owner-only child
    expect(managerTree).not.toContain("/settings/backup");  // owner-only child
    const ownerTree = flattenNav(filterNavForRole(APP_NAV, "owner")).map((e) => e.item.href);
    expect(ownerTree).toEqual(expect.arrayContaining(["/vault/personal", "/settings/backup"]));
  });
});

describe("3. breadcrumbs come from the nav", () => {
  const crumbs = new Set(APP_NAV.map(sectionCrumb));

  it("never starts a crumb with a section that does not exist (\"Engage\", \"Payroll\", …)", () => {
    const bad = Object.entries(SCREEN_TITLES).filter(([, c]) => !crumbs.has(c[0])).map(([p, c]) => `${p}: ${c.join(" › ")}`);
    expect(bad).toEqual([]);
    expect(getCrumb("/whatsapp")[0]).toBe("Home");
    expect(getCrumb("/support")[0]).toBe("Home");
  });

  it("names a sidebar/accordion row [section, label] and a directory row [section, parent, label]", () => {
    expect(getCrumb("/today")).toEqual(["Home", "Today"]);
    expect(getCrumb("/customers/groups")).toEqual(["Billing", "Parent Accounts"]);
    expect(getCrumb("/accounting/pnl")).toEqual(["Books", "Reports", "P&L Report"]);
    expect(getCrumb("/marketing/spend")).toEqual(["Sell", "Marketing Hub", "Spend"]);
    expect(getCrumb("/deals")).toEqual(["Sell", "Deals"]);
  });

  it("keeps every Billing page's crumb exactly as it was (Abhishek's pages)", () => {
    for (const h of ["/customers", "/customers/groups", "/quotes", "/subscriptions", "/renewals", "/invoices", "/payments", "/projects"]) {
      expect(getCrumb(h), h).toEqual(OLD_CRUMBS[h]);
    }
    expect(getCrumb("/customers/abc/edit")).toEqual(["Billing", "Customers", "Edit"]);
    // /online-orders left Billing on 6 Oct 2026 (R-204) — see block 5 below.
  });

  it("gives sub-pages the crumb of the page they sit under", () => {
    expect(getCrumb("/reports/profit")).toEqual(["Books", "Reports", "Profit by product/service"]);
    expect(getCrumb("/accounting/tds-receivable/year-end")).toEqual(["Books", "Reports", "TDS Receivable", "Year-End"]);
    expect(getCrumb("/setup")).toEqual(["Settings", "Setup Wizard"]);
  });

  it("gives every old nav page a real crumb (not the Dashboard fallback)", () => {
    const fallback = OLD_HREFS.filter((h) => h !== "/dashboard" && getCrumb(h).at(-1) === "Dashboard");
    expect(fallback).toEqual([]);
  });
});

describe("4. Deals sits in Sell right after Sales & Pipeline (30 Sep 2026)", () => {
  const sellHrefs = (role: UserRole) =>
    (filterNavForRole(APP_NAV, role).find((s) => s.section === "Sell")?.items ?? []).map((i) => i.href);

  it.each(["owner", "manager", "sales", "sales_senior"] as UserRole[])("%s: /deals is the row after /leads, and the guard lets it through", (role) => {
    const hrefs = sellHrefs(role);
    const at = hrefs.indexOf("/leads");
    expect(at, `${role} has no /leads in Sell`).toBeGreaterThanOrEqual(0);
    expect(hrefs[at + 1]).toBe("/deals");
    expect(permits(allowedRoutesForRole(role), "/deals")).toBe(true);
  });

  it.each(["billing", "accountant", "support", "delivery", "partner_agent"] as UserRole[])("%s: no Deals row, and the guard still refuses /deals", (role) => {
    expect(sellHrefs(role)).not.toContain("/deals");
    expect(permits(allowedRoutesForRole(role), "/deals")).toBe(false);
  });

  it("is labelled Deals and shares the Sales & Pipeline roles exactly", () => {
    const sell = APP_NAV.find((s) => s.section === "Sell")!.items;
    const leads = sell.find((i) => i.href === "/leads")!;
    const deals = sell.find((i) => i.href === "/deals")!;
    expect(deals.label).toBe("Deals");
    expect(deals.roles).toEqual(leads.roles);
  });
});

describe("5. Website orders sit in Sell next to Deals/Enquiries, not under Payments Received (R-204, 6 Oct 2026)", () => {
  /* Pardeep: an online order is a sale's journey (cart, trial, DMS) — many have no money
     yet, and a paid order's money already lands in Payments Received on its own. */
  const sell = () => APP_NAV.find((s) => s.section === "Sell")!.items;

  it("is a Sell row labelled \"Orders (website)\", right after Enquiries", () => {
    const hrefs = sell().map((i) => i.href);
    expect(hrefs[hrefs.indexOf("/enquiries") + 1]).toBe("/online-orders");
    const row = sell().find((i) => i.href === "/online-orders")!;
    expect(row.id).toBe("online-orders");
    expect(row.label).toBe("Orders (website)");
    expect(row.roles).toEqual(["owner", "manager", "billing"]);
    expect(row.hint).toBe("All website orders — cart, checkout, trial");
  });

  it("is no longer anywhere in Bill (not a child of Payments Received)", () => {
    const bill = APP_NAV.find((s) => s.section === "Bill")!;
    expect(flattenNav([bill]).map((e) => e.item.href)).not.toContain("/online-orders");
  });

  it("has the crumb Sell › Orders (website)", () => {
    expect(getCrumb("/online-orders")).toEqual(["Sell", "Orders (website)"]);
  });

  it.each(["owner", "manager", "billing"] as UserRole[])("%s still sees it and the guard lets it through", (role) => {
    const sellRows = filterNavForRole(APP_NAV, role).find((s) => s.section === "Sell")?.items ?? [];
    expect(sellRows.map((i) => i.href)).toContain("/online-orders");
    expect(isRouteAllowed(role, "/online-orders")).toBe(true);
  });
});

describe("R-061: payroll — the menu and the guard give the same answer", () => {
  const SALARY_PAGES = ["/accounting/payroll", "/accounting/salary-register"];
  /* The accountant may read and write salaries in the database (role hardening, 20260930175000),
     and the guard already let them open these pages by URL. The menu must say the same. */
  it("the accountant sees Payroll and the Salary Register in the menu and may open them", () => {
    const menu = clickable("accountant");
    for (const h of SALARY_PAGES) {
      expect(menu.has(h), `${h} missing from the accountant's menu`).toBe(true);
      expect(isRouteAllowed("accountant", h), `guard refuses ${h} for the accountant`).toBe(true);
    }
  });

  it("no role has a payroll page in its menu that the guard refuses, or the other way round", () => {
    for (const r of USER_ROLES) {
      const menu = clickable(r);
      for (const h of SALARY_PAGES) {
        expect(menu.has(h), `${r}: menu says ${menu.has(h)}, guard says ${isRouteAllowed(r, h)} for ${h}`).toBe(isRouteAllowed(r, h));
      }
    }
  });
});
