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
