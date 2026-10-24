/**
 * The Accounting Overview's "Reports & ledgers" cards (R-1648).
 *
 * Billing and the accountant were shown cards for pages the route guard does not let them open
 * (Balance Sheet / Cash Flow for billing, SaaS Metrics for both); the click bounced them home
 * with no word. Which cards a role sees is decided by canOpenRoute → nav.ts isRouteAllowed —
 * the rule middleware.ts applies to the URL — never a second list of roles here.
 */
import { canOpenRoute } from "@/lib/nav";

export interface ReportLink { href: string; icon: string; title: string; sub: string }

export const REPORT_LINKS: readonly ReportLink[] = [
  { href: "/accounting/pnl", icon: "trending_up", title: "P&L Report", sub: "Revenue − costs = profit" },
  { href: "/accounting/balance-sheet", icon: "layout", title: "Balance Sheet", sub: "What you own vs owe" },
  { href: "/accounting/cash-flow", icon: "rupee", title: "Cash Flow", sub: "Real money in vs out" },
  { href: "/accounting/banking", icon: "rupee", title: "Banking", sub: "Accounts + reconcile" },
  { href: "/accounting/gst", icon: "file", title: "GST Reports", sub: "Output − input + filing" },
  { href: "/accounting/profitability", icon: "users", title: "Customer Margin", sub: "Profit per customer" },
  { href: "/accounting/aging", icon: "clock", title: "Customer Aging", sub: "Who owes, how old" },
  { href: "/accounting/ledger", icon: "file", title: "Ledger (Khata)", sub: "One party · Dr/Cr statement" },
  { href: "/accounting/tds-receivable", icon: "rupee", title: "TDS Receivable", sub: "TDS credits to claim" },
  { href: "/accounting/assets", icon: "cart", title: "Assets & EMIs", sub: "Fixed assets + loans" },
  { href: "/accounting/business-loans", icon: "rupee", title: "Business Loans", sub: "Borrowings + EMIs" },
  { href: "/accounting/advances", icon: "wallet", title: "Employee Advances", sub: "Petty cash + expense claims" },
  { href: "/accounting/saas-metrics", icon: "sparkles", title: "SaaS Metrics", sub: "MRR · churn · LTV" },
];

/** The cards this role can open. Role unknown (still loading) → all, so the owner sees no flicker. */
export function reportLinksFor(role: string | null | undefined): ReportLink[] {
  return REPORT_LINKS.filter((l) => canOpenRoute(role, l.href));
}
