/**
 * Renewal-risk score (0–100) for a subscription, from REAL data only.
 *
 * Was previously inflated with fabricated signals (admin-login / support-tickets /
 * NPS derived from an id hash) that looked like real churn intelligence to the
 * owner — removed, because showing invented reasons on a money screen is
 * misleading. This scores on what we actually know: how many seats are unused,
 * whether there's an unpaid balance, and the plan tier.
 *
 * R-453 (9 Oct 2026): seat usage counts ONLY when it was actually checked
 * (`used_synced_at` set by a seat sync). Nothing else in the app writes `used` — every
 * insert path writes 0 — so an unchecked row read as "Low seat usage (0%)" and was
 * marked HIGH RISK on a number nobody measured (Abhishek, Scenario 9, Gupta Infotech).
 * Unchecked usage now adds no score and says "Seat usage not checked".
 */
import { formatDate, rupee } from "@/lib/utils";
import { addDaysISO } from "@/lib/dates/ist";
import { chasedRenewal } from "./classify";
import type { Subscription } from "@/lib/supabase/database.types";
import { subscriptionDue } from "@/lib/accounting/receivables-due";

export interface RiskResult {
  score: number;
  level: "high" | "medium" | "low";
  /** Badge `kind` prop value */
  badgeKind: "danger" | "warning" | "success";
  label: string;
  reasons: string[];
}

type RiskFields = Pick<Subscription, "used" | "seats" | "outstanding_amount" | "plan" | "used_synced_at">
  & Partial<Pick<Subscription, "written_off_at">>;

export function renewalRisk(sub: RiskFields): RiskResult {
  let score = 0;
  const reasons: string[] = [];

  // Signal 1: Seat utilisation — unused seats are the strongest real churn tell.
  if (sub.used_synced_at) {
    const utilisation = (sub.used ?? 0) / Math.max(1, sub.seats);
    if (utilisation < 0.7) {
      score += 40;
      reasons.push(`Low seat usage (${Math.round(utilisation * 100)}%)`);
    } else if (utilisation < 0.85) {
      score += 20;
      reasons.push(`Moderate seat usage (${Math.round(utilisation * 100)}%)`);
    }
  } else {
    reasons.push("Seat usage not checked");
  }

  // Signal 2: Unpaid balance on the current term — a customer already behind on
  // payment is far more likely to lapse at renewal.
  /* R-1473: the same due the dashboard Collections card and Companies add up — a
     written-off balance is no longer "unpaid" here either (lib/accounting/receivables-due). */
  const due = subscriptionDue({
    customer_id: null, outstanding_amount: sub.outstanding_amount, written_off_at: sub.written_off_at,
  });
  if (due > 0) {
    score += 35;
    reasons.push(`Unpaid balance (${rupee(due, { compact: true })})`);
  }

  // Signal 3: Plan tier — lower tiers churn a little more.
  const plan = (sub.plan ?? "").toLowerCase();
  if (plan.includes("starter")) {
    score += 15;
    reasons.push("Lower-tier plan (Starter)");
  }

  score = Math.min(100, score);

  const level: RiskResult["level"] =
    score >= 55 ? "high" : score >= 25 ? "medium" : "low";
  const badgeKind: RiskResult["badgeKind"] =
    level === "high" ? "danger" : level === "medium" ? "warning" : "success";
  const label =
    level === "high" ? "HIGH RISK" : level === "medium" ? "Medium" : "Healthy";

  /* The "not checked" note is information, not a risk: keep it after the real reasons
     so the first reason shown on the row is a real one when there is one. */
  reasons.sort((a, b) => Number(a === "Seat usage not checked") - Number(b === "Seat usage not checked"));
  return { score, level, badgeKind, label, reasons };
}

/* ─── R-2756 (user audit 14 Nov, job 5/9): ONE day count + who can be "Top risk" ─────────────────
 * Greentin Check 2095: the row said "Part bill overdue 44d", the Renewal AI box "renewal 14d
 * overdue", and the date read 31 Oct (14 days ago) — the AI box counted from renewal_date, the row
 * from the part's due date. And a customer marked Won't renew became the header's "Top risk".
 * Now the AI box / Top risk read the row's OWN stage (lib/renewals/stage.ts, R-2738): its `days`
 * is the day count the chip shows, and the words name the date it counts from. A row the stage
 * calls ending (Won't renew / Ended), stopped (Service stopped / Cancelled / Paused / Expired) or
 * renewed is not a renewal to chase — never Top risk, no at-risk flag on its row (its ⋯ already
 * has no Nudge / Voice note: renewalPrimary). */

/** Stage keys that are not a renewal to chase (stage.ts renewalPrimary gives them no chase step). */
const NOT_CHASED_STAGES: ReadonlySet<string> = new Set(["ending", "stopped", "renewed"]);
const STOPPED_STATUS: ReadonlySet<string> = new Set(["cancelled", "paused", "expired", "suspended"]);

/** A renewal somebody should chase: not Won't renew, not stopped / cancelled / paused / expired. */
export function riskChased(sub: { auto_renew?: boolean | null; status?: string | null; renewal_state?: string | null }): boolean {
  if (!chasedRenewal(sub)) return false;   // R-2225 Won't renew (classify.ts — one rule)
  if (STOPPED_STATUS.has(sub.status ?? "")) return false;
  return sub.renewal_state !== "suspended";
}

/** The stage facts the day words read (a RenewalStage fits). */
export interface StageDays { key: string; days: number | null; renewalDays: number | null }

/**
 * The overdue words for a row, from its stage's own day count (the number on the chip), naming
 * what it counts from (the stage counts from a part's own due date when it differs, else from
 * renewal_date — stage.ts docWhen / invoiced):
 *   invoiced, part date  "Part bill overdue 44d (due 1 Oct 2026)"
 *   invoiced             "Invoice overdue 14d (due 31 Oct 2026)"
 *   other, part date     "Part due 44d ago (1 Oct 2026)"   (sent / draft part quote — no bill raised yet)
 *   other                "Renewal date passed 14d ago (31 Oct 2026)"
 * null = not overdue, no stage yet (documents still loading — never a guessed number), or a row
 * that is not chased.
 */
export function stageOverdueWords(stage: StageDays | null | undefined, todayIst: string): string | null {
  if (!stage || stage.days == null || stage.days >= 0 || NOT_CHASED_STAGES.has(stage.key)) return null;
  const late = -stage.days;
  const from = formatDate(addDaysISO(todayIst, stage.days));
  const partDate = stage.renewalDays !== stage.days;
  if (stage.key === "invoiced") return partDate ? `Part bill overdue ${late}d (due ${from})` : `Invoice overdue ${late}d (due ${from})`;
  return partDate ? `Part due ${late}d ago (${from})` : `Renewal date passed ${late}d ago (${from})`;
}

export interface TopRiskRow {
  sub: { auto_renew?: boolean | null; status?: string | null; renewal_state?: string | null };
  stage: StageDays | null;
  daysUntil: number;
  atRisk: boolean;
}

/** May this row carry the at-risk flag / be the AI box's pick? At risk, chased, and its stage is not ending / stopped / renewed. */
export function riskCandidate(r: TopRiskRow): boolean {
  return r.atRisk && riskChased(r.sub) && !(r.stage && NOT_CHASED_STAGES.has(r.stage.key));
}

/** The header's "Top risk" and the Renewal AI pick: the most overdue chased at-risk row (by the chip's day count). */
export function topRiskPick<T extends TopRiskRow>(rows: readonly T[]): T | null {
  const days = (r: T) => r.stage?.days ?? r.daysUntil;
  let best: T | null = null;
  for (const r of rows) {
    if (!riskCandidate(r)) continue;
    if (!best || days(r) < days(best)) best = r;
  }
  return best;
}

/** The AI box's reasons for its pick: the row's own overdue words, then the real risk signals. */
export function topRiskReasons(row: TopRiskRow & { sub: RiskFields }, todayIst: string): string[] {
  const when = stageOverdueWords(row.stage, todayIst);
  return [
    ...(when ? [when] : []),
    ...renewalRisk(row.sub).reasons.filter((x) => x !== "Seat usage not checked"),
  ];
}
