/**
 * R-1124 — ONE classification of the rows on /renewals, used by every number and list there.
 *
 * Audit 12 Oct + Pawan on staging 16 Oct: the header said "₹2.6L yearly value at risk" while
 * the High risk ARR card said ₹0 (the header summed EVERY row), a subscription "Expired 7d
 * ago" sat under "Urgent · Next 7 days", and Bulk reminder skipped the lapsed rows — the ones
 * closest to losing the service. Now:
 *
 *   expired   renewal date passed, not stopped        — its own "Expired · in grace" group
 *   due7      renews today .. +7 days                 — "Next 7 days"
 *   upcoming  +8 .. +30, future +31 .. +90            — as before (lib/renewals/buckets.ts)
 *   stopped   renewal date passed and suspended        — "Service stopped"
 *
 * The Urgent TAB still holds expired + due7 + stopped: the sidebar badge counts exactly that
 * (R-1541, nav_badges() and nav-badge-parity.test.ts) and opens ?bucket=urgent. Inside the tab
 * the three are separate groups, so nothing lapsed is listed under "Next 7 days".
 *
 * At risk = every expired row (unpaid past its renewal date) + any row up to 90 days out the
 * risk score marks high — minus renewals already paid. The header's "at risk" and the High
 * risk card/tab are this one set, so they cannot disagree again.
 */
import { renewalBucket } from "@/lib/renewals/buckets";
import { effectiveGraceDays, serviceStopDate } from "@/lib/renewals/cadence";
import { formatIstDate } from "@/lib/dates/ist";
import { isTerminalRenewal } from "./reminders";

export interface ClassifySub {
  renewal_state?: string | null;
  renewal_date: string | null;
  term_months?: number | null;
  status?: string | null;
  mrr: number;
  grace_until?: string | null;
}

export interface ClassifyRow<S extends ClassifySub = ClassifySub> {
  sub: S;
  daysUntil: number;
}

export interface RenewalGroups<T> {
  expired:  T[];
  due7:     T[];
  upcoming: T[];
  future:   T[];
  stopped:  T[];
  /** expired + due7 + stopped — the Urgent tab and the sidebar badge (R-1541). */
  urgentTab: T[];
  atRisk:   T[];
  /** Yearly value (MRR × 12) of `atRisk` — the header figure AND the High risk card. */
  atRiskArr: number;
}

export function isStopped(sub: ClassifySub): boolean {
  return sub.renewal_state === "suspended" || sub.status === "suspended";
}

export function classifyRenewals<T extends ClassifyRow>(
  rows: readonly T[],
  isHighRisk: (row: T) => boolean,
  today: Date = new Date(),
): RenewalGroups<T> {
  const g: RenewalGroups<T> = {
    expired: [], due7: [], upcoming: [], future: [], stopped: [], urgentTab: [], atRisk: [], atRiskArr: 0,
  };
  for (const r of rows) {
    if (r.daysUntil < 0) {
      (isStopped(r.sub) ? g.stopped : g.expired).push(r);
    } else {
      const b = renewalBucket(r.daysUntil);
      if (b === "urgent") g.due7.push(r);
      else if (b === "upcoming") g.upcoming.push(r);
      else if (b === "future") g.future.push(r);
    }
  }
  g.urgentTab = [...g.expired, ...g.due7, ...g.stopped];
  const paid = (r: T) => isTerminalRenewal(r.sub.renewal_state, r.sub.renewal_date, r.sub.term_months, today);
  g.atRisk = [
    ...g.expired.filter((r) => !paid(r)),
    ...[...g.due7, ...g.upcoming, ...g.future].filter((r) => !paid(r) && isHighRisk(r)),
  ];
  g.atRiskArr = g.atRisk.reduce((s, r) => s + r.sub.mrr * 12, 0);
  return g;
}

/**
 * The line under an expired row: the real IST date the service stops (company grace, or the
 * owner's "+N days"), or that the grace is over and the owner decides (R-1621 — nothing
 * stops by itself). A trusted customer may have more days; the Grace over list is the truth.
 */
export function expiredGraceText(
  sub: Pick<ClassifySub, "renewal_date" | "grace_until">,
  daysUntil: number,
  tenantGraceDays: number,
): string | null {
  if (daysUntil >= 0 || !sub.renewal_date) return null;
  const grace = effectiveGraceDays({
    tenantGraceDays, renewalDate: sub.renewal_date, graceUntil: sub.grace_until ?? null,
  });
  if (Math.abs(daysUntil) > grace) return "Grace over — owner decides (Grace over list)";
  return `In grace · service stops ${formatIstDate(serviceStopDate(sub.renewal_date, grace))} if unpaid`;
}
