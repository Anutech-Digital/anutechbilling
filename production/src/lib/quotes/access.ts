/**
 * Can this role open a quote page? (R-237, 6 Oct 2026)
 *
 * The nav gives Quotes to owner / manager / sales only, and middleware sends every other
 * role that opens /quotes/* back to its home page. Billing's home is /invoices, so every
 * "Record payment", "View quote" or quote-number link a billing user pressed on Payments,
 * an invoice or a renewal silently threw them back to the Invoices list. Read from nav.ts
 * (the same rule middleware uses), never copied, so a quote link is shown exactly to the
 * roles that can open it.
 */
import { isRouteAllowed, type UserRole } from "@/lib/nav";

export function canOpenQuotes(role: string | null | undefined): boolean {
  if (!role) return false;
  /* Middleware applies no route gate to these two (middleware.ts). */
  if (role === "owner" || role === "manager") return true;
  return isRouteAllowed(role as UserRole, "/quotes/x");
}
