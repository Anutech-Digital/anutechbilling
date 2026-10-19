/**
 * R-1543 (audit 18 Oct 2026) — Ctrl+K shows only what this role can open.
 *
 * The palette listed every company, quote, invoice, payment and lead it could load, whatever
 * the role: a sales user picked a company and bounced back to /leads, billing picked a lead
 * and landed on /invoices — no message, nothing opened. R-1542 made a page's URL follow its
 * menu row (nav.ts isRouteAllowed, the rule middleware applies); the palette now asks the
 * SAME rule of every result before showing it.
 *
 * Fails closed, like mayOpenPage (lib/api/with-route.ts — server-only, so not imported here):
 * while the role is still loading, or unknown, no page, action or record is offered. A
 * palette that briefly shows nothing is fine; one that offers a link that bounces is the bug.
 */
import { isRouteAllowed } from "@/lib/nav";
import { isUserRole } from "@/lib/auth/roles";

/** May this role open `href` (query string and hash ignored)? Unknown role → false. */
export function paletteMayOpen(role: string | null | undefined, href: string): boolean {
  if (!isUserRole(role)) return false;
  const path = href.split(/[?#]/)[0] || "/";
  return isRouteAllowed(role, path);
}

/** The palette's record groups, by the page a result opens. A group whose page the role cannot
 *  open is not searched at all. `/x` stands for "a record under this page". */
export const PALETTE_GROUP_PAGES = {
  companies:     "/customers/x",
  leads:         "/leads",
  quotes:        "/quotes/x",
  invoices:      "/invoices/x",
  subscriptions: "/subscriptions",
  /* Add seats opens a dialog that writes the subscription — offered to whoever can open it. */
  seats:         "/subscriptions",
  payments:      "/payments",
} as const;

export type PaletteGroup = keyof typeof PALETTE_GROUP_PAGES;

export function paletteGroupsFor(role: string | null | undefined): Record<PaletteGroup, boolean> {
  const out = {} as Record<PaletteGroup, boolean>;
  for (const [g, page] of Object.entries(PALETTE_GROUP_PAGES) as [PaletteGroup, string][]) {
    out[g] = paletteMayOpen(role, page);
  }
  return out;
}
