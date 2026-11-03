/**
 * Can this role open an invoice page? (R-2422) — the invoice twin of lib/quotes/access.ts
 * canOpenQuotes: read from nav.ts (the same rule middleware uses), never copied, so an invoice
 * link is shown exactly to the roles that can open it.
 */
import { isRouteAllowed, type UserRole } from "@/lib/nav";

export function canOpenInvoices(role: string | null | undefined): boolean {
  if (!role) return false;
  /* Middleware applies no route gate to these two (middleware.ts). */
  if (role === "owner" || role === "manager") return true;
  return isRouteAllowed(role as UserRole, "/invoices/x");
}
