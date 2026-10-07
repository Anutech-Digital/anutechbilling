/**
 * Which SCREEN was a bug reported from, and which FILE is that screen?
 *
 * ─── WHY A RAW PATH IS NOT ENOUGH ───────────────────────────────────────────
 * The feedback dialog captures `usePathname()`, so the first real report on this system
 * arrived tagged `/quotes/Q-ADPL-2026-27-0002`. That string is useless twice over: it
 * cannot be grouped (every quote is its own path, so "which screen is worst" has no
 * answer), and it does not name a file (there is no `quotes/Q-ADPL-2026-27-0002/`
 * directory). Collapsing it to `/quotes/[id]` fixes both — it groups, and it maps
 * straight to `src/app/(app)/quotes/[id]/page.tsx`.
 *
 * ─── THE TABLE IS COMMITTED, NOT SCANNED AT RUNTIME ─────────────────────────
 * This module is imported by client components and by an API route, so it cannot read
 * the filesystem. The route table below is therefore a committed copy of what is on
 * disk — and a committed copy of a directory listing is exactly the kind of thing that
 * silently goes stale. `route-map.test.ts` walks `src/app` itself and asserts this
 * array matches it exactly, so adding a page without updating this file fails the
 * suite rather than quietly degrading every future triage to "no target file found".
 *
 * ─── LITERAL SEGMENTS BEAT DYNAMIC ONES ─────────────────────────────────────
 * `/customers/groups` and `/customers/[id]` both match the path `/customers/groups`,
 * and `/quotes/new` collides with `/quotes/[id]` the same way. Next.js resolves this
 * by preferring the static segment, and so does `normalizeRoutePath` — otherwise a
 * report from the customer-groups screen is filed against the customer detail page and
 * whoever picks it up opens the wrong file.
 */

export interface AppRoute {
  /** URL shape, Next.js style. Route groups like `(app)` never appear here. */
  route: string;
  /** Repo-relative source file, from the `production/` directory. */
  file: string;
}

/**
 * Every page in the app, sorted by route.
 *
 * Keep sorted and keep it matching disk — `route-map.test.ts` enforces both.
 */
export const APP_ROUTES: readonly AppRoute[] = [
  { route: "/aa/simulate-approval", file: "src/app/(app)/aa/simulate-approval/page.tsx" },
  { route: "/about", file: "src/app/(public)/about/page.tsx" },
  { route: "/academy", file: "src/app/(app)/academy/page.tsx" },
  { route: "/academy/[id]", file: "src/app/(app)/academy/[id]/page.tsx" },
  { route: "/accounting", file: "src/app/(app)/accounting/page.tsx" },
  { route: "/accounting/advances", file: "src/app/(app)/accounting/advances/page.tsx" },
  { route: "/accounting/aging", file: "src/app/(app)/accounting/aging/page.tsx" },
  { route: "/accounting/assets", file: "src/app/(app)/accounting/assets/page.tsx" },
  { route: "/accounting/attendance", file: "src/app/(app)/accounting/attendance/page.tsx" },
  { route: "/accounting/balance-sheet", file: "src/app/(app)/accounting/balance-sheet/page.tsx" },
  { route: "/accounting/banking", file: "src/app/(app)/accounting/banking/page.tsx" },
  { route: "/accounting/banking/[id]", file: "src/app/(app)/accounting/banking/[id]/page.tsx" },
  { route: "/accounting/banking/brs", file: "src/app/(app)/accounting/banking/brs/page.tsx" },
  { route: "/accounting/banking/rules", file: "src/app/(app)/accounting/banking/rules/page.tsx" },
  { route: "/accounting/bill-payments", file: "src/app/(app)/accounting/bill-payments/page.tsx" },
  { route: "/accounting/bills", file: "src/app/(app)/accounting/bills/page.tsx" },
  { route: "/accounting/business-loans", file: "src/app/(app)/accounting/business-loans/page.tsx" },
  { route: "/accounting/cash-flow", file: "src/app/(app)/accounting/cash-flow/page.tsx" },
  { route: "/accounting/close", file: "src/app/(app)/accounting/close/page.tsx" },
  { route: "/accounting/day-book", file: "src/app/(app)/accounting/day-book/page.tsx" },
  { route: "/accounting/employees", file: "src/app/(app)/accounting/employees/page.tsx" },
  { route: "/accounting/esi-register", file: "src/app/(app)/accounting/esi-register/page.tsx" },
  { route: "/accounting/expenses", file: "src/app/(app)/accounting/expenses/page.tsx" },
  { route: "/accounting/google-bill-check", file: "src/app/(app)/accounting/google-bill-check/page.tsx" },
  { route: "/accounting/gst", file: "src/app/(app)/accounting/gst/page.tsx" },
  { route: "/accounting/itr", file: "src/app/(app)/accounting/itr/page.tsx" },
  { route: "/accounting/leave", file: "src/app/(app)/accounting/leave/page.tsx" },
  { route: "/accounting/ledger", file: "src/app/(app)/accounting/ledger/page.tsx" },
  { route: "/accounting/loans", file: "src/app/(app)/accounting/loans/page.tsx" },
  { route: "/accounting/payment-runs", file: "src/app/(app)/accounting/payment-runs/page.tsx" },
  { route: "/accounting/payroll", file: "src/app/(app)/accounting/payroll/page.tsx" },
  { route: "/accounting/pnl", file: "src/app/(app)/accounting/pnl/page.tsx" },
  { route: "/accounting/prepaid", file: "src/app/(app)/accounting/prepaid/page.tsx" },
  { route: "/accounting/profitability", file: "src/app/(app)/accounting/profitability/page.tsx" },
  { route: "/accounting/reimbursements", file: "src/app/(app)/accounting/reimbursements/page.tsx" },
  { route: "/accounting/saas-metrics", file: "src/app/(app)/accounting/saas-metrics/page.tsx" },
  { route: "/accounting/salary-register", file: "src/app/(app)/accounting/salary-register/page.tsx" },
  { route: "/accounting/tds-receivable", file: "src/app/(app)/accounting/tds-receivable/page.tsx" },
  { route: "/accounting/tds-receivable/year-end", file: "src/app/(app)/accounting/tds-receivable/year-end/page.tsx" },
  { route: "/accounting/trial-balance", file: "src/app/(app)/accounting/trial-balance/page.tsx" },
  { route: "/accounting/vendors", file: "src/app/(app)/accounting/vendors/page.tsx" },
  { route: "/activity", file: "src/app/(app)/activity/page.tsx" },
  { route: "/admin/feedback", file: "src/app/(app)/admin/feedback/page.tsx" },
  { route: "/ai-entry", file: "src/app/(app)/ai-entry/page.tsx" },
  { route: "/assessment/[token]", file: "src/app/(public)/assessment/[token]/page.tsx" },
  { route: "/assessments", file: "src/app/(app)/assessments/page.tsx" },
  { route: "/attendance/kiosk", file: "src/app/(app)/attendance/kiosk/page.tsx" },
  { route: "/attendance/me", file: "src/app/(app)/attendance/me/page.tsx" },
  { route: "/automation", file: "src/app/(app)/automation/page.tsx" },
  { route: "/buy/workspace", file: "src/app/(public)/buy/workspace/page.tsx" },
  { route: "/buy/workspace/thanks", file: "src/app/(public)/buy/workspace/thanks/page.tsx" },
  { route: "/campaigns", file: "src/app/(app)/campaigns/page.tsx" },
  { route: "/compliance", file: "src/app/(app)/compliance/page.tsx" },
  { route: "/compliance/gst", file: "src/app/(app)/compliance/gst/page.tsx" },
  { route: "/compliance/income-tax", file: "src/app/(app)/compliance/income-tax/page.tsx" },
  { route: "/compliance/roc", file: "src/app/(app)/compliance/roc/page.tsx" },
  { route: "/contacts", file: "src/app/(app)/contacts/page.tsx" },
  { route: "/contacts/[id]", file: "src/app/(app)/contacts/[id]/page.tsx" },
  { route: "/coupons", file: "src/app/(app)/coupons/page.tsx" },
  { route: "/customers", file: "src/app/(app)/customers/page.tsx" },
  { route: "/customers/[id]", file: "src/app/(app)/customers/[id]/page.tsx" },
  { route: "/customers/[id]/edit", file: "src/app/(app)/customers/[id]/edit/page.tsx" },
  { route: "/customers/groups", file: "src/app/(app)/customers/groups/page.tsx" },
  { route: "/customers/groups/[id]", file: "src/app/(app)/customers/groups/[id]/page.tsx" },
  { route: "/customers/new", file: "src/app/(app)/customers/new/page.tsx" },
  { route: "/dashboard", file: "src/app/(app)/dashboard/page.tsx" },
  { route: "/deals", file: "src/app/(app)/deals/page.tsx" },
  { route: "/deals/[id]", file: "src/app/(app)/deals/[id]/page.tsx" },
  { route: "/dev/components", file: "src/app/dev/components/page.tsx" },
  { route: "/dev/pdf-test", file: "src/app/dev/pdf-test/page.tsx" },
  { route: "/dev/sentry-client-test", file: "src/app/dev/sentry-client-test/page.tsx" },
  { route: "/documents", file: "src/app/(app)/documents/page.tsx" },
  { route: "/enquiries", file: "src/app/(app)/enquiries/page.tsx" },
  { route: "/enquiry", file: "src/app/(public)/enquiry/page.tsx" },
  { route: "/expense-claim", file: "src/app/(public)/expense-claim/page.tsx" },
  { route: "/forgot-password", file: "src/app/(auth)/forgot-password/page.tsx" },
  { route: "/help", file: "src/app/(app)/help/page.tsx" },
  { route: "/hosting-domains", file: "src/app/(app)/hosting-domains/page.tsx" },
  { route: "/invoices", file: "src/app/(app)/invoices/page.tsx" },
  { route: "/invoices/[id]", file: "src/app/(app)/invoices/[id]/page.tsx" },
  { route: "/items", file: "src/app/(app)/items/page.tsx" },
  { route: "/items/packages", file: "src/app/(app)/items/packages/page.tsx" },
  { route: "/items/products", file: "src/app/(app)/items/products/page.tsx" },
  { route: "/items/subscriptions", file: "src/app/(app)/items/subscriptions/page.tsx" },
  { route: "/lead-gen", file: "src/app/(app)/lead-gen/page.tsx" },
  { route: "/leads", file: "src/app/(app)/leads/page.tsx" },
  { route: "/learn", file: "src/app/learn/page.tsx" },
  { route: "/login", file: "src/app/(auth)/login/page.tsx" },
  { route: "/lp/google-workspace", file: "src/app/(lp)/lp/google-workspace/page.tsx" },
  { route: "/lp/google-workspace-1", file: "src/app/(lp)/lp/google-workspace-1/page.tsx" },
  { route: "/lp/google-workspace-business-plus-1", file: "src/app/(lp)/lp/google-workspace-business-plus-1/page.tsx" },
  { route: "/lp/google-workspace-business-standard-1", file: "src/app/(lp)/lp/google-workspace-business-standard-1/page.tsx" },
  { route: "/lp/google-workspace-business-starter-1", file: "src/app/(lp)/lp/google-workspace-business-starter-1/page.tsx" },
  { route: "/lp/google-workspace-enterprise-1", file: "src/app/(lp)/lp/google-workspace-enterprise-1/page.tsx" },
  { route: "/marketing", file: "src/app/(app)/marketing/page.tsx" },
  { route: "/marketing/ads", file: "src/app/(app)/marketing/ads/page.tsx" },
  { route: "/marketing/campaigns", file: "src/app/(app)/marketing/campaigns/page.tsx" },
  { route: "/marketing/google-business", file: "src/app/(app)/marketing/google-business/page.tsx" },
  { route: "/marketing/indiamart", file: "src/app/(app)/marketing/indiamart/page.tsx" },
  { route: "/marketing/landing-pages", file: "src/app/(app)/marketing/landing-pages/page.tsx" },
  { route: "/marketing/lead-finder", file: "src/app/(app)/marketing/lead-finder/page.tsx" },
  { route: "/marketing/links", file: "src/app/(app)/marketing/links/page.tsx" },
  { route: "/marketing/reports", file: "src/app/(app)/marketing/reports/page.tsx" },
  { route: "/marketing/reviews", file: "src/app/(app)/marketing/reviews/page.tsx" },
  { route: "/marketing/spend", file: "src/app/(app)/marketing/spend/page.tsx" },
  { route: "/marketing/templates", file: "src/app/(app)/marketing/templates/page.tsx" },
  { route: "/marketing/whatsapp", file: "src/app/(app)/marketing/whatsapp/page.tsx" },
  { route: "/marketing/whatsapp/reminders", file: "src/app/(app)/marketing/whatsapp/reminders/page.tsx" },
  { route: "/mfa", file: "src/app/(auth)/mfa/page.tsx" },
  { route: "/mobile", file: "src/app/(app)/mobile/page.tsx" },
  { route: "/my-expenses", file: "src/app/(app)/my-expenses/page.tsx" },
  { route: "/online-orders", file: "src/app/(app)/online-orders/page.tsx" },
  { route: "/online-promos", file: "src/app/(app)/online-promos/page.tsx" },
  { route: "/partners", file: "src/app/(app)/partners/page.tsx" },
  { route: "/payments", file: "src/app/(app)/payments/page.tsx" },
  { route: "/performance", file: "src/app/(app)/performance/page.tsx" },
  { route: "/platform", file: "src/app/(app)/platform/page.tsx" },
  { route: "/pricing", file: "src/app/(public)/pricing/page.tsx" },
  { route: "/privacy", file: "src/app/(public)/privacy/page.tsx" },
  { route: "/project-quote/[id]", file: "src/app/(public)/project-quote/[id]/page.tsx" },
  { route: "/projects", file: "src/app/(app)/projects/page.tsx" },
  { route: "/projects/[id]", file: "src/app/(app)/projects/[id]/page.tsx" },
  { route: "/provisioning", file: "src/app/(app)/provisioning/page.tsx" },
  { route: "/purchase-orders", file: "src/app/(app)/purchase-orders/page.tsx" },
  { route: "/purchases/inbox", file: "src/app/(app)/purchases/inbox/page.tsx" },
  { route: "/quality", file: "src/app/(app)/quality/page.tsx" },
  { route: "/quote/[id]/accept", file: "src/app/(public)/quote/[id]/accept/page.tsx" },
  { route: "/quote/view/[token]", file: "src/app/(public)/quote/view/[token]/page.tsx" },
  { route: "/quotes", file: "src/app/(app)/quotes/page.tsx" },
  { route: "/quotes/[id]", file: "src/app/(app)/quotes/[id]/page.tsx" },
  { route: "/quotes/[id]/edit", file: "src/app/(app)/quotes/[id]/edit/page.tsx" },
  { route: "/quotes/new", file: "src/app/(app)/quotes/new/page.tsx" },
  { route: "/referrals", file: "src/app/(app)/referrals/page.tsx" },
  { route: "/renewals", file: "src/app/(app)/renewals/page.tsx" },
  { route: "/reports", file: "src/app/(app)/reports/page.tsx" },
  { route: "/reports/profit", file: "src/app/(app)/reports/profit/page.tsx" },
  { route: "/reports/purchases", file: "src/app/(app)/reports/purchases/page.tsx" },
  { route: "/reset-password", file: "src/app/(auth)/reset-password/page.tsx" },
  { route: "/scorecard", file: "src/app/(app)/scorecard/page.tsx" },
  { route: "/settings", file: "src/app/(app)/settings/page.tsx" },
  { route: "/settings/backup", file: "src/app/(app)/settings/backup/page.tsx" },
  { route: "/setup", file: "src/app/(app)/setup/page.tsx" },
  { route: "/signup", file: "src/app/(auth)/signup/page.tsx" },
  { route: "/subscriptions", file: "src/app/(app)/subscriptions/page.tsx" },
  { route: "/support", file: "src/app/(app)/support/page.tsx" },
  { route: "/tasks", file: "src/app/(app)/tasks/page.tsx" },
  { route: "/team", file: "src/app/(app)/team/page.tsx" },
  { route: "/terms", file: "src/app/(public)/terms/page.tsx" },
  { route: "/today", file: "src/app/(app)/today/page.tsx" },
  { route: "/ui-insights", file: "src/app/(app)/ui-insights/page.tsx" },
  { route: "/unsubscribe", file: "src/app/(public)/unsubscribe/page.tsx" },
  { route: "/ux-insights", file: "src/app/(app)/ux-insights/page.tsx" },
  { route: "/vault", file: "src/app/(app)/vault/page.tsx" },
  { route: "/vault/personal", file: "src/app/(app)/vault/personal/page.tsx" },
  { route: "/vault/personal/banking", file: "src/app/(app)/vault/personal/banking/page.tsx" },
  { route: "/vault/personal/expenses", file: "src/app/(app)/vault/personal/expenses/page.tsx" },
  { route: "/vault/personal/wealth", file: "src/app/(app)/vault/personal/wealth/page.tsx" },
  { route: "/vendor-portal", file: "src/app/(app)/vendor-portal/page.tsx" },
  { route: "/verify-email", file: "src/app/(auth)/verify-email/page.tsx" },
  { route: "/welcome", file: "src/app/(auth)/welcome/page.tsx" },
  { route: "/whatsapp", file: "src/app/(app)/whatsapp/page.tsx" },
] as const;

/** Fast lookup by exact route pattern. */
const FILE_BY_ROUTE = new Map(APP_ROUTES.map((r) => [r.route, r.file]));

function isDynamic(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

function isCatchAll(segment: string): boolean {
  return segment.startsWith("[...") || segment.startsWith("[[...");
}

/** Split a path into segments, dropping the empty strings around the slashes. */
function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/**
 * Strip the parts of a captured URL that are not part of the route: the origin, the
 * query string, and the hash.
 *
 * A query string is dropped rather than kept because it is the single likeliest place
 * for personal data to be sitting — `?email=`, `?phone=`, a session token — and a
 * feedback table read by the whole team is the last place any of that should land.
 * `lib/marketing/utm.ts` made the same call for the same reason.
 */
export function stripToPath(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  let path = value;

  // Absolute URL → take the pathname. Never throws: a malformed URL falls through
  // and is treated as a path, which is the more useful of the two wrong answers.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }

  path = path.split("#")[0].split("?")[0];
  if (!path.startsWith("/")) path = `/${path}`;

  // Collapse duplicate slashes and drop a trailing one (but keep the root "/").
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");

  return path;
}

/**
 * Collapse a real URL path to the Next.js route that served it.
 *
 * Returns null when nothing matches — an unknown path is reported as unknown rather
 * than snapped to the nearest neighbour, because a confidently wrong screen sends the
 * reader to the wrong file and costs more than an honest blank.
 */
export function normalizeRoutePath(raw: string | null | undefined): string | null {
  const path = stripToPath(raw);
  if (path === null) return null;

  // Exact hit — covers every static route, and a path that was already normalised.
  if (FILE_BY_ROUTE.has(path)) return path;

  const parts = segmentsOf(path);

  let best: string | null = null;
  let bestLiterals = -1;

  for (const { route } of APP_ROUTES) {
    const routeParts = segmentsOf(route);

    const hasCatchAll = routeParts.some(isCatchAll);
    if (!hasCatchAll && routeParts.length !== parts.length) continue;
    if (hasCatchAll && parts.length < routeParts.length - 1) continue;

    let literals = 0;
    let ok = true;

    for (let i = 0; i < routeParts.length; i++) {
      const rp = routeParts[i];
      if (isCatchAll(rp)) break; // swallows the rest
      const p = parts[i];
      if (p === undefined) { ok = false; break; }
      if (isDynamic(rp)) continue;
      if (rp !== p) { ok = false; break; }
      literals++;
    }
    if (!ok) continue;

    // More literal matches wins: /customers/groups beats /customers/[id], and
    // /quotes/new beats /quotes/[id]. A tie cannot happen between two real Next.js
    // routes — two routes with identical literals in identical positions would be the
    // same route — so first-wins on a tie is safe and keeps this deterministic.
    if (literals > bestLiterals) {
      bestLiterals = literals;
      best = route;
    }
  }

  return best;
}

/** The page component that serves a route pattern, or null if the route is unknown. */
export function fileForRoute(route: string | null | undefined): string | null {
  if (!route) return null;
  return FILE_BY_ROUTE.get(route) ?? null;
}
