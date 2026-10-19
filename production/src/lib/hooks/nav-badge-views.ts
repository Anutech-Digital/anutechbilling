/**
 * R-1541 (audit 18 Oct 2026) — what each sidebar badge counts, and the view that lists
 * exactly those rows.
 *
 * "Renewals 12" opened the Urgent tab with 3 rows; "Invoices 5" opened every invoice. The
 * manager's decision (on the card, decidedBy: manager): a badge stays an ATTENTION signal —
 * it counts what still needs doing — and a click on the BADGE opens the filtered view whose
 * count is the badge (the row label still opens the page as before). Hovering the badge says
 * what the number means ("12 unpaid invoices").
 *
 * One rule per badge, used by both sides:
 *   - the page filters with the TS predicate named below;
 *   - nav_badges() (the latest supabase/migrations/*nav_badges*.sql) counts with the same
 *     rule in SQL — nav-badge-parity.test.ts reads that file against these constants, and
 *     supabase/tests/nav_badges.test.sql seeds rows on each side of every rule.
 *
 * leads / deals are R-1475's: the page's "All" view (lib/leads/page-scope.ts).
 */
import { drillHref } from "@/lib/navigation/drilldown";
import { canOpenRoute } from "@/lib/nav";
import type { NAV_BADGE_KEYS } from "./nav-badge-counts";

export type NavBadgeKey = (typeof NAV_BADGE_KEYS)[number];

export interface NavBadgeView {
  /** The view the badge opens — its rows are exactly the ones counted. */
  href: string;
  /** What the number means, for the hover title and the screen reader. */
  meaning: (n: number) => string;
}

const s = (n: number) => (n === 1 ? "" : "s");

export const NAV_BADGE_VIEWS: Readonly<Record<NavBadgeKey, NavBadgeView>> = {
  leads:     { href: "/leads",                       meaning: (n) => `${n} lead${s(n)} in All leads` },
  deals:     { href: "/deals",                       meaning: (n) => `${n} deal${s(n)} in All deals` },
  /* task-groups.ts taskGroupOf → "overdue": open, and its due time has passed. */
  tasks:     { href: drillHref("tasksOverdue"),      meaning: (n) => `${n} overdue task${s(n)}` },
  /* lib/renewals/buckets.ts — renews within 7 days, or already lapsed. */
  renewals:  { href: drillHref("renewalsUrgent"),    meaning: (n) => `${n} renewal${s(n)} due within 7 days or lapsed` },
  /* lib/invoices/kpis.ts invoiceInFocus "unpaid" — pending / overdue with a balance left. */
  invoices:  { href: drillHref("invoicesUnpaid"),    meaning: (n) => `${n} unpaid invoice${s(n)}` },
  /* lib/inbound/folders.ts inboxUnread — the red number on the Inbox folder. */
  enquiries: { href: drillHref("enquiriesInbox"),    meaning: (n) => `${n} unread conversation${s(n)} in the Inbox` },
  /* lib/quotes/focus.ts "to-invoice" — the Payments page's "Awaiting GST Invoice" tile opens
     the same view. */
  payments:  { href: drillHref("quotesToInvoice"),   meaning: (n) => `${n} paid quote${s(n)} without a GST invoice` },
  /* lib/quotes/awaiting-approval.ts awaitsMyApproval — the Quotes page's approvals filter. */
  quotes:    { href: drillHref("quotesMyApprovals"), meaning: (n) => `${n} quote${s(n)} waiting on your approval` },
};

export interface ShownBadge {
  text: string;
  href: string;
  title: string;
}

/**
 * The badge to draw for one sidebar row, or null. A count whose view this role cannot open is
 * not drawn: a badge that bounces you to your home page is worse than none (Payments' badge
 * opens Quotes, which billing and the accountant do not have).
 */
export function shownBadge(key: string, text: string | undefined, role: string | null | undefined): ShownBadge | null {
  if (!text) return null;
  const view = (NAV_BADGE_VIEWS as Record<string, NavBadgeView | undefined>)[key];
  if (!view) return null;
  if (!canOpenRoute(role, view.href)) return null;
  const n = Number(text);
  return { text, href: view.href, title: view.meaning(Number.isFinite(n) ? n : 0) };
}
