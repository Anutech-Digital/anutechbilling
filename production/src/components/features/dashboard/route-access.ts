/**
 * Can this role open this page? (R-253, 6 Oct 2026)
 *
 * The Dashboard is shown to owner / manager / billing, but some of its links point at pages
 * middleware closes to billing (/quotes, /items). Pressed by billing, such a link threw them
 * back to /invoices — a button that looked dead. Read from nav.ts (the rule middleware uses),
 * never copied. Owner and manager have no route gate in middleware.
 */
import { isRouteAllowed, type UserRole } from "@/lib/nav";

export function canOpenRoute(role: string | null | undefined, href: string): boolean {
  /* Role still loading: keep the owner view rather than flash a shorter card. */
  if (!role) return true;
  if (role === "owner" || role === "manager") return true;
  return isRouteAllowed(role as UserRole, href.split("?")[0]);
}
