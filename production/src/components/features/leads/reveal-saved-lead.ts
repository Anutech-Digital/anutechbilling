/**
 * R-208 (6 Oct 2026): after "Add lead" / "Quick add" saves, the new lead must be in front of
 * the user — not somewhere below the overdue leads the list sorts first. Both forms call this
 * one function so they cannot drift apart:
 *   - a toast confirms the save, with an "Open lead" (or "Open deal") button;
 *   - on /leads itself the new lead's drawer opens straight away (via the page's ?lead=<id>
 *     deep link, which also scrolls the row into view and highlights it).
 * From any other page (Lead Gen, the deal pipeline) only the toast shows — jumping pages
 * uninvited would lose whatever the user was doing there.
 */
import { toast } from "sonner";
import type { Route } from "next";

export interface RevealSavedLeadArgs {
  id: string;
  /** Toast headline, e.g. "Acme added to your leads". */
  title: string;
  description?: string;
  /** A deal (past the quote gate) opens its own page, a raw lead the /leads drawer. */
  isDeal: boolean;
  /** usePathname() of the page the form was opened on. */
  pathname: string | null;
  router: { push: (href: Route) => void; replace: (href: Route) => void };
  /** Optional second toast button (Quick add uses it for WhatsApp). */
  cancel?: { label: string; onClick: () => void };
}

export function savedLeadHref(id: string, isDeal: boolean): string {
  const safe = encodeURIComponent(id);
  return isDeal ? `/deals/${safe}` : `/leads?lead=${safe}`;
}

export function revealSavedLead({ id, title, description, isDeal, pathname, router, cancel }: RevealSavedLeadArgs): void {
  const href = savedLeadHref(id, isDeal) as Route;
  toast.dismiss();
  toast.success(title, {
    description,
    duration: 8000,
    action: { label: isDeal ? "Open deal" : "Open lead", onClick: () => router.push(href) },
    ...(cancel ? { cancel } : {}),
  });
  if (!isDeal && pathname === "/leads") router.replace(href);
}
