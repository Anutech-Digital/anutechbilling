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
 * "Subscription dues X + project invoices Y" — the parts of a "to chase" figure, written one way
 * for every screen (dashboard note, Companies line). `linkedOnly` leaves out dues on subscriptions
 * with no company (they can never be on the Companies list), so the parts add up to companiesTotal.
 */
function chaseParts(s: ToChaseSummary, opts: { compact: boolean; linkedOnly: boolean }): string {
  const subDues = opts.linkedOnly ? s.subscriptionDues - s.unlinked.value : s.subscriptionDues;
  const parts = [`Subscription dues ${rupee(subDues, { compact: opts.compact })}`];
  if (s.projectInvoices > 0) parts.push(`project invoices ${rupee(s.projectInvoices, { compact: opts.compact })}`);
  return parts.join(" + ");
}

function unlinkedText(s: ToChaseSummary, compact: boolean): string {
  const n = s.unlinked.count;
  return `${rupee(s.unlinked.value, { compact })} on ${n} subscription${n === 1 ? "" : "s"} with no company linked`;
}

/**
 * The line under a "to chase" figure: what it is made of and how it differs from
 * "Still owed" (billed invoices). Every tile that shows `total` uses this text.
 */
export function chaseNote(s: ToChaseSummary): string {
  let note = chaseParts(s, { compact: true, linkedOnly: false });
  if (s.unlinked.value > 0) note += ` · ${unlinkedText(s, true)}`;
  return `${note} · may not be invoiced yet, so "Still owed" (invoices) can be lower`;
}

/**
 * R-1473 (7 Nov 2026, Pawan's ✗ Galat): the line over Companies › Has receivables. The list adds
 * up to the "To collect" tile — this says what it is made of, how much of it sits on ARCHIVED
 * companies (still owed, so still listed), and names any money the list cannot show: a company
 * not in the loaded list (`listedIds`), or a due on a subscription with no company. Whole rupees.
 */
export function toCollectBreakdown(
  s: ToChaseSummary,
  listedIds: ReadonlySet<string>,
  archivedIds: ReadonlySet<string>,
): string {
  let line = `${chaseParts(s, { compact: false, linkedOnly: true })} = ${rupee(s.companiesTotal)} to collect`;
  let archived = 0;
  let notListed = 0;
  let notListedValue = 0;
  for (const [id, amount] of s.byCustomer) {
    if (!listedIds.has(id)) { notListed++; notListedValue += amount; continue; }
    if (archivedIds.has(id)) archived++;
  }
  if (archived > 0) line += ` · includes ${archived} archived compan${archived === 1 ? "y" : "ies"}`;
  if (notListed > 0) {
    line += ` · ${rupee(notListedValue)} on ${notListed} compan${notListed === 1 ? "y" : "ies"} not in this list`;
  }
  if (s.unlinked.value > 0) line += ` · + ${unlinkedText(s, false)} (in the dashboard figure)`;
  return line;
}

/**
 * R-1473 (7 Nov 2026): Renewals shows subscription dues only — a project invoice is not a renewal.
 * Pawan added up the Renewals rows (₹44,746) against the dashboard (₹67,855) and could not find
 * the ₹23,109 project money. This line, under the Renewals title, gives the dues on the renewals
 * listed (`renewalDues` = subscriptionDue of the page's own rows) and, when Companies › Has
 * receivables (`all.companiesTotal`) is more, what makes up the rest. null = nothing to say.
 * `projectsUnread`: the project read failed — say so rather than silently leave it out.
 * R-2562: then the Companies › Has receivables figure is NOT named — without the project invoices
 * it is short by them, a wrong total that looks right. The page puts a Try again button after it.
 */
export function subscriptionDuesLine(
  all: ToChaseSummary,
  renewalDues: number,
  projectsUnread = false,
): string | null {
  const other = all.subscriptionDues - all.unlinked.value - renewalDues;
  if (renewalDues <= 0 && all.companiesTotal <= 0 && !projectsUnread) return null;
  let line = renewalDues > 0 ? `${rupee(renewalDues)} unpaid on these renewals` : "No renewal unpaid";
  if (projectsUnread) return `${line} · ${PROJECT_INVOICES_UNREAD}`;
  const rest: string[] = [];
  if (all.projectInvoices > 0) rest.push(`project invoices ${rupee(all.projectInvoices)}`);
  if (other > 0) rest.push(`${rupee(other)} on subscriptions not listed here`);
  if (rest.length > 0) line += ` · Companies › Has receivables ${rupee(all.companiesTotal)} also has ${rest.join(" + ")}`;
  return line;
}

/** R-2562: one wording wherever the project-receivables read failed (Renewals, Companies). */
export const PROJECT_INVOICES_UNREAD = "Project invoices couldn't be read";
/** R-2562: the same for the subscription-dues read on Companies › Has receivables. */
export const SUBSCRIPTION_DUES_UNREAD = "Subscription dues couldn't be read";
