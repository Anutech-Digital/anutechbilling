/**
 * R-1473 (17 Oct 2026) — "money owed" had three answers on staging.
 *
 * Pawan: dashboard "Still owed ₹0, 0 unpaid invoices", the Collections card on the same
 * dashboard "₹44,746 outstanding", Companies "To collect ₹0", Renewals two customers unpaid
 * ₹25.5K + ₹19.3K. Root cause — two different things were both being called "owed", and the
 * one that was the same thing was computed three different ways:
 *
 *   1. BILLED, UNPAID — unpaid invoices, net payable − receipts (lib/invoices/kpis.ts,
 *      invoiceBalance / invoiceInFocus "unpaid"; R-118, R-371). The accrual receivable: the
 *      dashboard "Still owed" tile, /invoices Outstanding, Aging, the Balance Sheet.
 *   2. TO CHASE — `subscriptions.outstanding_amount` (expected − received on the deal) plus
 *      invoiced-but-unpaid project milestones. A COLLECTIONS figure (docs/ACCOUNTING-AUDIT.md
 *      F2: "Keep outstanding_amount for collections/chasing UX … it is a collections metric,
 *      not a balance-sheet one"). A subscription can carry a due before any invoice exists, and
 *      after an invoice is raised the same money can sit in both 1 and 2 — so the two are never
 *      added together; each tile says which one it is.
 *
 * Before this file, "to chase" drifted three ways:
 *   - dashboard Collections card summed every sub's due, WRITTEN-OFF ones included;
 *   - Companies kept only ONE subscription's due per company (the map was overwritten, not
 *     added), and skipped written-off ones;
 *   - Renewals flagged "Unpaid balance" on written-off subs too.
 * Now all three read `subscriptionDue` / `toChaseSummary` below. A due on a subscription with
 * no company linked cannot appear on the Companies list, so the summary keeps it apart
 * (`unlinked`) and the dashboard says so instead of silently disagreeing (tile == list, R-118).
 *
 * Amounts are whole rupees as stored (CLAUDE.md §13); nothing is recomputed or written.
 */
import { rupee } from "@/lib/utils";

/** The subscription fields a due is read from. */
export interface DueSubscription {
  customer_id: string | null;
  outstanding_amount: number | null;
  written_off_at?: string | null;
}

/** What is still to be chased on one subscription: its due, or 0 once written off. */
export function subscriptionDue(sub: DueSubscription): number {
  if (sub.written_off_at) return 0;
  const due = sub.outstanding_amount ?? 0;
  return due > 0 ? due : 0;
}

export interface ToChaseSummary {
  /** Every subscription due + project receivable — the dashboard Collections figure. */
  total: number;
  subscriptionDues: number;
  projectInvoices: number;
  /** Per company: its subscription dues (all of them, summed) + its project receivable. */
  byCustomer: Map<string, number>;
  /** Sum of `byCustomer` — exactly the Companies "To collect" tile / "Has receivables" list. */
  companiesTotal: number;
  /** Dues on subscriptions with no company linked — counted in `total`, absent from Companies. */
  unlinked: { count: number; value: number };
}

/**
 * The "to chase" figure, by one rule for every screen.
 * `projectByCustomer` is useProjectReceivablesByCustomer (invoiced milestones − project receipts).
 */
export function toChaseSummary(
  subs: readonly DueSubscription[],
  projectByCustomer: Readonly<Record<string, number>> = {},
): ToChaseSummary {
  const byCustomer = new Map<string, number>();
  const unlinked = { count: 0, value: 0 };
  let subscriptionDues = 0;
  for (const s of subs) {
    const due = subscriptionDue(s);
    if (due <= 0) continue;
    subscriptionDues += due;
    if (!s.customer_id) {
      unlinked.count++;
      unlinked.value += due;
      continue;
    }
    byCustomer.set(s.customer_id, (byCustomer.get(s.customer_id) ?? 0) + due);
  }
  let projectInvoices = 0;
  for (const [customerId, amount] of Object.entries(projectByCustomer)) {
    if (!(amount > 0)) continue;
    projectInvoices += amount;
    byCustomer.set(customerId, (byCustomer.get(customerId) ?? 0) + amount);
  }
  let companiesTotal = 0;
  for (const v of byCustomer.values()) companiesTotal += v;
  return {
    total: subscriptionDues + projectInvoices,
    subscriptionDues,
    projectInvoices,
    byCustomer,
    companiesTotal,
    unlinked,
  };
}

/**
 * The line under a "to chase" figure: what it is made of and how it differs from
 * "Still owed" (billed invoices). Every tile that shows `total` uses this text.
 */
export function chaseNote(s: ToChaseSummary): string {
  const parts = [`Subscription dues ${rupee(s.subscriptionDues, { compact: true })}`];
  if (s.projectInvoices > 0) parts.push(`project invoices ${rupee(s.projectInvoices, { compact: true })}`);
  let note = parts.join(" + ");
  if (s.unlinked.value > 0) {
    const n = s.unlinked.count;
    note += ` · ${rupee(s.unlinked.value, { compact: true })} on ${n} subscription${n === 1 ? "" : "s"} with no company linked`;
  }
  return `${note} · may not be invoiced yet, so "Still owed" (invoices) can be lower`;
}
