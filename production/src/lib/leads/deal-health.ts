/**
 * Deal Health Score, 0–100 — is this deal being WORKED well?
 *
 * ─── THIS IS NOT heat-score.ts, AND THE DIFFERENCE IS THE WHOLE POINT ───────
 * `heatScore` answers "how good is this lead": company domain, seat count, source. Those
 * are facts about WHO the customer is, and a rep cannot change any of them.
 *
 * This answers "is this deal in good shape": has anybody touched it, is it moving, has
 * the customer replied, is there a next step booked. Every input is something the rep
 * controls, and a low score is a to-do rather than a verdict.
 *
 * A ₹5L Tata Motors deal nobody has called in three weeks scores HIGH on heat and LOW on
 * health, and that combination — good lead, badly worked — is the single most useful
 * thing either number can surface. Collapsing them into one score would hide exactly
 * that case, which is why there are two.
 *
 * ─── IT IS ARITHMETIC, AND IT SAYS SO ───────────────────────────────────────
 * The brief calls this an "AI Deal Health Score". Touch frequency, deal age, stage
 * movement and whether a follow-up is booked are counts and comparisons — there is no
 * judgement in them for a model to add, GEMINI_API_KEY is unset on this project, and
 * every AI route here falls back to a deterministic stub when it is missing. An "AI
 * score" would therefore have been the stub wearing an AI label. Computed locally,
 * named for what it is, every input testable.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { daysInStage, STAGE_SLA_DAYS } from "./velocity";
import { isOpenStage } from "./forecast";

/** Weights, summing to 100. Named so a disagreement is a one-line change. */
export const HEALTH_WEIGHT = {
  recentTouch: 35,   // has anybody spoken to them lately
  movement:    30,   // is the deal advancing, or parked
  nextStep:    20,   // is the next contact booked
  responded:   15,   // has the customer engaged back
} as const;

export type HealthBand = "healthy" | "slipping" | "at_risk" | "unknown";

export interface DealHealth {
  score: number;
  band: HealthBand;
  parts: { recentTouch: number; movement: number; nextStep: number; responded: number };
  /** Plain-language, ordered worst-first — this doubles as the to-do list. */
  issues: string[];
  /** True when a component could not be measured, so the score is a floor. */
  incomplete: boolean;
}

export const AT_RISK_BELOW  = 40;
export const SLIPPING_BELOW = 70;

/** Days since the most recent activity of any kind. Null when nothing is recorded. */
function daysSinceTouch(lastActivityAt: string | null | undefined, now: Date): number | null {
  if (!lastActivityAt) return null;
  const t = new Date(lastActivityAt).getTime();
  if (Number.isNaN(t)) return null;
  const diff = now.getTime() - t;
  return diff < 0 ? 0 : Math.floor(diff / 86_400_000);
}

type HealthLead = Pick<Lead, "stage" | "follow_up_date"> & {
  stage_changed_at?: string | null;
  /** When the lead arrived — a lead under a day old gets the grace below. */
  created_at?: string | null;
};

/** Under 24 h since the lead arrived (R-490). A future stamp (clock skew) counts as new. */
export function isFirstDay(createdAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return now.getTime() - t < 86_400_000;
}

export interface HealthInput {
  lead: HealthLead;
  /** Newest lead_activities.created_at, if any. */
  lastActivityAt?: string | null;
  /** True when at least one inbound activity exists (email_in, or a customer reply). */
  customerResponded?: boolean;
  today?: string;   // YYYY-MM-DD, for the next-step check
}

/**
 * Score the deal.
 *
 * Every component that cannot be measured scores ZERO and is named in `issues`, and the
 * result is flagged `incomplete`. Scoring an unmeasurable component as full marks would
 * make the worst-documented deals look the healthiest.
 */
export function dealHealth(input: HealthInput, now: Date = new Date()): DealHealth {
  const { lead } = input;
  const issues: string[] = [];
  let incomplete = false;
  /* R-490 (Abhishek, R-456): a 2-minute-old website lead read "At risk of going cold".
     Nobody can have called, moved or heard back from a lead that just arrived, so on its
     first day those three are not held against it. The follow-up check stays — booking
     the next step is the one thing that should happen on day one. */
  const firstDay = isFirstDay(lead.created_at, now);

  // 1. Recent touch — full marks inside a week, nothing after a fortnight.
  const touchDays = daysSinceTouch(input.lastActivityAt, now);
  let recentTouch: number;
  if (touchDays === null && firstDay) {
    recentTouch = HEALTH_WEIGHT.recentTouch;
  } else if (touchDays === null) {
    recentTouch = 0;
    incomplete = true;
    issues.push("Nobody has logged a call, WhatsApp or email on this deal.");
  } else if (touchDays <= 7) {
    recentTouch = HEALTH_WEIGHT.recentTouch;
  } else if (touchDays >= 14) {
    recentTouch = 0;
    issues.push(`No contact for ${touchDays} days.`);
  } else {
    recentTouch = Math.round(HEALTH_WEIGHT.recentTouch * ((14 - touchDays) / 7));
    issues.push(`Last contact was ${touchDays} days ago.`);
  }

  // 2. Movement — is it advancing, or parked in one stage?
  const stageDays = daysInStage(lead, now);
  let movement: number;
  if (stageDays === null && firstDay) {
    movement = HEALTH_WEIGHT.movement;
  } else if (stageDays === null) {
    movement = 0;
    incomplete = true;
    issues.push("No stage-change date recorded yet, so movement cannot be judged.");
  } else if (stageDays < STAGE_SLA_DAYS) {
    movement = HEALTH_WEIGHT.movement;
  } else if (stageDays >= STAGE_SLA_DAYS * 3) {
    movement = 0;
    issues.push(`Parked in the same stage for ${stageDays} days.`);
  } else {
    const span = STAGE_SLA_DAYS * 2;
    movement = Math.round(HEALTH_WEIGHT.movement * ((STAGE_SLA_DAYS * 3 - stageDays) / span));
    issues.push(`${stageDays} days in the same stage.`);
  }

  // 3. Next step booked — a deal with no next contact is a deal being forgotten.
  const today = input.today ?? "";
  const nextStep = lead.follow_up_date && (!today || lead.follow_up_date >= today)
    ? HEALTH_WEIGHT.nextStep : 0;
  if (nextStep === 0) {
    issues.push(lead.follow_up_date
      ? "The follow-up date has passed and no new one is set."
      : "No follow-up booked.");
  }

  // 4. Has the customer engaged back at all?
  const responded = input.customerResponded || firstDay ? HEALTH_WEIGHT.responded : 0;
  if (responded === 0) issues.push("No reply from the customer yet.");

  const score = recentTouch + movement + nextStep + responded;

  /* A closed deal has no health — it is finished. Reporting `at_risk` on a won deal
     would train people to ignore the badge. */
  const band: HealthBand = !isOpenStage(lead.stage)
    ? "unknown"
    : score < AT_RISK_BELOW ? "at_risk"
    : score < SLIPPING_BELOW ? "slipping"
    : "healthy";

  return {
    score, band, incomplete,
    parts: { recentTouch, movement, nextStep, responded },
    issues,
  };
}

export function healthBadge(h: DealHealth): { label: string; kind: "danger" | "warning" | "success" | "muted" } {
  if (h.band === "unknown") return { label: "—", kind: "muted" };
  return {
    label: `${h.score}${h.incomplete ? "+" : ""}`,
    kind: h.band === "at_risk" ? "danger" : h.band === "slipping" ? "warning" : "success",
  };
}
