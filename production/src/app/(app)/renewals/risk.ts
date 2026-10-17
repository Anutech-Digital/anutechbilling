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
import { rupee } from "@/lib/utils";
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
