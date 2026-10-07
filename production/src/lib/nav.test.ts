import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getCrumb, getParentListHref, getSectionPrimaryHref, APP_NAV, allowedRoutesForRole, filterNavForRole, flattenNav, SCREEN_TITLES, sectionCrumb } from "./nav";

describe("getCrumb", () => {
  it("returns the exact crumb for a known static route", () => {
    /* "Billing", not "Sales": Customers moved to Billing & Subscriptions on
       10 Sep 2026 — a customer is a company you bill, so it sits beside the
       quotes, invoices and payments about it. Sales & CRM keeps the prospect
       half (leads, enquiries, referrals). */
    expect(getCrumb("/customers")).toEqual(["Billing", "Customers"]);
    expect(getCrumb("/quotes/new")).toEqual(["Billing", "Quotes", "New"]);
  });

  it("resolves dynamic detail routes via the [id] placeholder (not 'Dashboard')", () => {
    // The bug this fixes: exact lookup missed dynamic ids → everything fell back
    // to the Dashboard crumb. A real customer id is a uuid.
    expect(getCrumb("/customers/17e61b78-9450-4849-ad93-9834d2281647")).toEqual(["Billing", "Customers", "Profile"]);
    // Quote ids are prefixed text, not uuids.
    expect(getCrumb("/quotes/Q-ET-2026-27-0010")).toEqual(["Billing", "Quotes", "Detail"]);
    expect(getCrumb("/invoices/INV-ET-2026-27-0006")).toEqual(["Billing", "Invoices", "Detail"]);
  });

  it("resolves a mid-path id so a sub-page keeps its own crumb", () => {
    expect(getCrumb("/customers/17e61b78-9450-4849-ad93-9834d2281647/edit")).toEqual([
      "Billing",
      "Customers",
      "Edit",
    ]);
  });

  it("resolves a nested dynamic route to its known [id] parent", () => {
    // "Books" since S30 — the sidebar group Banking sits in. It said "Accounting", a
    // section that no longer exists.
    expect(getCrumb("/accounting/banking/some-account-id")).toEqual(["Books", "Banking", "Account"]);
  });

  it("falls back to the bare section path when no [id] entry exists", () => {
    // /payments has a list crumb but no /payments/[id] entry, so a detail route
    // must still land in the right section rather than on Dashboard.
    expect(getCrumb("/payments/abc123")).toEqual(["Billing", "Payments Received"]);
  });

  it("falls back to Dashboard for a completely unknown route", () => {
    // Must be the same crumb /dashboard itself maps to — no stale section names
    // (a shell-rendered route with no entry, e.g. /platform, lands here).
    expect(getCrumb("/totally-unknown-xyz")).toEqual(["Home", "Dashboard"]);
    expect(getCrumb("/dashboard")).toEqual(["Home", "Dashboard"]);
  });
});

describe("getParentListHref", () => {
  // The mobile Back button's target when there's no history to pop, i.e. the user
  // deep-linked into a detail page from WhatsApp/email. Must NEVER return null —
  // the previous code called getSectionPrimaryHref(pathname), which always did,
  // so router.push(null) dead-ended Back on exactly that (very common) path.
  it("returns the list page for a detail route", () => {
    expect(getParentListHref("/quotes/Q-ET-2026-27-0010")).toBe("/quotes");
    expect(getParentListHref("/invoices/INV-ET-2026-27-0006")).toBe("/invoices");
    expect(getParentListHref("/customers/17e61b78-9450-4849-ad93-9834d2281647")).toBe("/customers");
  });

  it("returns the nearest known ancestor, not the top-level segment", () => {
    expect(getParentListHref("/accounting/banking/some-account-id")).toBe("/accounting/banking");
  });

  it("skips a mid-path id to the real list page", () => {
    expect(getParentListHref("/customers/17e61b78-9450-4849-ad93-9834d2281647/edit")).toBe("/customers");
  });

  it("always returns something navigable", () => {
    expect(getParentListHref("/unknown-section/abc")).toBe("/dashboard");
    expect(getParentListHref("/platform")).toBe("/dashboard");
    expect(getParentListHref("/")).toBe("/dashboard");
  });
});

describe("getSectionPrimaryHref", () => {
  it("resolves a real APP_NAV section name to its first item", () => {
    expect(getSectionPrimaryHref("Home")).toBe("/today");
    expect(getSectionPrimaryHref("Sell")).toBe("/leads");
  });

  it("returns null for anything that is not a section name", () => {
    // Guards the misuse this replaced: a pathname is never a section name.
    expect(getSectionPrimaryHref("/quotes/Q-1")).toBeNull();
    // A crumb can differ from its section name (Bill's crumb is "Billing"), so crumb[0]
    // is not a valid argument either.
    expect(getSectionPrimaryHref("Billing")).toBeNull();
    expect(getSectionPrimaryHref("Year-End")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nav ↔ filesystem
//
// These exist because /marketing/reports sat in the codebase, finished and
// working, for a whole session with no way to reach it — no sidebar entry, no
// command-palette hit, no breadcrumb. Nothing failed, because nothing was
// checking. A page nobody can open is indistinguishable from a page that was
// never built, and the twelve tests above all passed the entire time.
//
// The reverse case is worse: a sidebar link pointing at a route with no page
// gives the owner a 404 from the app's own menu.
// ─────────────────────────────────────────────────────────────────────────────
describe("APP_NAV ↔ app router", () => {
  const APP_DIR = path.join(__dirname, "..", "app", "(app)");

  /** Every href in the nav tree, including accordion children and directory rows. */
  const hrefs = flattenNav(APP_NAV).map((e) => e.item.href)
    .filter((h): h is string => typeof h === "string" && h.startsWith("/"));

  it.each(hrefs)("%s has a page that actually renders", (href) => {
    // Route groups like (app) are not URL segments, so the href maps directly.
    const direct = path.join(APP_DIR, href, "page.tsx");
    if (fs.existsSync(direct)) return;

    // Fall back to a dynamic segment: /customers/groups could be [id]/groups.
    const segments = href.split("/").filter(Boolean);
    const parent = path.join(APP_DIR, ...segments.slice(0, -1));
    const dynamic = fs.existsSync(parent)
      ? fs.readdirSync(parent).some(
          (d) => d.startsWith("[") && fs.existsSync(path.join(parent, d, "page.tsx")),
        )
      : false;

    expect(
      dynamic,
      `Sidebar links to ${href} but there is no page.tsx for it — the menu leads to a 404.`,
    ).toBe(true);
  });

  it("gives every nav destination a breadcrumb", () => {
    // Without one the TopBar falls back to the Dashboard crumb, so the user is
    // told they are somewhere they are not.
    const missing = hrefs.filter((h) => {
      // /dashboard is the one route whose crumb is legitimately "Dashboard" —
      // it is the fallback AND the real answer, so it cannot be distinguished
      // by this check and is exempted rather than papered over.
      if (h === "/dashboard") return false;
      const crumb = getCrumb(h);
      return !crumb || crumb.length === 0 || crumb[crumb.length - 1] === "Dashboard";
    });
    expect(missing, `No breadcrumb for: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps nav ids unique", () => {
    // React keys and the command palette both index on id; a duplicate silently
    // drops one of the two entries.
    const ids = flattenNav(APP_NAV).map((e) => e.item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * ─── THE NAV IS ALSO THE ROUTE GUARD ────────────────────────────────────────
 * `allowedRoutesForRole` is derived from `filterNavForRole`, and middleware redirects
 * anything outside it. So a page placed in the wrong nav section is not merely hard to
 * find — it is UNREACHABLE for every role that section excludes, even by typing the URL.
 *
 * The ledger was added only to the accountant-only "Filing" section. Pardeep is an owner,
 * so the khata he asked for was invisible in his menu AND blocked by middleware, while an
 * unauthenticated probe still returned 200 (it redirects to /login) — which is exactly why
 * "the route responds" is not evidence that a signed-in user can open it.
 */
describe("a page in the wrong nav section is unreachable, not just hidden", () => {
  const ACCOUNTING_ROLES = ["owner", "manager", "billing", "accountant"] as const;

  it("lets every role that can open /accounting also open the ledger", () => {
    for (const role of ACCOUNTING_ROLES) {
      const routes = allowedRoutesForRole(role);
      if (!routes.includes("/accounting")) continue;
      expect(routes, `${role} can reach /accounting but not the ledger`)
        .toContain("/accounting/ledger");
    }
  });

  it("shows it to the OWNER specifically — the person a customer asks for a statement", () => {
    expect(allowedRoutesForRole("owner")).toContain("/accounting/ledger");
    const sections = filterNavForRole(APP_NAV, "owner");
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toContain("Ledger (Khata)");
  });

  it("keeps it for the accountant, whose main tool this is", () => {
    expect(allowedRoutesForRole("accountant")).toContain("/accounting/ledger");
  });

  it("does not hand it to a sales role that cannot see accounting at all", () => {
    /* Not a security boundary on its own — RLS is — but the menu should not offer a
       screen the middleware will bounce. */
    const sales = allowedRoutesForRole("sales");
    if (!sales.includes("/accounting")) expect(sales).not.toContain("/accounting/ledger");
  });

  /**
   * ─── "SOME ROLE" WAS TOO WEAK A RULE, AND IT LET THREE PAGES THROUGH ──────
   * This assertion used to say every /accounting/* href is reachable by SOME role. It
   * passed — because the accountant-only "Filing" section covered them — while the OWNER
   * had no menu route to GST Reports, TDS Receivable or Customer Aging. Pardeep found
   * that by looking at his own sidebar, one day after this file was supposed to have
   * guarded it.
   *
   * The owner is exempt from the middleware gate (middleware.ts:103), so those pages were
   * reachable by URL. Reachable is not findable: an owner who does not know the URL simply
   * does not have the feature — and GST Reports is a monthly statutory deadline.
   *
   * So the rule is now stated against the OWNER, who sees the most of the app and is the
   * person these screens are for.
   */
  /* S30: "the owner's own menu" now means what the owner can CLICK — a sidebar row, an
     accordion child, or a row in the Reports directory. P&L, GST, TDS and Aging moved into
     that directory; they did not leave the owner's reach, and this is what says so. */
  const ownerClickable = () => new Set(flattenNav(filterNavForRole(APP_NAV, "owner")).map((e) => e.item.href));
  const declaredAccounting = () => new Set(
    flattenNav(APP_NAV).map((e) => e.item.href).filter((h) => h.startsWith("/accounting")),
  );

  it("puts EVERY /accounting page in the owner's own menu, not merely in someone's", () => {
    const ownerHrefs = ownerClickable();
    const missing = [...declaredAccounting()].filter((h) => !ownerHrefs.has(h));
    expect(missing, `Not in the owner's menu: ${missing.join(", ")}`).toEqual([]);
  });

  it("names the three that were missing, so a revert is loud", () => {
    const ownerHrefs = ownerClickable();
    for (const href of ["/accounting/gst", "/accounting/tds-receivable", "/accounting/aging"]) {
      expect(ownerHrefs, `${href} vanished from the owner menu again`).toContain(href);
    }
  });

  it("still keeps every accounting page reachable for the roles that ARE gated", () => {
    /* Owner and manager bypass the gate; billing and accountant do not. */
    const reachable = new Set(
      ACCOUNTING_ROLES.flatMap((r) => allowedRoutesForRole(r)),
    );
    for (const href of declaredAccounting()) expect(reachable).toContain(href);
  });
});

/**
 * ─── ONE SIDEBAR SECTION, ONE BREADCRUMB NAME ───────────────────────────────
 *
 * `SCREEN_TITLES` used to describe a structure `APP_NAV` already described, and on
 * 21 Sep 2026 the two had drifted far enough to be visibly wrong. Abhishek, on the
 * subscriptions page: "why it breadcrumb showing wrong". The sidebar said Billing &
 * Subscriptions; the breadcrumb said "Revenue > Subscriptions".
 *
 * That fix declared one crumb per section and tolerated a list of "deliberate splits"
 * (Engage, Payroll, Me, Admin…). S30 removed the second copy instead: a nav page's crumb
 * is now DERIVED from the section it sits in, so a section cannot disagree with itself,
 * and there are no splits left to declare. What stays worth asserting is that the
 * derivation is actually used, and the reported bug stays fixed.
 */
describe("breadcrumbs — one sidebar section, one name", () => {
  const sections = APP_NAV.map((sec) => ({
    name: sec.section,
    crumb: sectionCrumb(sec),
    crumbsInUse: [...new Set(
      flattenNav([sec]).map((e) => SCREEN_TITLES[e.item.href]?.[0]).filter((c): c is string => !!c),
    )],
  }));

  it("has sections to check", () => {
    // A lookup that silently matched nothing would make everything below pass forever.
    expect(sections.length).toBeGreaterThan(5);
    expect(sections.some((s) => s.crumbsInUse.length > 0)).toBe(true);
  });

  it("never lets one section use two breadcrumb names", () => {
    const split = sections
      .filter((s) => s.crumbsInUse.length !== 1 || s.crumbsInUse[0] !== s.crumb)
      .map((s) => s.name + ": pages say " + s.crumbsInUse.join(" vs ") + ", section crumb is " + s.crumb);
    expect(split).toEqual([]);
  });

  it("keeps the Billing group on a single crumb — the reported bug", () => {
    const billing = sections.find((s) => s.name === "Bill")!;
    expect(billing.crumbsInUse).toEqual(["Billing"]);
    expect(billing.crumb).toBe("Billing");
  });

  it("names the Buy pages after the sidebar's Billing app, not 'Buy' (R-177)", () => {
    // Purchase Inbox … Reimbursements read "Buy ›" while the sidebar tab said Billing.
    const buy = sections.find((s) => s.name === "Buy")!;
    expect(buy.crumbsInUse).toEqual(["Billing"]);
    expect(getCrumb("/purchase-orders")).toEqual(["Billing", "Purchase Orders"]);
    expect(getCrumb("/accounting/bill-payments")[0]).toBe("Billing");
  });

  it("gives every nav page a breadcrumb", () => {
    // A page reachable from the nav with no entry falls back to a generic crumb and
    // tells the operator nothing about where they are.
    const missing = flattenNav(APP_NAV)
      .filter((e) => !SCREEN_TITLES[e.item.href])
      .map((e) => e.item.href);
    expect(missing, "These nav pages have no breadcrumb: " + missing.join(", ")).toEqual([]);
  });
});
