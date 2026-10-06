/**
 * Navigation config — single source of truth for sidebar, route guard, command palette
 * and breadcrumbs.
 *
 * Adding a new screen?
 * 1. Add an entry to APP_NAV — as a sidebar row, an accordion `children` row, or a
 *    `directory` row on its landing page (see below). Give it explicit `roles`.
 * 2. Its breadcrumb is derived from where you put it. Only a page that is NOT in APP_NAV
 *    (a detail page, a sub-page) needs an EXTRA_SCREENS entry.
 * 3. Create the page at src/app/(app)/[id]/page.tsx
 *
 * ─── S30 REGROUP, 28 Sep 2026 — WHAT CHANGED AND WHY ─────────────────────────
 * Before: 10 sections, 81 rows, 9 duplicate hrefs (P&L, Balance Sheet, Cash Flow, GST,
 * TDS, Aging and Ledger each in both "Filing" and "Accounting & Finance"; ESI & PF in
 * "Filing" and "HR & Payroll"; Advances & Expenses in "Home" and "Sales & CRM"), three
 * pages reachable only by URL (/activity, /purchases/inbox, /scorecard), and breadcrumbs
 * naming sections that did not exist ("Engage", "Payroll", "Purchases", "Compliance").
 *
 * After: 7 groups — Home, Sell, Bill, Buy, Books, Team, Settings — with 43 sidebar rows,
 * every href exactly once, and three ways for a page to be reachable:
 *   • a sidebar row;
 *   • an accordion `children` row under a sidebar row (collapsed until opened, or open
 *     when you are on it) — used where the parent's page belongs to someone else, so no
 *     page had to be edited;
 *   • a `directory` row, rendered by <NavDirectory> on the parent's landing page — the
 *     Reports directory (/reports, 9 reports) and the Marketing Hub (/marketing, 16
 *     tools in 5 groups). Both landing pages are Pardeep's.
 *
 * WHAT DID NOT CHANGE, AND IS TESTED (nav-s30.test.ts, against a snapshot of the old
 * file in __fixtures__/nav-before-s30.json):
 *   • Every one of the 72 old hrefs is still reachable, for every role that could reach
 *     it before — in its sidebar, an accordion, or a directory it can see.
 *   • allowedRoutesForRole() — which middleware uses as the route guard — returns the SAME
 *     set for every gated role. owner/manager gain only /today, /activity,
 *     /purchases/inbox and /scorecard, and middleware does not gate those two roles anyway.
 *   • Hrefs, ids, labels, icons and hints of every entry — with three exceptions: the
 *     duplicate rows' ids are gone (acc-pnl, acc-bs, acc-cf, acc-gst, acc-tds, acc-esi,
 *     acc-aging, acc-ledger, my-expenses-sales), "Reports Hub" is now "Reports" (it is
 *     the directory), and the three orphans got rows.
 *
 * Also touched, minimally, because the tree now has depth: Sidebar (a section counts as
 * active when you are on one of its directory pages), the command palette and /mobile
 * (they list children and directory rows too).
 *
 * WHY ROLES NOW SIT ON EVERY ITEM: a section's `roles` used to narrow its items, so
 * moving an item between sections silently changed who could open it. Sections no longer
 * carry roles; each item states its own, copied from the effective roles it had before
 * (section ∩ item, unioned across duplicates). Moving an item is now a pure move.
 *
 * WHY THESE GROUPS: they are the verbs of the business, in the order money moves —
 * sell it, bill it, buy what it needs, book it, pay the team, configure the tool. "Home"
 * holds the queues a person clears every day (Today, WhatsApp, Support, Activation).
 * Customer/billing pages stay together under Bill exactly as Abhishek grouped them on
 * 10 Sep; their breadcrumbs still read "Billing > …".
 */

// Roles live in one place now — see src/lib/auth/roles.ts for why. Re-exported
// so the many `import { UserRole } from "@/lib/nav"` call sites keep working.
import type { UserRole } from "@/lib/auth/roles";
export type { UserRole };

export interface NavItem {
  id: string;
  /** URL path (relative, starts with /) */
  href: string;
  label: string;
  /** Icon name from our Icon component */
  icon: string;
  /** Optional badge text (e.g., count of pending items) */
  badge?: string;
  /**
   * Roles that can see this nav item. Omit = visible to everyone (default).
   * Use to lock down sales-only or owner-only entries. Filtered in Sidebar.tsx.
   */
  roles?: UserRole[];
  /** Sub-links rendered as an accordion under this item (e.g. Customers → Parent Accounts).
   *  A child's roles must be a subset of its parent's — a child of a row you cannot see is
   *  a row you cannot reach (nav-s30.test.ts checks this). */
  children?: NavItem[];
  /**
   * Pages listed on THIS item's landing page by <NavDirectory parentId={id} />, not in the
   * sidebar (S30). They are still part of the route guard, the command palette and the
   * breadcrumbs — only the sidebar row is saved. Same subset rule as `children`.
   */
  directory?: NavItem[];
  /** Heading a directory row is grouped under on the landing page. */
  group?: string;
  /** External URL — opens in a new tab (e.g. Google Drive) instead of in-app routing. */
  external?: boolean;
  /** Hover tooltip — a one-line hint so a data-entry user knows what belongs here. */
  hint?: string;
}

export interface NavSection {
  section: string;
  /** Icon for the group header (Zoho-style expandable group). */
  icon?: string;
  items: NavItem[];
  /** Roles that can see this section. Omit = visible to everyone. */
  roles?: UserRole[];
  /**
   * Short name for the breadcrumb, when the sidebar heading is too long for it.
   * Defaults to `section`.
   *
   * Added 21 Sep 2026. SCREEN_TITLES was a hand-kept SECOND copy of this structure and
   * it had drifted badly: the sidebar filed Subscriptions under "Billing &
   * Subscriptions" while the breadcrumb said "Revenue > Subscriptions", and seven more
   * pages in that section disagreed the same way. Abhishek spotted it on the
   * subscriptions page — "why it breadcrumb showing wrong".
   *
   * The names were not arbitrary; "Revenue" is a perfectly good crumb for Subscriptions.
   * The bug was that it lived somewhere the sidebar could not see. Now the crumb belongs
   * to the section, one place, and nav.test.ts fails if a SCREEN_TITLES entry ever
   * contradicts it again.
   */
  crumb?: string;
}

/** The breadcrumb name for a section — its short `crumb`, or the heading itself. */
export function sectionCrumb(section: NavSection): string {
  return section.crumb ?? section.section;
}

/**
 * Filter nav sections + items by the caller's role. Sections whose every item is
 * filtered out are dropped. Used by Sidebar to render a role-appropriate menu.
 *
 * ─── THE can_view_deals GATE IS GONE (17 Aug 2026) ──────────────────────────
 * Removed because Pardeep confirmed the requirement is obsolete: everyone on the team
 * should see the pipeline.
 *
 * BE CLEAR ABOUT WHAT THIS CHANGED, because it is more than a menu. This function
 * feeds allowedRoutesForRole(), which middleware:105 uses to decide whether a request
 * is permitted at all — a plain `sales` user without the flag typing /deals was
 * redirected to their ROLE_HOME. So the gate had teeth in BOTH places: it hid the menu
 * item AND blocked the route. Removing it opens the route to every sales user, which
 * is the intended outcome and not a side effect.
 *
 * (An earlier note in deals/page.tsx claimed the gate lived in middleware's
 * PROTECTED_PREFIXES. It did not — that list is the auth check. The real enforcement
 * was this function, one call away. Worth knowing if a restriction is ever wanted
 * again: this is where it goes.)
 *
 * The `can_view_deals` COLUMN is deliberately left in the database and on the /team
 * screen. Dropping a permission column is not a one-step reversal, and if a real
 * restriction is wanted later it should be re-applied here — or, better, as a
 * server-side row filter, since hiding a page never hid the underlying data from the
 * API.
 */
export interface NavFilterOpts {
  /** No longer used for gating. Accepted so existing callers keep compiling until
   *  they are tidied; passing it changes nothing. */
  canViewDeals?: boolean;
}
export function filterNavForRole(
  nav: NavSection[],
  role: UserRole | undefined,
  /* Accepted and ignored — see NavFilterOpts. Kept in the signature so the three
     existing call sites (Sidebar, MobileBottomNav, command palette) keep compiling
     until they are tidied separately. */
  _opts: NavFilterOpts = {},
): NavSection[] {
  if (!role) return nav;
  // "sales_senior" sees the same menu as "sales" (visibility), but is NEVER
  // gated on the deals entry — a senior seller always handles the pipeline.
  const visRole: UserRole = role === "sales_senior" ? "sales" : role;
  const sees = (i: NavItem) => !i.roles || i.roles.includes(visRole);
  /* children + directory are filtered too (S30). Before, nothing had children, so an
     unfiltered accordion was harmless; now a child is a real route and must obey roles. */
  const prune = (i: NavItem): NavItem => ({
    ...i,
    ...(i.children ? { children: i.children.filter(sees) } : {}),
    ...(i.directory ? { directory: i.directory.filter(sees) } : {}),
  });
  return nav
    .filter((s) => !s.roles || s.roles.includes(visRole))
    .map((s) => ({
      ...s,
      items: s.items.filter(sees).map(prune),
    }))
    .filter((s) => s.items.length > 0);
}

/** An item and everything reachable through it: accordion children, then directory rows. */
export function itemWithDescendants(item: NavItem): NavItem[] {
  return [item, ...(item.children ?? []), ...(item.directory ?? [])];
}

/**
 * Every entry of a nav tree, flat, with where it lives. The command palette, the mobile
 * preview list and the breadcrumbs all read this, so a page moved into an accordion or a
 * directory stays searchable and keeps a crumb.
 */
export interface FlatNavEntry {
  item: NavItem;
  section: NavSection;
  /** The sidebar row it sits under, when it is a child or directory row. */
  parent?: NavItem;
  via: "sidebar" | "child" | "directory";
}
export function flattenNav(nav: NavSection[]): FlatNavEntry[] {
  return nav.flatMap((section) =>
    section.items.flatMap((item): FlatNavEntry[] => [
      { item, section, via: "sidebar" },
      ...(item.children ?? []).map((c): FlatNavEntry => ({ item: c, section, parent: item, via: "child" })),
      ...(item.directory ?? []).map((d): FlatNavEntry => ({ item: d, section, parent: item, via: "directory" })),
    ]),
  );
}

/** Directory rows grouped by `group`, in first-appearance order (rows without one go
 *  under "More"). What <NavDirectory> renders. */
export function groupDirectory(items: NavItem[]): { group: string; items: NavItem[] }[] {
  const out: { group: string; items: NavItem[] }[] = [];
  for (const i of items) {
    const g = i.group ?? "More";
    const bucket = out.find((b) => b.group === g);
    if (bucket) bucket.items.push(i);
    else out.push({ group: g, items: [i] });
  }
  return out;
}

/** True when `pathname` is this item or one of its children / directory rows. */
export function navItemContains(item: NavItem, pathname: string): boolean {
  return itemWithDescendants(item).some((i) => pathname === i.href);
}

/**
 * The set of routes a given role + permission set is allowed to visit.
 * Anything outside this set is redirected to ROLE_HOME[role] by middleware.
 * Includes accordion children and directory rows (S30) — a page moved off the sidebar
 * must not become a page the guard bounces.
 */
export function allowedRoutesForRole(role: UserRole, opts: NavFilterOpts = {}): string[] {
  return flattenNav(filterNavForRole(APP_NAV, role, opts)).map((e) => e.item.href);
}

/**
 * Pages a role must NOT open even though a parent route admits it (R-138, 3 Oct 2026).
 * The guard matches by prefix, so billing's "/accounting" (the Overview) admitted every
 * /accounting/* page. The Balance Sheet is the one that lies to billing: since role hardening
 * (migration 20260930175000) only SALARY_ROLES may read salary_payments, so billing saw salary
 * payable and PF/ESI/TDS dues as Rs 0 with no warning. Pardeep chose to take it away.
 */
export const ROUTE_DENY: Partial<Record<UserRole, string[]>> = {
  billing: ["/accounting/balance-sheet"],
};

/** The route guard: allowed by the nav (prefix) and not denied for this role. */
export function isRouteAllowed(role: UserRole, pathname: string, opts: NavFilterOpts = {}): boolean {
  const under = (a: string) => pathname === a || pathname.startsWith(a + "/");
  if ((ROUTE_DENY[role] ?? []).some(under)) return false;
  return allowedRoutesForRole(role, opts).some(under);
}

/** Where each role lands by default (after login + on disallowed-route redirect). */
export const ROLE_HOME: Record<UserRole, string> = {
  owner:        "/dashboard",
  manager:      "/dashboard",
  sales:        "/leads",
  /* Was "/deals". Repointed with the same commit that removed the Deal Pipeline nav
     entry, and that ORDER matters: ROLE_HOME and allowedRoutesForRole are two halves
     of one rule, and a home the role can no longer reach makes middleware redirect to
     it, disallow it, and redirect again — the ERR_TOO_MANY_REDIRECTS login loop this
     file already records once. */
  sales_senior: "/leads",
  // The CA / accountant lands on the P&L — the headline figure for ITR.
  accountant:   "/accounting/pnl",
  support:      "/support",
  billing:      "/invoices",
  delivery:     "/projects",
  // MUST have a matching APP_NAV entry that admits this role (Partners, in the
  // Sell section). ROLE_HOME and allowedRoutesForRole are two halves of one
  // rule: a home the role is not allowed to visit makes middleware redirect to
  // it, disallow it, and redirect again — a login that ends in a loop.
  partner_agent: "/partners",
};

// ============================================================
// Internal app nav (the main sidebar for resellers)
// ============================================================
// Role conventions (S30): EVERY item states its own `roles`; sections carry none. The
// lists are the effective roles each href had before the regroup — see the header.
//   • Sales-only users see ONLY the items explicitly tagged with "sales"
//     (sales_senior sees what sales sees — filterNavForRole).
//   • Lead Pipeline + Tasks include "sales" because that's the day-to-day
//     surface for lead-only sellers (per Darshan's role at Excel Tech).
// Zoho-Books-style navigation: a few top-level EXPANDABLE groups (icon + label
// + chevron) instead of one long always-open wall. Every group starts collapsed and
// auto-opens when you're inside it.
const OM: UserRole[] = ["owner", "manager"];
const OMB: UserRole[] = ["owner", "manager", "billing"];
/** Who may read salaries (RLS on salary_payments since 20260930175000) — and so who gets a
 *  Balance Sheet whose salary lines are real. */
export const SALARY_ROLES: UserRole[] = ["owner", "manager", "accountant"];
/** Payroll Overview + Salary Register: the roles that had them, plus the accountant (R-061). */
const PAYROLL_ROLES: UserRole[] = ["owner", "manager", "billing", "accountant"];
/** Books: the accountant / CA reads every one of these. */
const BOOKS: UserRole[] = ["owner", "manager", "billing", "accountant"];
/** Everyone on the team except the external partner agent. */
const STAFF: UserRole[] = ["owner", "manager", "sales", "sales_senior", "accountant", "support", "billing", "delivery"];

/**
 * App pages that are deliberately NOT a menu row — each with its reason. nav.test.ts fails
 * when a page is in neither APP_NAV nor this list (Pardeep, 3 Oct 2026: no hidden links).
 */
export const NOT_IN_NAV: Readonly<Record<string, string>> = {
  "/quotes/new": "Opened by the New quote / Send quote buttons on Quotes, leads and deals",
  "/customers/new": "Opened by Add customer on Customers",
  "/setup": "First-run wizard; reached from onboarding and Settings",
  "/mobile": "Install-as-app guide; linked from the account menu",
  "/attendance/kiosk": "Runs on the office kiosk device, not in a person's menu",
  "/platform": "Founder-only cross-tenant view; any other owner would be refused by the server",
  "/aa/simulate-approval": "Mock consent screen for the bank-statement (Account Aggregator) test flow",
  "/vendor-portal": "Not built yet — the page says so",
  "/contacts": "Removed from the menu on purpose (10 Sep 2026): people live on the customer or the lead",
};

export const APP_NAV: NavSection[] = [
  {
    /* The queues a person clears every day. /today is the one list across all of them. */
    section: "Home",
    icon: "home",
    items: [
      /* S29. owner/manager only for now: they bypass the middleware gate anyway, so adding
         it changes no other role's allowed routes. Opening it to more roles is a product
         call — today_inbox() already filters decisions by role, and RLS does the rest. */
      { id: "today", href: "/today", label: "Today", icon: "inbox", roles: OM, hint: "Har queue ka aaj ka kaam, ek list mein" },
      { id: "dashboard", href: "/dashboard", label: "Dashboard", icon: "home", roles: OMB },
      /* 2 Oct 2026 — paste / photograph anything, review, save. Pardeep (3 Oct): no hidden
         links — every page is in this menu or in NOT_IN_NAV with its reason (nav.test.ts). */
      { id: "ai-entry",  href: "/ai-entry",  label: "AI Entry",  icon: "sparkles", roles: ["owner", "manager", "sales", "billing"], hint: "Chat, note, bill ya card daalo — AI entry bhar deta hai" },
      { id: "whatsapp",  href: "/whatsapp",        label: "WhatsApp Inbox",      icon: "whatsapp", roles: ["owner", "manager", "billing", "support", "delivery"] },
      { id: "support",   href: "/support",         label: "Support Desk",        icon: "ticket",   roles: ["owner", "manager", "billing", "support", "delivery"] },
      { id: "provisioning", href: "/provisioning", label: "Activation Queue", icon: "package", roles: ["owner", "manager", "support", "delivery"], hint: "Seats a customer has paid for that nobody has turned on yet." },
    ],
  },
  {
    section: "Sell",
    icon: "target",
    items: [
      { id: "leads",           href: "/leads",            label: "Sales & Pipeline", icon: "target", roles: ["owner", "manager", "sales"] },
      /* Deals — back in the menu 30 Sep 2026. "Deal Pipeline" was removed 17 Aug because
         /leads then showed every open lead, so a second entry had nothing to add. R-057
         (30 Sep) moved WON leads to /deals only, which left them unreachable from the
         menu — and, because allowedRoutesForRole() is built from this list, a plain sales
         user typing /deals was bounced to /leads by middleware. Same roles as Sales &
         Pipeline (sales_senior sees what sales sees): the 17 Aug decision was that every
         seller sees the pipeline. id "deals" also picks up nav_badges().deals (open
         demo / trial / quote). Keep ids unique — the command palette flattens by id. */
      { id: "deals",           href: "/deals",            label: "Deals",         icon: "trending_up", roles: ["owner", "manager", "sales"] },
      { id: "enquiries",       href: "/enquiries",        label: "Enquiries",     icon: "mail",   roles: ["owner", "manager", "sales"] },
      /* R-204 (6 Oct 2026, Pardeep): was "Online Orders" under Bill › Payments Received. An
         online order is a sale's journey (cart, trial, DMS) — many have no money yet, and a
         paid order's money already reaches Payments Received on its own. Same href, roles, hint. */
      { id: "online-orders",   href: "/online-orders",    label: "Orders (website)", icon: "cart", roles: OMB, hint: "Website ke saare orders — cart, checkout, trial" },
      { id: "tasks",           href: "/tasks",            label: "Tasks",         icon: "clock",  roles: ["owner", "manager", "sales"] },
      /* Contacts is GONE from the nav entirely (10 Sep 2026): a customer's people live ON
         the customer (migration 20260910100000); somebody who is not a customer yet is a
         LEAD. */
      {
        /* Marketing answers "where do leads come from and what does each cost" — owner/
           manager only, it shows ad spend and CAC. Fifteen sidebar rows became one: the
           other fourteen are the Hub's directory, in five groups (S30); S34 added a
           fifteenth, the IndiaMART key screen (owner-only, like its API). */
        id: "marketing-hub",   href: "/marketing",         label: "Marketing Hub",  icon: "layout", roles: OM, hint: "Kaunse tools chahiye, kaun sambhalta hai, budget vs kharcha",
        directory: [
          { id: "marketing-campaigns", href: "/marketing/campaigns", label: "Campaign budgets", icon: "target", roles: OM, group: "Plan & spend", hint: "Har campaign ka budget, dates, target — kharcha aur leads ke saath" },
          { id: "marketing-spend", href: "/marketing/spend",   label: "Spend",          icon: "wallet", roles: OM, group: "Plan & spend" },
          { id: "marketing-roas",  href: "/marketing/reports", label: "ROAS & CAC",     icon: "chart",  roles: OM, group: "Plan & spend" },
          { id: "campaigns",       href: "/campaigns",         label: "Email campaigns", icon: "mail",    roles: OM, group: "Campaigns" },
          { id: "email-templates", href: "/marketing/templates", label: "Email templates", icon: "file", roles: OM, group: "Campaigns" },
          { id: "wa-broadcast",    href: "/marketing/whatsapp",  label: "WhatsApp broadcast", icon: "whatsapp", roles: OM, group: "Campaigns", hint: "Approved template se leads ko ek saath message" },
          /* S28: renewal / invoice reminders on WhatsApp — switch, template per kind, send log. */
          { id: "wa-reminders",    href: "/marketing/whatsapp/reminders", label: "WhatsApp reminders", icon: "whatsapp", roles: OM, group: "Campaigns", hint: "Renewal aur invoice reminder WhatsApp par — ON/OFF, template, log" },
          { id: "ad-platforms",    href: "/marketing/ads",      label: "Ad accounts (live)", icon: "trending_up", roles: OM, group: "Ads & tracking", hint: "Google Ads + Facebook ka kharcha campaign-wise, roz Google/Meta se" },
          { id: "ad-landing-pages", href: "/marketing/landing-pages", label: "Ads landing pages", icon: "layout", roles: OM, group: "Ads & tracking", hint: "Ad ka final URL, phone preview, kitni leads aayi" },
          { id: "marketing-links", href: "/marketing/links",   label: "Tracking links", icon: "globe",  roles: OM, group: "Ads & tracking", hint: "Har ad / post ka link — lead ka source khud lagega" },
          { id: "lead-gen",        href: "/lead-gen",          label: "Lead sources",    icon: "target",  roles: OM, group: "Ads & tracking" },
          { id: "indiamart-leads", href: "/marketing/indiamart", label: "IndiaMART leads", icon: "inbox", roles: ["owner"], group: "Ads & tracking", hint: "CRM key save karo — IndiaMART ki enquiries apne aap leads banengi" },
          { id: "google-business", href: "/marketing/google-business", label: "Google Business Profile", icon: "map_pin", roles: OM, group: "Reputation", hint: "Maps/Search par listing kitni dikhi, calls, reviews — Google se seedha" },
          { id: "google-reviews",  href: "/marketing/reviews",   label: "Google reviews",  icon: "award", roles: OM, group: "Reputation", hint: "Khush customers se Google review maango" },
          { id: "coupons",         href: "/coupons",           label: "Coupons",         icon: "ticket",  roles: OM, group: "Offers & new leads" },
          { id: "online-promos",   href: "/online-promos",     label: "Website offer banner", icon: "sparkles", roles: OM, group: "Offers & new leads" },
          { id: "lead-finder",     href: "/marketing/lead-finder", label: "AI Lead Finder", icon: "sparkles", roles: OM, group: "Offers & new leads", hint: "Agent public web se aapke jaise customers dhoondhe — approve karo to lead" },
        ],
      },
      { id: "referrals",       href: "/referrals",        label: "Referrals",     icon: "award",  roles: OM },
      // The ONLY entry partner_agent can see besides Help. It is also ROLE_HOME for that
      // role, so this line is what keeps their login from looping.
      { id: "partners",  href: "/partners",             label: "Partners",         icon: "award", roles: ["owner", "manager", "partner_agent"] },
    ],
  },
  {
    /* Abhishek's grouping (10 Sep 2026) kept whole: a customer is a company you bill, so
       it sits beside the quotes, invoices and payments that concern it. The crumb stays
       "Billing" so every one of these pages reads exactly as it did. */
    section: "Bill",
    crumb: "Billing",
    icon: "rupee",
    items: [
      {
        id: "customers",       href: "/customers",        label: "Customers",       icon: "users",   roles: OMB,
        children: [
          { id: "customer-groups", href: "/customers/groups", label: "Parent Accounts", icon: "layout",  roles: OM },
        ],
      },
      { id: "quotes",        href: "/quotes",        label: "Quotes",            icon: "file",    roles: ["owner", "manager", "sales"] },
      { id: "subscriptions", href: "/subscriptions", label: "Subscriptions",     icon: "refresh", roles: OMB },
      { id: "renewals",      href: "/renewals",      label: "Renewals",          icon: "clock",   roles: ["owner", "manager", "billing", "support"] },
      { id: "invoices",      href: "/invoices",      label: "Invoices",          icon: "receipt", roles: OMB },
      /* Online Orders was a child of this row until 6 Oct 2026 — moved to Sell (R-204). */
      { id: "payments",      href: "/payments",      label: "Payments Received", icon: "rupee",   roles: OMB },
      { id: "projects",      href: "/projects",      label: "Project Sales",     icon: "package", roles: ["owner", "manager", "sales", "delivery", "billing"] },
      {
        id: "items",     href: "/items",           label: "Catalog & Products", icon: "package", roles: OM,
        children: [
          /* The two catalogs lived as tabs on /items with no link of their own, so the menu
             showed only Packages (Pardeep, 4 Oct 2026). Each now has its own address. */
          { id: "catalog-subscriptions", href: "/items/subscriptions", label: "Subscription catalog", icon: "repeat",  roles: OM, hint: "Google, Microsoft, hosting — har mahine/saal ka daam" },
          { id: "catalog-products",      href: "/items/products", label: "Product catalog",      icon: "package", roles: OM, hint: "Ek baar ke product aur services" },
          { id: "packages", href: "/items/packages", label: "Packages", icon: "package", roles: OM, hint: "Products ke bundle — quote me ek click" },
        ],
      },
    ],
  },
  {
    section: "Buy",
    /* R-177: these pages sit under the sidebar's "Billing" app (nav-apps.ts), so the
       crumb says Billing too — "Buy ›" named a heading the sidebar never shows. */
    crumb: "Billing",
    icon: "cart",
    items: [
      /* Was reachable only by URL. It is a queue — order mails waiting to be booked — so
         it leads the group. owner/manager only, so no gated role's routes change; whether
         billing should have it is a product call. */
      { id: "purchase-inbox",  href: "/purchases/inbox",           label: "Purchase Inbox",       icon: "inbox", roles: OM, hint: "Amazon & co. ke order mails — review karo, phir expense" },
      /* "Vendor Portal & Bids" (/vendor-portal) was a child here until S35 (28 Sep 2026).
         It showed hardcoded demo bids saved to localStorage; the route now says "not built
         yet" and points back to Vendors / Purchase Orders. Not in the nav, on purpose. */
      { id: "purchase-orders", href: "/purchase-orders",           label: "Purchase Orders",      icon: "cart", roles: OMB },
      { id: "vendors",         href: "/accounting/vendors",        label: "Vendors Master",       icon: "users", roles: OMB },
      {
        id: "bills",           href: "/accounting/bills",          label: "COGS Bills",           icon: "receipt", roles: OMB,
        children: [
          /* R-164: Google's monthly invoice (via Net2Secure) checked domain by domain. */
          { id: "google-bill-check", href: "/accounting/google-bill-check", label: "Google bill check", icon: "search", roles: OMB, hint: "Google ka mahine ka bill — har domain ka customer, leakage, margin" },
        ],
      },
      {
        id: "bill-payments",   href: "/accounting/bill-payments",  label: "Payments Made",        icon: "rupee", roles: OMB,
        children: [
          /* R-163: pick due bills → owner approves → one bank bulk file → mark paid. A child, not
             a row: the nav is at its 45-row cap (nav-s30.test.ts). */
          { id: "payment-runs", href: "/accounting/payment-runs", label: "Payment Runs", icon: "send", roles: OMB, hint: "Due bills ek saath — approve, bank file, paid" },
        ],
      },
      {
        id: "expenses",        href: "/accounting/expenses",       label: "Expenses",             icon: "rupee", roles: OMB,
        children: [
          /* Money paid to a vendor before the service (Facebook ad top-ups) and the
             month-end invoices booked against it (Pardeep, 26 Sep 2026). */
          { id: "prepaid",         href: "/accounting/prepaid",        label: "Prepaid / Advances",   icon: "wallet", roles: OMB },
          { id: "emp-advances",    href: "/accounting/advances",       label: "Employee Advances",    icon: "wallet", roles: OMB, hint: "Staff ko kharche ka advance — diya, kharch, baaki" },
          { id: "reimbursements",  href: "/accounting/reimbursements", label: "Reimbursements",       icon: "receipt", roles: OMB },
        ],
      },
    ],
  },
  {
    /* The accountant / CA's whole menu lives here now. Before S30 they had a separate
       "Filing" section that repeated seven of these hrefs; the command palette de-duped
       them and the sidebar did not. One list, one place. */
    section: "Books",
    icon: "chart",
    items: [
      {
        id: "acc-overview",        href: "/accounting",               label: "Accounting Overview", icon: "layout", roles: BOOKS,
        children: [
          { id: "fixed-assets",    href: "/accounting/assets",         label: "Fixed Assets",   icon: "package", roles: BOOKS },
          { id: "business-loans",  href: "/accounting/business-loans", label: "Business Loans", icon: "wallet",  roles: BOOKS },
        ],
      },
      {
        id: "banking",             href: "/accounting/banking",       label: "Banking",             icon: "rupee", roles: BOOKS,
        children: [
          { id: "banking-brs",     href: "/accounting/banking/brs",   label: "Bank Reconciliation (BRS)", icon: "check", roles: BOOKS },
          { id: "banking-rules",   href: "/accounting/banking/rules", label: "Bank rules",          icon: "list",  roles: BOOKS },
        ],
      },
      /* The khata. The ledger answers "send me MY statement" for one party; Customer Aging
         (in Reports) answers "who owes me, across everyone". The owner must see it — he is
         exactly the person a customer asks for a statement (nav.test.ts). */
      { id: "ledger",              href: "/accounting/ledger",        label: "Ledger (Khata)",      icon: "file", roles: BOOKS },
      { id: "acc-close",           href: "/accounting/close",         label: "Month-end Close",     icon: "check", roles: BOOKS },
      {
        /* THE REPORTS DIRECTORY (S30). Every report is one click from this page, grouped.
           GST Reports, TDS Receivable and Customer Aging were once missing from the
           owner's menu entirely (nav.test.ts) — they are in this directory for every role
           that had them, and /today surfaces the GST/TDS deadlines themselves. */
        id: "reports",             href: "/reports",                  label: "Reports",             icon: "chart", roles: BOOKS,
        directory: [
          { id: "pnl",                 href: "/accounting/pnl",           label: "P&L Report",          icon: "trending_up", roles: BOOKS, group: "Financial statements" },
          { id: "balance-sheet",       href: "/accounting/balance-sheet", label: "Balance Sheet",       icon: "layout", roles: SALARY_ROLES, group: "Financial statements" },
          { id: "cash-flow",           href: "/accounting/cash-flow",     label: "Cash Flow",           icon: "rupee", roles: BOOKS, group: "Financial statements" },
          /* S33: CA sabse pehle yahi do maangta hai. */
          { id: "trial-balance",       href: "/accounting/trial-balance", label: "Trial Balance",       icon: "file", roles: BOOKS, group: "Financial statements" },
          { id: "day-book",            href: "/accounting/day-book",      label: "Day Book",            icon: "calendar", roles: BOOKS, group: "Financial statements" },
          { id: "profitability",       href: "/accounting/profitability", label: "Customer Profitability", icon: "trending_up", roles: BOOKS, group: "Business" },
          { id: "profit-by-product",   href: "/reports/profit",           label: "Profit by Product",   icon: "chart", roles: OM, group: "Business" },
          { id: "saas-metrics",        href: "/accounting/saas-metrics",  label: "SaaS Metrics (MRR)",  icon: "refresh", roles: OM, group: "Business" },
          { id: "purchases-report",    href: "/reports/purchases",        label: "Purchases Report",    icon: "cart", roles: BOOKS, group: "Business" },
          { id: "gst-owner",           href: "/accounting/gst",           label: "GST Reports",         icon: "file", roles: BOOKS, group: "Tax" },
          { id: "tds-owner",           href: "/accounting/tds-receivable",label: "TDS Receivable",      icon: "rupee", roles: BOOKS, group: "Tax" },
          { id: "tds-year-end",        href: "/accounting/tds-receivable/year-end", label: "TDS Year-end", icon: "file", roles: BOOKS, group: "Tax" },
          { id: "itr",                 href: "/accounting/itr",           label: "Income Tax (ITR)",    icon: "file", roles: BOOKS, group: "Tax" },
          { id: "acc-aging-owner",     href: "/accounting/aging",         label: "Customer Aging",      icon: "clock", roles: BOOKS, group: "Receivables & registers" },
          { id: "esi-register",        href: "/accounting/esi-register",  label: "ESI & PF Register",   icon: "file", roles: BOOKS, group: "Receivables & registers" },
          /* Was reachable only by URL. Owner/manager: it is who-did-what across the team. */
          { id: "activity",            href: "/activity",                 label: "Activity Log",        icon: "list", roles: OM, group: "Audit" },
        ],
      },
      {
        id: "compliance-calendar", href: "/compliance",               label: "Compliance Calendar", icon: "calendar", roles: BOOKS,
        children: [
          { id: "compliance-gst",  href: "/compliance/gst",         label: "GST",               icon: "file", roles: BOOKS },
          { id: "compliance-it",   href: "/compliance/income-tax",  label: "Income Tax",        icon: "file", roles: BOOKS },
          { id: "compliance-roc",  href: "/compliance/roc",         label: "ROC (MCA)",         icon: "file", roles: BOOKS },
        ],
      },
    ],
  },
  {
    section: "Team",
    icon: "users",
    items: [
      { id: "my-attendance", href: "/attendance/me", label: "My Attendance", icon: "calendar", roles: STAFF, hint: "Apni attendance khud mark karo — login hi identity proof hai." },
      /* Was listed twice (Home and Sales & CRM) "for reach". Once is enough now that it
         has a group every staff role can see; the mobile Quick Actions grid still puts it
         first on a phone. */
      { id: "my-expenses", href: "/my-expenses", label: "Advances & Expenses", icon: "wallet", roles: STAFF, hint: "Advance cash balances & mobile expense entries." },
      {
        id: "employees",         href: "/accounting/employees",       label: "Employees & Team",       icon: "users", roles: OMB,
        children: [
          /* Was reachable only by URL. */
          { id: "scorecard",       href: "/scorecard",                  label: "Scorecards",             icon: "award", roles: OM },
          { id: "performance",     href: "/performance",                label: "Team Performance",       icon: "trending_up", roles: OM },
          { id: "assessments",     href: "/assessments",                label: "Assessments",            icon: "check", roles: OM },
          /* Apprentice Academy (R-149). Owner / manager in phase 1 (they are the mentors); the
             sidebar is at its row cap, so it sits here rather than as a new top-level row. */
          { id: "academy",         href: "/academy",                    label: "Apprentice Academy",     icon: "award", roles: OM, hint: "Apprentices, training, tasks aur review" },
        ],
      },
      {
        id: "attendance-reg",    href: "/accounting/attendance",      label: "Attendance Register",    icon: "calendar", roles: OMB, hint: "Daily attendance logs, check-in/out & hours.",
        children: [
          { id: "leave-reg",         href: "/accounting/leave",           label: "Leave Register",         icon: "file", roles: OMB, hint: "Casual leave, sick leave & earned leave tracking." },
        ],
      },
      /* R-061 (6 Oct 2026): the accountant / CA could open Payroll and the Salary Register by URL
         (the guard admits all of /accounting/* through BOOKS) but had no menu row. The database
         already lets them read and write salaries (SALARY_ROLES, migration 20260930175000) and a
         CA needs the register for TDS and ITR, so the menu shows them now — menu and guard agree. */
      {
        id: "payroll",           href: "/accounting/payroll",         label: "Payroll Overview",       icon: "rupee", roles: PAYROLL_ROLES,
        children: [
          { id: "salary-register",   href: "/accounting/salary-register", label: "Salary & Payroll Register", icon: "receipt", roles: PAYROLL_ROLES, hint: "Monthly salary slip register, CTC & net payouts." },
          { id: "emp-loans",         href: "/accounting/loans",           label: "Loans & Salary Advances",icon: "rupee", roles: OMB },
        ],
      },
      /* Where teammates are invited, a stranded colleague is claimed, and join requests are
         approved. Found with no nav entry once already — keep it a sidebar row. */
      { id: "team",      href: "/team",                 label: "Team",             icon: "users", roles: OM },
    ],
  },
  {
    section: "Settings",
    icon: "settings",
    items: [
      {
        id: "settings",  href: "/settings",             label: "Settings",         icon: "settings", roles: OMB,
        children: [
          /* Owner-only: restore points and the data reset. A safety feature nobody can
             find is not a safety feature — it had no nav entry at all until Aug 2026. */
          { id: "backup",    href: "/settings/backup",      label: "Backup & Restore", icon: "database", roles: ["owner"] },
        ],
      },
      /* "App khud kya bhejta hai — aur band karne ka switch". A brake nobody can find is
         not a brake. */
      {
        id: "automation", href: "/automation",          label: "Automation",       icon: "sparkles", roles: OM, hint: "App khud kya bhejta hai — aur band karne ka switch",
        children: [
          { id: "ux-insights", href: "/ux-insights",    label: "UX Insights",      icon: "sparkles", roles: OM, hint: "Log kahan atakte hain — aur kya theek karna hai" },
          { id: "ui-insights", href: "/ui-insights",    label: "UI Insights",      icon: "layout",   roles: OM, hint: "Har page ka design score — aur kya badalna hai" },
          /* The triage queue for bug reports (Report Bug, Ctrl+Shift+B, and AI Help). Next to
             UX / UI Insights since 5 Oct 2026 (R-158): it sat under "Help & Tutorial" at the
             bottom of the menu and Pardeep could not find it; the sidebar is at its row cap.
             Owner/manager: reports quote whatever the reporter typed, often a customer's name. */
          { id: "feedback",  href: "/admin/feedback",   label: "Bug Reports & AI Fixes", icon: "bug", roles: OM, hint: "Har report — Report Bug aur AI Help se; sab tenants ek saath" },
        ],
      },
      {
        // owner/manager only — these are customers' admin console passwords.
        id: "vault",     href: "/vault",                label: "Password Vault",   icon: "lock", roles: OM,
        children: [
          /* The owner's PRIVATE books. This hides the menu row and nothing more: middleware
             skips its role guard for owner AND manager. The data is protected by RLS scoped
             to auth.uid() (personal_vault_owner_isolation.test.sql), per USER not per role. */
          { id: "vault-personal", href: "/vault/personal",  label: "Private Vault",    icon: "wallet", roles: ["owner"], hint: "Aapke apne paise — team me kisi ko nahi dikhta" },
          { id: "vault-personal-banking",  href: "/vault/personal/banking",  label: "Private banking",  icon: "rupee",  roles: ["owner"] },
          { id: "vault-personal-expenses", href: "/vault/personal/expenses", label: "Private expenses", icon: "receipt", roles: ["owner"] },
          { id: "vault-personal-wealth",   href: "/vault/personal/wealth",   label: "Private wealth",   icon: "trending_up", roles: ["owner"] },
        ],
      },
      { id: "documents", href: "/documents",       label: "Company Documents",  icon: "file",    roles: OM },
      { id: "hosting-domains", href: "/hosting-domains", label: "Hosting & Domains", icon: "globe", roles: ["owner", "manager", "support"], hint: "Status of the DMS engine, and the way into its admin panel." },
      {
        /* S36: every role. It was owner / manager / billing / partner only, so the people
           who most need "how do I…" — sales, support, delivery, the accountant — had no way
           in (middleware bounced /help too: its allow-list is derived from these roles).
           The guide is static text (lib/help/content.ts), nothing tenant- or role-sensitive.
           The Feedback child keeps its own OM gate. */
        id: "help",      href: "/help",                 label: "Help & Tutorial",  icon: "question", roles: [...STAFF, "partner_agent"],
      },
    ],
  },
];

/* CUSTOMER_NAV was here until 1 Oct 2026 (R-047): a "Customer-facing" menu that nothing ever
   rendered (no import anywhere since the first commit), holding three links to pages that do
   not exist (/buy/m365, /buy/zoho, /support-customer) and one to a made-up quote id. Deleted
   rather than repaired. The site's real customer pages are the marketing site's own menu
   (src/site/components/chrome). nav-links-resolve.test.ts now checks every href in this file. */

// ============================================================
// Breadcrumb titles — by URL path, DERIVED from APP_NAV (S30)
// ============================================================
// Until S30 this was a hand-kept second copy of the nav, and it named sections that did
// not exist: /whatsapp and /support said "Engage", HR pages said "Payroll", purchases
// said "Purchases", while the sidebar said otherwise. Now:
//   • a sidebar or accordion row's crumb is [section crumb, label];
//   • a directory row's crumb is [section crumb, parent label, label] — it tells you
//     where to click to find the page again (Books › Reports › P&L Report);
//   • a page NOT in APP_NAV declares only its own tail, and the head comes from the nav
//     entry it sits under — by path (the nearest nav ancestor) or by an explicit `under`,
//     which is either a nav href or a section name.
// nav-s30.test.ts fails if any crumb starts with a name that is not a section's crumb.

/** Pages that are not nav entries: detail pages, sub-pages, and routes kept alive for
 *  bookmarks. `tail` is appended to the crumb of whatever they sit under. */
const EXTRA_SCREENS: Record<string, { tail: string[]; under?: string }> = {
  // NB: /deals is an APP_NAV entry again (30 Sep 2026), so its crumb comes from the nav
  //     ("Sell / Deals") — an entry here would override that with a stale title.
  "/contacts":               { tail: ["Contacts"], under: "/leads" },
  "/contacts/[id]":          { tail: ["Contacts", "Profile"], under: "/leads" },
  "/customers/groups/[id]":  { tail: ["Detail"] },
  "/customers/new":          { tail: ["New"] },
  "/customers/[id]":         { tail: ["Profile"] },
  "/customers/[id]/edit":    { tail: ["Edit"] },
  // NB: /online-orders is a Sell nav row since R-204 (6 Oct 2026), so its crumb comes from
  //     the nav ("Sell / Orders (website)") — an entry here would override it.
  "/quotes/new":             { tail: ["New"] },
  "/quotes/[id]":            { tail: ["Detail"] },
  "/projects/[id]":          { tail: ["Detail"] },
  "/invoices/[id]":          { tail: ["Detail"] },
  "/accounting/reimbursements": { tail: ["Reimbursements"], under: "/accounting/expenses" },
  "/accounting/saas-metrics":   { tail: ["SaaS Metrics"], under: "/reports" },
  "/accounting/profitability":  { tail: ["Customer Margin"], under: "/reports" },
  "/accounting/banking/[id]":   { tail: ["Account"] },
  "/accounting/banking/rules":  { tail: ["Category Rules"] },
  "/accounting/banking/brs":    { tail: ["Bank Reconciliation"] },
  "/accounting/business-loans": { tail: ["Business Loans"] },
  "/accounting/assets":         { tail: ["Assets & EMIs"] },
  "/accounting/tds-receivable/year-end": { tail: ["Year-End"] },
  "/compliance/roc":         { tail: ["ROC / MCA"] },
  "/compliance/gst":         { tail: ["GST Returns"] },
  "/compliance/income-tax":  { tail: ["Income Tax & TDS"] },
  "/performance":            { tail: ["Team Performance"], under: "Team" },
  "/assessments":            { tail: ["Reasoning Tests"], under: "Team" },
  "/attendance/kiosk":       { tail: ["Attendance Kiosk"], under: "Team" },
  "/reports/profit":         { tail: ["Profit by product/service"] },
  "/reports/purchases":      { tail: ["Purchase report"] },
  "/mobile":                 { tail: ["Mobile (PWA)"], under: "Settings" },
  "/setup":                  { tail: ["Setup Wizard"], under: "Settings" },
};

/** The crumb of every APP_NAV entry, from where it sits. */
function navCrumbs(nav: NavSection[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of flattenNav(nav)) {
    const head = sectionCrumb(e.section);
    out[e.item.href] = e.via === "directory" && e.parent
      ? [head, e.parent.label, e.item.label]
      : [head, e.item.label];
  }
  return out;
}

function buildScreenTitles(nav: NavSection[]): Record<string, string[]> {
  const fromNav = navCrumbs(nav);
  const out: Record<string, string[]> = { ...fromNav };
  for (const [path, { tail, under }] of Object.entries(EXTRA_SCREENS)) {
    let head: string[] | undefined;
    if (under) {
      head = fromNav[under];
      if (!head) {
        const sec = nav.find((s) => s.section === under);
        head = sec ? [sectionCrumb(sec)] : undefined;
      }
    } else {
      // Nearest nav ancestor by path: /customers/[id]/edit → /customers.
      const segs = path.split("/").filter(Boolean);
      for (let i = segs.length - 1; i >= 1 && !head; i--) head = fromNav["/" + segs.slice(0, i).join("/")];
    }
    /* A typo in `under` must be loud, not a crumb that silently says "Dashboard". */
    if (!head) throw new Error(`nav.ts EXTRA_SCREENS: ${path} sits under nothing in APP_NAV (under=${under ?? "by path"})`);
    out[path] = [...head, ...tail];
  }
  return out;
}

/** Breadcrumb for every known path. Derived — edit APP_NAV / EXTRA_SCREENS, not this. */
export const SCREEN_TITLES: Record<string, string[]> = buildScreenTitles(APP_NAV);

/**
 * Get breadcrumb path for a URL.
 * Falls back to ["Home", "Dashboard"] — the same crumb `/dashboard` itself maps
 * to. (Was ["Workspace", …]: a section that no longer exists in APP_NAV, so a
 * shell-rendered route with no SCREEN_TITLES entry — e.g. /platform — showed a
 * stale section name.)
 */
export function getCrumb(pathname: string): string[] {
  if (SCREEN_TITLES[pathname]) return SCREEN_TITLES[pathname];
  const segs = pathname.split("/").filter(Boolean);
  // Dynamic route (e.g. /customers/<uuid>, /customers/<uuid>/edit, /quotes/Q-ET-…,
  // /accounting/banking/<id>): the exact match fails because one segment is a live
  // id. Try substituting each single segment with the `[id]` placeholder to hit a
  // templated key — this catches mid-path ids (…/[id]/edit) the plain walk-up below
  // can't, so an edit/sub-page gets its own crumb instead of the parent's.
  for (let r = segs.length - 1; r >= 1; r--) {
    const cand = "/" + segs.map((s, idx) => (idx === r ? "[id]" : s)).join("/");
    if (SCREEN_TITLES[cand]) return SCREEN_TITLES[cand];
  }
  // Fallback: walk up to the longest known parent — try the `[id]` placeholder
  // first (nicer 3-level crumb), then the bare section path. Keeps the section
  // correct instead of wrongly falling back to "Dashboard".
  for (let i = segs.length - 1; i >= 1; i--) {
    const prefix = "/" + segs.slice(0, i).join("/");
    if (SCREEN_TITLES[`${prefix}/[id]`]) return SCREEN_TITLES[`${prefix}/[id]`];
    if (SCREEN_TITLES[prefix]) return SCREEN_TITLES[prefix];
  }
  return ["Home", "Dashboard"];
}

/**
 * Get the primary destination for a section name, so a breadcrumb like
 * `Workspace / Dashboard` can wrap "Workspace" in a Link → /dashboard.
 *
 * Returns the first nav item's href in that section. If no match (the label
 * isn't a known section name — e.g., a sub-page label like "Year-End"),
 * returns null and the caller renders plain text.
 */
/**
 * Nearest ancestor list page for a detail route — `/quotes/Q-1` → `/quotes`,
 * `/customers/<id>/edit` → `/customers`, `/accounting/banking/<id>` →
 * `/accounting/banking`. Mirrors `getCrumb()`'s walk-up over the same map.
 *
 * Used by the mobile Back button when there is no history to pop, i.e. the user
 * DEEP-LINKED straight into a detail page (a quote/invoice link from WhatsApp or
 * email — the common path for this product). Always returns something navigable,
 * so Back can never dead-end (CLAUDE.md §24).
 *
 * NOTE: do not use `getSectionPrimaryHref()` for this. That takes a *section
 * name* ("Home", "Sales & CRM"), not a pathname — passing a pathname always
 * returns null.
 */
export function getParentListHref(pathname: string): string {
  const segs = pathname.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 1; i--) {
    const prefix = "/" + segs.slice(0, i).join("/");
    if (SCREEN_TITLES[prefix]) return prefix;
  }
  return "/dashboard";
}

export function getSectionPrimaryHref(sectionName: string): string | null {
  const section = APP_NAV.find((s) => s.section === sectionName);
  if (!section || section.items.length === 0) return null;
  return section.items[0].href;
}
