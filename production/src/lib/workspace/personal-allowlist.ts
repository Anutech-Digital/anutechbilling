/**
 * GP-07a (R-2115, G-PERSONAL measure 2) — the pages a PERSONAL login may open, and nothing else.
 *
 * A personal account (role 'personal', one login = one workspace, decision D1) is someone's own
 * money + digital assets + free support. Every business page — invoices, quotes, accounting,
 * settings, team, and the company Password Vault at /vault — is refused for it by the same
 * route guard middleware runs (nav.ts isRouteAllowed). This list is the SPEC that guard is
 * tested against (nav-route-guard.test.ts walks every (app) page as role personal); nav.ts's
 * Personal section is what actually admits these pages.
 *
 *   /money           Money — the sidebar row; the page redirects to /vault/personal
 *   /vault/personal  the private money screens (Overview, Banking, Expenses, Wealth) — NEVER /vault
 *   /assets          My digital assets
 *   /support/my      Support (the person's own tickets — not the company desk at /support)
 *   /upgrade         Upgrade to business
 *   /account         Account (avatar menu, not a sidebar row)
 */
export const PERSONAL_PAGES: readonly string[] = [
  "/money",
  "/vault/personal",
  "/assets",
  "/support/my",
  "/upgrade",
  "/account",
];

/**
 * The personal pages that belong to the personal workspace ONLY. A business owner keeps their
 * Private Vault (/vault/personal, decision D1) but has no use for these — middleware gates the
 * owner on exactly these (it skips the owner everywhere else) and sends them to their home.
 */
export const PERSONAL_ONLY_PAGES: readonly string[] = PERSONAL_PAGES.filter((p) => p !== "/vault/personal");

const under = (pathname: string, page: string) => pathname === page || pathname.startsWith(page + "/");

/** True for a personal-only page or anything beneath it. */
export function isPersonalOnlyPage(pathname: string): boolean {
  return PERSONAL_ONLY_PAGES.some((p) => under(pathname, p));
}

/**
 * GP-07b (R-2116, G-PERSONAL measure 2) — the API a PERSONAL session may call. Middleware answers
 * every other /api path with 403 JSON, so a personal login cannot reach a business route
 * (/api/invoices, /api/team/invite, …) by hand even though its pages are walled (GP-07a).
 *
 * The personal workspace's own API:
 *   /api/vault/personal   the Money screens' PIN + private vault routes — NEVER /api/vault (company vault)
 *   /api/personal         personal-only routes (statement import etc. — later cards)
 *   /api/dms/sso          "My digital assets" → the DMS panel
 *   /api/support-sso      Support → the support desk
 */
export const PERSONAL_API_PREFIXES: readonly string[] = [
  "/api/vault/personal",
  "/api/personal",
  "/api/dms/sso",
  "/api/support-sso",
];

/**
 * Routes that never act as a business member — sign-in, public site/checkout, signed webhooks,
 * uptime checks, the public domain search (the role-gate ratchet's MACHINE_CALLER family) — plus
 * two the app shell needs on every page:
 *   /api/sb                     the data gateway the Money screens read through; its rows are
 *                               walled by RLS (GP-09) and its table allowlist (GP-10), not here
 *   /api/monitoring/sentry-dsn  the root layout's error reporting (public DSN, no session)
 * NOT here on purpose: /api/ai/* (extract-statement, help) and /api/cron/*.
 */
export const PERSONAL_OPEN_API_PREFIXES: readonly string[] = [
  "/api/auth",
  "/api/public",
  "/api/webhooks",
  "/api/version",
  "/api/health",
  "/api/domains/availability",
  "/api/sb",
  "/api/monitoring/sentry-dsn",
];

/** True when a personal session may call this /api path (segment match: /api/versionx is not /api/version). */
export function isPersonalApiAllowed(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return [...PERSONAL_API_PREFIXES, ...PERSONAL_OPEN_API_PREFIXES].some((p) => under(path, p));
}

/** The 403 body a personal session gets from a business API route. */
export const PERSONAL_API_REFUSAL = "Not available for personal accounts. Upgrade to business to use this.";

/**
 * GP-07c (R-2117) — every route.ts a PERSONAL session can reach through PERSONAL_API_PREFIXES,
 * keyed by its path under src/app/api (as role-gate-ratchet.test.ts names routes), with how it is
 * scoped to the caller. The middleware allowlist above is by prefix, so a new route under
 * /api/personal or /api/vault/personal is open to every free login the day it merges;
 * personal-gate-ratchet.test.ts fails until it is listed here — a reviewed step, not an accident.
 * A listed route that uses the service role must also show a session read AND an
 * owner_user_id / user_id pin to that session's user (the same test checks it).
 */
export const PERSONAL_API_ROUTES: Readonly<Record<string, string>> = {
  "vault/personal/pin":
    "the caller's own Money PIN — requireOwner() reads the session; every service-role RPC is createAdminClientFor(who.userId) with p_user_id: who.userId (GP-02b)",
  "personal/support-ticket":
    "R-2176: files the SESSION user's Help report as a support-desk ticket — the caller's own session calls personal_file_support_ticket (SECURITY DEFINER, auth.uid() only: personal check, own personal_identity_link, hourly cap); no service role, no id from the request",
  "dms/sso":
    "signs the SESSION user into the DMS panel — email from auth.getUser(), customer from portal_my_customer(); no service role, no id from the request",
};
