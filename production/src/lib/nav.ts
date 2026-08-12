/**
 * Navigation config — single source of truth for sidebar + breadcrumbs.
 *
 * Adding a new screen?
 * 1. Add an entry to APP_NAV
 * 2. Add a breadcrumb to SCREEN_TITLES
 * 3. Create the page at src/app/(app)/[id]/page.tsx
 */

export type UserRole =
  | "owner" | "manager" | "sales" | "sales_senior" | "accountant"
  | "support" | "billing" | "delivery";

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
  /** Sub-links rendered as an accordion under this item (e.g. Reports → sub-reports). */
  children?: NavItem[];
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
}

/**
 * Filter nav sections + items by the caller's role + optional permission
 * flags (currently just `canViewDeals` for sales). Sections whose every
 * item is filtered out are dropped. Used by Sidebar to render a
 * role-appropriate menu.
 */
export interface NavFilterOpts {
  /** Sales-role extension: when true, the /deals entry stays visible. */
  canViewDeals?: boolean;
}
export function filterNavForRole(
  nav: NavSection[],
  role: UserRole | undefined,
  opts: NavFilterOpts = {},
): NavSection[] {
  if (!role) return nav;
  // "sales_senior" sees the same menu as "sales" (visibility), but is NEVER
  // gated on the deals entry — a senior seller always handles the pipeline.
  const visRole: UserRole = role === "sales_senior" ? "sales" : role;
  return nav
    .filter((s) => !s.roles || s.roles.includes(visRole))
    .map((s) => ({
      ...s,
      items: s.items.filter((i) => {
        // Deals gate applies ONLY to plain sales (sales_senior always sees it).
        if (role === "sales" && i.id === "deals" && !opts.canViewDeals) return false;
        return !i.roles || i.roles.includes(visRole);
      }),
    }))
    .filter((s) => s.items.length > 0);
}

/**
 * The set of routes a given role + permission set is allowed to visit.
 * Anything outside this set is redirected to ROLE_HOME[role] by middleware.
 */
export function allowedRoutesForRole(role: UserRole, opts: NavFilterOpts = {}): string[] {
  return filterNavForRole(APP_NAV, role, opts).flatMap((s) => s.items.map((i) => i.href));
}

/** Where each role lands by default (after login + on disallowed-route redirect). */
export const ROLE_HOME: Record<UserRole, string> = {
  owner:        "/dashboard",
  manager:      "/dashboard",
  sales:        "/leads",
  sales_senior: "/deals",
  // The CA / accountant lands on the P&L — the headline figure for ITR.
  accountant:   "/accounting/pnl",
  support:      "/support",
  billing:      "/invoices",
  delivery:     "/projects",
};

// ============================================================
// Internal app nav (the main sidebar for resellers)
// ============================================================
// Role conventions (applied to APP_NAV entries below):
//   • Items without an explicit `roles` list → visible to owner + manager.
//   • Sales-only users see ONLY the items explicitly tagged with "sales".
//   • Lead Pipeline + Tasks include "sales" because that's the day-to-day
//     surface for lead-only sellers (per Darshan's role at Excel Tech).
// Zoho-Books-style navigation: a few top-level EXPANDABLE groups (icon + label
// + chevron) instead of one long always-open wall. "Home" is a standalone row;
// every other group starts collapsed and auto-opens when you're inside it.
// Item hrefs are unchanged — only the grouping/labels changed — so routing +
// allowed-routes stay identical.
export const APP_NAV: NavSection[] = [
  {
    // Accountant / CA view — read-only compliance reports only.
    section: "Filing",
    icon: "file",
    roles: ["accountant"],
    items: [
      { id: "acc-pnl",     href: "/accounting/pnl",            label: "P&L Report",     icon: "trending_up" },
      { id: "acc-bs",      href: "/accounting/balance-sheet",  label: "Balance Sheet",  icon: "layout" },
      { id: "acc-cf",      href: "/accounting/cash-flow",      label: "Cash Flow",      icon: "rupee" },
      { id: "acc-gst",     href: "/accounting/gst",            label: "GST Reports",    icon: "file" },
      { id: "acc-tds",     href: "/accounting/tds-receivable", label: "TDS Receivable", icon: "rupee" },
      { id: "acc-esi",     href: "/accounting/esi-register",   label: "ESI Register",   icon: "file" },
      { id: "acc-aging",   href: "/accounting/aging",          label: "Customer Aging", icon: "clock" },
    ],
  },
  {
    section: "Home",
    icon: "home",
    items: [
      { id: "dashboard", href: "/dashboard", label: "Dashboard", icon: "home", roles: ["owner", "manager", "billing"] },
      { id: "my-attendance", href: "/attendance/me", label: "My Attendance", icon: "calendar", hint: "Apni attendance khud mark karo — login hi identity proof hai." },
    ],
  },
  {
    section: "Sales & CRM",
    icon: "target",
    roles: ["owner", "manager", "sales", "billing"],
    items: [
      { id: "leads",           href: "/leads",            label: "Leads",         icon: "inbox",  roles: ["owner", "manager", "sales"] },
      { id: "enquiries",       href: "/enquiries",        label: "Enquiries",     icon: "mail",   roles: ["owner", "manager", "sales"] },
      { id: "deals",           href: "/deals",            label: "Deal Pipeline", icon: "target", roles: ["owner", "manager", "sales"] },
      { id: "tasks",           href: "/tasks",            label: "Tasks",         icon: "clock",  roles: ["owner", "manager", "sales"] },
      { id: "customers",       href: "/customers",        label: "Customers",     icon: "users",  roles: ["owner", "manager", "billing"] },
      { id: "customer-groups", href: "/customers/groups", label: "Parent Accounts", icon: "layout", roles: ["owner", "manager"] },
      { id: "contacts",        href: "/contacts",         label: "Contacts",      icon: "user",   roles: ["owner", "manager", "billing"] },
      { id: "referrals",       href: "/referrals",        label: "Referrals",     icon: "award",  roles: ["owner", "manager"] },
    ],
  },
  {
    section: "Billing & Subscriptions",
    icon: "rupee",
    roles: ["owner", "manager", "sales", "billing", "delivery", "support"],
    items: [
      { id: "quotes",        href: "/quotes",        label: "Quotes",            icon: "file",    roles: ["owner", "manager", "sales"] },
      { id: "subscriptions", href: "/subscriptions", label: "Subscriptions",     icon: "refresh", roles: ["owner", "manager", "billing"] },
      { id: "renewals",      href: "/renewals",      label: "Renewals",          icon: "clock",   roles: ["owner", "manager", "billing", "support"] },
      { id: "invoices",      href: "/invoices",      label: "Invoices",          icon: "receipt", roles: ["owner", "manager", "billing"] },
      { id: "payments",      href: "/payments",      label: "Payments Received", icon: "rupee",   roles: ["owner", "manager", "billing"] },
      { id: "projects",      href: "/projects",      label: "Project Sales",     icon: "package", roles: ["owner", "manager", "sales", "delivery", "billing"] },
    ],
  },
  {
    section: "Operations",
    icon: "package",
    roles: ["owner", "manager", "billing", "support", "delivery"],
    items: [
      { id: "items",     href: "/items",           label: "Catalog & Products", icon: "package", roles: ["owner", "manager"] },
      { id: "documents", href: "/documents",       label: "Company Documents",  icon: "file",    roles: ["owner", "manager"] },
      { id: "support",   href: "/support",         label: "Support Desk",        icon: "ticket" },
      { id: "whatsapp",  href: "/whatsapp",        label: "WhatsApp Inbox",      icon: "whatsapp" },
    ],
  },
  {
    section: "Purchases & Vendors",
    icon: "cart",
    roles: ["owner", "manager", "billing"],
    items: [
      { id: "vendor-portal",   href: "/vendor-portal",             label: "Vendor Portal & Bids", icon: "sparkles", hint: "Vendor marketplace, wholesale license rate bids & PO sourcing." },
      { id: "purchase-orders", href: "/purchase-orders",           label: "Purchase Orders",      icon: "cart" },
      { id: "vendors",         href: "/accounting/vendors",        label: "Vendors Master",       icon: "users" },
      { id: "bills",           href: "/accounting/bills",          label: "COGS Bills",           icon: "receipt" },
      { id: "bill-payments",   href: "/accounting/bill-payments",  label: "Payments Made",        icon: "rupee" },
      { id: "expenses",        href: "/accounting/expenses",       label: "Expenses",             icon: "rupee" },
    ],
  },
  {
    section: "Accounting & Finance",
    icon: "chart",
    roles: ["owner", "manager", "billing", "accountant"],
    items: [
      { id: "reports",             href: "/reports",                  label: "Reports Hub",         icon: "chart" },
      { id: "acc-overview",        href: "/accounting",               label: "Accounting Overview", icon: "layout" },
      { id: "banking",             href: "/accounting/banking",       label: "Banking",             icon: "rupee" },
      { id: "pnl",                 href: "/accounting/pnl",           label: "P&L Report",          icon: "trending_up" },
      { id: "balance-sheet",       href: "/accounting/balance-sheet", label: "Balance Sheet",       icon: "layout" },
      { id: "cash-flow",           href: "/accounting/cash-flow",     label: "Cash Flow",           icon: "rupee" },
      { id: "compliance-calendar", href: "/compliance",               label: "Compliance Calendar", icon: "calendar" },
    ],
  },
  {
    section: "HR & Payroll",
    icon: "users",
    roles: ["owner", "manager", "billing"],
    items: [
      { id: "employees",         href: "/accounting/employees",       label: "Employees & Team",       icon: "users" },
      { id: "attendance-reg",    href: "/accounting/attendance",      label: "Attendance Register",    icon: "calendar", hint: "Daily attendance logs, check-in/out & hours." },
      { id: "leave-reg",         href: "/accounting/leave",           label: "Leave Register",         icon: "file",     hint: "Casual leave, sick leave & earned leave tracking." },
      { id: "payroll",           href: "/accounting/payroll",         label: "Payroll Overview",       icon: "rupee" },
      { id: "salary-register",   href: "/accounting/salary-register", label: "Salary & Payroll Register", icon: "receipt", hint: "Monthly salary slip register, CTC & net payouts." },
      { id: "esi-register",      href: "/accounting/esi-register",    label: "ESI & PF Register",      icon: "file" },
      { id: "emp-loans",         href: "/accounting/loans",           label: "Loans & Salary Advances",icon: "rupee" },
    ],
  },
  {
    section: "Admin & Control",
    icon: "settings",
    roles: ["owner", "manager", "billing"],
    items: [
      { id: "settings",  href: "/settings",             label: "Settings",         icon: "settings" },
      { id: "help",      href: "/help",                 label: "Help & Tutorial",  icon: "question" },
    ],
  },
];

// ============================================================
// Customer-facing pages (chromeless — used in nav switcher)
// ============================================================
export const CUSTOMER_NAV: NavSection[] = [
  {
    section: "Customer-facing",
    items: [
      { id: "landing",          href: "/",                  label: "Marketing Landing", icon: "globe" },
      { id: "buy-workspace",    href: "/buy/workspace",     label: "Buy · Workspace",   icon: "sparkles" },
      { id: "buy-m365",         href: "/buy/m365",          label: "Buy · Microsoft 365", icon: "package" },
      { id: "buy-zoho",         href: "/buy/zoho",          label: "Buy · Zoho",        icon: "package" },
      { id: "portal",           href: "/portal",            label: "Customer Portal",   icon: "layout" },
      { id: "quote-accept",     href: "/quote/Q-2026-0042", label: "Quote Accept & Pay", icon: "check_circle" },
      { id: "support-customer", href: "/support-customer",  label: "Customer Support",  icon: "question" },
    ],
  },
];

// ============================================================
// Breadcrumb titles — by URL path
// ============================================================
// NB: /leads + /deals share the same component (the /deals route file
//     re-exports from /leads). The titles still need separate entries here.
export const SCREEN_TITLES: Record<string, string[]> = {
  "/dashboard":       ["Home", "Dashboard"],
  "/leads":           ["Sales", "Leads"],
  "/enquiries":       ["Sales", "Enquiries"],
  "/deals":           ["Sales", "Deal Pipeline"],
  "/tasks":           ["Sales", "Tasks"],
  "/customers":       ["Sales", "Customers"],
  "/customers/groups":      ["Sales", "Parent Accounts"],
  "/customers/groups/[id]": ["Sales", "Parent Accounts", "Detail"],
  "/customers/new":   ["Sales", "Customers", "New"],
  "/customers/[id]":  ["Sales", "Customers", "Profile"],
  "/customers/[id]/edit": ["Sales", "Customers", "Edit"],
  "/contacts":        ["Sales", "Contacts"],
  "/contacts/[id]":   ["Sales", "Contacts", "Profile"],
  "/referrals":       ["Sales", "Referrals"],
  "/online-orders":   ["Revenue", "Online Orders"],
  "/quotes":          ["Revenue", "Quotes"],
  "/quotes/new":      ["Revenue", "Quotes", "New"],
  "/quotes/[id]":     ["Revenue", "Quotes", "Detail"],
  "/projects":        ["Revenue", "Project Sales"],
  "/projects/[id]":   ["Revenue", "Project Sales", "Detail"],
  "/payments":        ["Revenue", "Payments Received"],
  "/invoices":        ["Revenue", "Invoices"],
  "/invoices/[id]":   ["Revenue", "Invoices", "Detail"],
  "/subscriptions":   ["Revenue", "Subscriptions"],
  "/renewals":        ["Revenue", "Renewals"],
  "/vendor-portal":   ["Purchases", "Vendor Portal & Bids"],
  "/purchase-orders": ["Purchases", "Purchase Orders"],
  "/accounting/vendors":       ["Purchases", "Vendors"],
  "/accounting/bills":         ["Purchases", "COGS Bills"],
  "/accounting/bill-payments": ["Purchases", "Payments Made"],
  "/accounting/expenses":      ["Purchases", "Expenses"],
  "/accounting/reimbursements": ["Purchases", "Reimbursements"],
  "/accounting":               ["Accounting", "Overview"],
  "/accounting/saas-metrics":  ["Accounting", "SaaS Metrics"],
  "/accounting/banking":       ["Accounting", "Banking"],
  "/accounting/banking/[id]":  ["Accounting", "Banking", "Account"],
  "/accounting/business-loans": ["Accounting", "Business Loans"],
  "/accounting/pnl":           ["Accounting", "P&L Report"],
  "/accounting/balance-sheet": ["Accounting", "Balance Sheet"],
  "/accounting/cash-flow":     ["Accounting", "Cash Flow"],
  "/accounting/assets":        ["Accounting", "Assets & EMIs"],
  "/accounting/prepaid":       ["Accounting", "Prepaid / Advances"],
  "/accounting/profitability": ["Accounting", "Customer Margin"],
  "/accounting/aging":         ["Accounting", "Customer Aging"],
  "/accounting/esi-register":  ["Payroll", "ESI Register"],
  "/performance":              ["Payroll", "Team Performance"],
  "/assessments":              ["Payroll", "Reasoning Tests"],
  "/accounting/tds-receivable":          ["Accounting", "TDS Receivable"],
  "/accounting/tds-receivable/year-end": ["Accounting", "TDS Receivable", "Year-End"],
  "/accounting/gst":      ["Accounting", "GST Reports"],
  "/compliance":            ["Compliance", "Compliance Calendar"],
  "/compliance/roc":        ["Compliance", "ROC / MCA"],
  "/compliance/gst":        ["Compliance", "GST Returns"],
  "/compliance/income-tax": ["Compliance", "Income Tax & TDS"],
  "/accounting/loans":         ["Payroll", "Loans & Advances"],
  "/accounting/employees":     ["Payroll", "Employees"],
  "/accounting/payroll":       ["Payroll", "Payroll"],
  "/accounting/salary-register": ["Payroll", "Salary Register"],
  "/accounting/leave":         ["Payroll", "Leave Register"],
  "/accounting/attendance":    ["Payroll", "Attendance Register"],
  "/attendance/kiosk":         ["Payroll", "Attendance Kiosk"],
  "/attendance/me":            ["My Attendance"],
  "/activity":                 ["Reports", "Activity Log"],
  "/scorecard":                ["Payroll", "Scorecards"],
  "/whatsapp":        ["Engage", "WhatsApp Inbox"],
  "/campaigns":       ["Engage", "Campaigns"],
  "/online-promos":   ["Engage", "Online Promos"],
  "/coupons":         ["Engage", "Coupons"],
  "/reports":         ["Reports", "All Reports"],
  "/reports/profit":  ["Reports", "Profit by product/service"],
  "/reports/purchases": ["Reports", "Purchase report"],
  "/purchases/inbox":   ["Purchases", "Purchase Inbox"],
  "/support":         ["Engage", "Support"],
  "/items":           ["Catalog"],
  "/documents":       ["Company Documents", "Documents"],
  "/settings":        ["Settings", "Settings"],
  "/settings/backup": ["Settings", "Backup"],
  "/team":            ["Settings", "Team"],
  "/partners":        ["Settings", "Partners"],
  "/lead-gen":        ["Settings", "Lead Sources"],
  "/mobile":          ["Settings", "Mobile (PWA)"],
  "/setup":           ["Settings", "Setup Wizard"],
  "/help":            ["Help", "Help & Tutorial"],
};

/**
 * Get breadcrumb path for a URL.
 * Falls back to ["Workspace", "Dashboard"] if no match.
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
  return ["Workspace", "Dashboard"];
}

/**
 * Get the primary destination for a section name, so a breadcrumb like
 * `Workspace / Dashboard` can wrap "Workspace" in a Link → /dashboard.
 *
 * Returns the first nav item's href in that section. If no match (the label
 * isn't a known section name — e.g., a sub-page label like "Year-End"),
 * returns null and the caller renders plain text.
 */
export function getSectionPrimaryHref(sectionName: string): string | null {
  const section = APP_NAV.find((s) => s.section === sectionName);
  if (!section || section.items.length === 0) return null;
  return section.items[0].href;
}
