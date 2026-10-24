/**
 * Renewal cadence — pure functions, no I/O.
 *
 * Given a subscription's renewal_date + the tenant's grace_period_days,
 * compute what step the sub should be in TODAY and whether to send an
 * email. Idempotent — re-running on the same day is a no-op (the cron
 * checks renewal_email_log before sending).
 *
 * Cadence (in "days until renewal" form):
 *   d ≥ 31        → 'pending'        no email
 *   d == 30       → 'early_notice'   early heads-up (migration 0228)
 *   d == 15       → 'notice_sent'    soft notice + PDF quote attached
 *   d == 12       → 'reminder_1'     soft reminder
 *   d == 9        → 'reminder_2'     friendly
 *   d == 6        → 'reminder_3'     firm
 *   d == 3        → 'reminder_4'     urgent — service interruption ahead
 *   d == 0        → 'final_sent'     final notice + suspension warning
 *   d ∈ (−grace,−1] → 'grace_period' grace reminder (only if grace > 0)
 *   d < −grace    → 'suspended'      auto-suspend, no email
 *
 * R-1621: 'suspended' + shouldSuspend means GRACE IS OVER. The cron no longer pauses the
 * subscription by itself — it raises ONE "Stop service" task for the owner, who stops it
 * (renewal_grace_decide 'stop') or gives more days. graceDays is effectiveGraceDays().
 */

import { addDaysISO, daysBetweenISO, toIstDate } from "@/lib/dates/ist";

export type RenewalState =
  | "pending"
  /** T-30 early heads-up. Requires migration 0228 to exist in the DB enum. */
  | "early_notice"
  | "notice_sent"
  | "reminder_1"
  | "reminder_2"
  | "reminder_3"
  | "reminder_4"
  | "final_sent"
  | "grace_period"
  | "renewed"
  | "suspended";

export type CadenceTone = "early" | "soft" | "friendly" | "firm" | "urgent" | "final" | "grace";

/**
 * Trigger map — which day before renewal triggers which step.
 *
 * MUST STAY IN DESCENDING daysOut ORDER. decideCadence() walks this list to find
 * the most-urgent trigger that should already have fired (the catch-up rule for a
 * cron that missed a day), and that scan assumes the ordering.
 *
 * T-30 was added last (migration 0228) and is a heads-up, not a chase: an annual
 * Workspace renewal often needs a PO raised or a budget signed off, and a
 * fortnight is not enough room for that during a quarter close.
 */
export const CADENCE_TRIGGERS: { daysOut: number; step: RenewalState; tone: CadenceTone }[] = [
  { daysOut: 30, step: "early_notice", tone: "early"    },
  { daysOut: 15, step: "notice_sent",  tone: "soft"     },
  { daysOut: 12, step: "reminder_1",   tone: "soft"     },
  { daysOut:  9, step: "reminder_2",   tone: "friendly" },
  { daysOut:  6, step: "reminder_3",   tone: "firm"     },
  { daysOut:  3, step: "reminder_4",   tone: "urgent"   },
  { daysOut:  0, step: "final_sent",   tone: "final"    },
];

/**
 * The same ladder will not do for a MONTHLY subscription, and the reason is arithmetic
 * rather than taste: on a 30-day cycle, T-30 lands on the day the previous term renewed.
 * Applying the annual table would put a customer on seven emails every month, permanently
 * — which is not a reminder system, it is a reason to mark the sender as spam and stop
 * seeing the one email that mattered.
 *
 * Three touches, using the same states so the stored renewal_state vocabulary and the
 * linear progression are unchanged:
 *
 *   T-7  a week's notice — enough to arrange payment, not enough to forget
 *   T-3  the chase
 *   T-0  the day itself
 *
 * A monthly bill is a recurring event rather than a decision to re-take, so it does not
 * need the budget-and-PO runway that the 30-day annual notice exists for.
 */
export const MONTHLY_CADENCE_TRIGGERS: { daysOut: number; step: RenewalState; tone: CadenceTone }[] = [
  { daysOut: 7, step: "notice_sent",  tone: "soft"   },
  { daysOut: 3, step: "reminder_4",   tone: "urgent" },
  { daysOut: 0, step: "final_sent",   tone: "final"  },
];

/** `subscriptions.billing_cycle` — how often the customer is INVOICED. */
export type BillingCycle = "monthly" | "quarterly" | "half_yearly" | "yearly";

/**
 * Which ladder applies — decided by the length of the TERM, not by how often the customer
 * is invoiced. Those are different things, and this codebase already separates them
 * (migration 0161): `commitment` is the price tier, `billing_cycle` is the invoice
 * frequency. Two shapes make the distinction unavoidable:
 *
 *   flex monthly     term 1 month,  invoiced monthly  → renews every month
 *   annual, paid monthly  term 12 months, invoiced monthly  → renews once a year
 *
 * The second is an ordinary Google Workspace arrangement: the customer is committed for a
 * year and pays in twelve instalments. Keying the ladder off billing_cycle would hand that
 * customer the three-touch monthly schedule for a decision that ends a YEAR-long
 * commitment — no 30-day runway to raise a PO or get a budget signed off, which is the
 * entire reason T-30 exists. I keyed it off billing_cycle first and Pardeep named this case
 * before it shipped.
 *
 * Quarterly and half-yearly terms keep the annual ladder on purpose: T-30 is a sensible
 * heads-up on a 90- or 180-day term, and two more schedules nobody has asked for would be
 * more behaviour to keep true than it is worth.
 */
export function triggersForTerm(termMonths: number | null | undefined) {
  /* Only a one-month term. A null term is treated as annual, which is both the column
     default and the behaviour every caller had before this existed. */
  return termMonths === 1 ? MONTHLY_CADENCE_TRIGGERS : CADENCE_TRIGGERS;
}

/**
 * R-1621 — how many grace days THIS subscription gets after its renewal date.
 *
 *   trusted customer's own grace (customers.trusted_grace_days, owner/manager set it)
 *   else the company's grace (tenants.grace_period_days — 7 for a new company)
 *   and, when the owner pressed "+N days" this term, at least up to subscriptions.grace_until.
 *
 * A grace_until on or before the renewal date belongs to an earlier term and is ignored.
 * The SAME rule is in SQL (raise_renewal_grace_task / renewal_grace_decide, migration
 * 20261023131000) — change both or neither.
 */
export function effectiveGraceDays(input: {
  tenantGraceDays:   number | null | undefined;
  trustedGraceDays?: number | null;
  renewalDate:       Date | string;
  graceUntil?:       string | null;
}): number {
  const base = Math.max(0, input.trustedGraceDays ?? input.tenantGraceDays ?? 0);
  if (!input.graceUntil) return base;
  const extra = daysBetweenISO(isoDay(input.renewalDate), input.graceUntil);
  return extra > 0 ? Math.max(base, extra) : base;
}

/**
 * R-1621 — the IST date the service stops if the renewal is still unpaid: the day after the
 * last grace day. The final and grace mails state it, so the customer knows the exact day.
 * Stopping itself is the owner's decision (a task on that day), never automatic.
 */
export function serviceStopDate(renewalDate: Date | string, graceDays: number): string {
  return addDaysISO(isoDay(renewalDate), Math.max(0, graceDays) + 1);
}

/** 'YYYY-MM-DD' of a renewal date — a date column string as is, an instant by its IST day. */
function isoDay(d: Date | string): string {
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : toIstDate(d);
}

/** Days between two dates (calendar, IST-aware). Positive when `to` is in the future. */
export function daysBetween(from: Date, to: Date): number {
  // Snap both to IST midnight then diff
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  const fromIST = Math.floor((from.getTime() + istOffsetMs) / dayMs);
  const toIST   = Math.floor((to.getTime()   + istOffsetMs) / dayMs);
  return toIST - fromIST;
}

export interface CadenceDecision {
  /** What state the subscription should be in today. */
  targetState: RenewalState;
  /** Days until renewal (positive = future, 0 = today, negative = past). */
  daysUntilRenewal: number;
  /** True if today triggers a NEW email (not previously sent for this step). */
  shouldSendEmail: boolean;
  /** Suggested tone for the email template. */
  tone: CadenceTone | null;
  /** True if today's cron should auto-suspend this subscription. */
  shouldSuspend: boolean;
}

export interface CadenceInput {
  renewalDate:      Date | string;      // subscription.renewal_date
  graceDays:        number;             // effectiveGraceDays() — R-1621 (trusted customer / +N days)
  currentState:     RenewalState;       // subscription.renewal_state
  /**
   * subscription.term_months — how long one term is, which is what decides the reminder
   * ladder. NOT billing_cycle: an annual plan paid monthly is invoiced twelve times and
   * renews once, and it needs the annual runway. Omitted means annual, the behaviour every
   * caller had before this parameter existed.
   */
  termMonths?:      number | null;
  today?:           Date;               // override for testing
}

/**
 * Compute what should happen today for one subscription.
 */
export function decideCadence(input: CadenceInput): CadenceDecision {
  const today = input.today ?? new Date();
  const renewalAt = input.renewalDate instanceof Date
    ? input.renewalDate
    : new Date(input.renewalDate);

  const daysOut = daysBetween(today, renewalAt);

  // Past renewal_date — grace or suspend
  if (daysOut < 0) {
    const daysIntoGrace = Math.abs(daysOut);
    if (daysIntoGrace <= input.graceDays) {
      return {
        targetState:    "grace_period",
        daysUntilRenewal: daysOut,
        /* R-1562: 'renewed' is the START of a term (see isTerminal below), so it gets the
           grace notice like any step that has not reached grace yet. */
        shouldSendEmail: input.currentState !== "grace_period" && input.currentState !== "suspended",
        tone:           "grace",
        shouldSuspend:  false,
      };
    }
    /* R-1562: 'renewed' with renewal_date already past grace means this term was never
       chased at all (the cron was off, or the row sat in the old dead end). Never suspend a
       customer who was not told once: send the final notice now; if it stays unpaid, the
       next run (state final_sent) suspends as usual. */
    if (input.currentState === "renewed") {
      return {
        targetState:      "final_sent",
        daysUntilRenewal: daysOut,
        shouldSendEmail:  true,
        tone:             "final",
        shouldSuspend:    false,
      };
    }
    return {
      targetState:    "suspended",
      daysUntilRenewal: daysOut,
      shouldSendEmail: false,        // no email on hard suspend
      tone:           null,
      shouldSuspend:  input.currentState !== "suspended",
    };
  }

  // Future — CATCH-UP match (audit bug #21): fire the most-urgent cadence
  // trigger that should have fired by today — the trigger with the smallest
  // daysOut still ≥ today's daysOut. So a missed cron day (outage / deploy) or
  // a renewal_date nudged onto a non-trigger day (T-2, T-1) still fires the
  // right reminder instead of being silently skipped until T-0.
  //
  // We never resend a step already reached: cadence state progresses linearly
  // through CADENCE_TRIGGERS, so we only send when the target step is MORE
  // advanced (higher index) than the current state. The cron's
  // renewal_email_log adds a second, independent (sub, step) idempotency guard.
  const triggers = triggersForTerm(input.termMonths);
  const reached = triggers.filter((t) => daysOut <= t.daysOut);
  const trigger = reached.length > 0 ? reached[reached.length - 1] : null;
  if (trigger) {
    /* Rank WITHIN the active ladder. Ranking against the annual table while running the
       monthly one would compare positions from two different lists, and a monthly
       subscription sitting at notice_sent (index 1 of 7 there, 0 of 3 here) would be read
       as further along than it is and skip its own reminders. */
    const rankOf = (s: RenewalState) => triggers.findIndex((t) => t.step === s);
    /* R-1562: only 'suspended' is terminal. 'renewed' was too, and that was a money leak:
       record_payment writes it in the same UPDATE that rolls renewal_date one term on
       (20261011120000_r718_money_roles.sql ~1800), so every trigger reached from here
       belongs to the NEW term — which then got no reminder, no renewal quote and no
       grace/suspend, for good. 'renewed' is not on the ladder, so it ranks -1 like
       'pending' and the first reached step fires. */
    const isTerminal = input.currentState === "suspended";
    return {
      targetState:      trigger.step,
      daysUntilRenewal: daysOut,
      shouldSendEmail:  !isTerminal && rankOf(trigger.step) > rankOf(input.currentState),
      tone:             trigger.tone,
      shouldSuspend:    false,
    };
  }

  // Before the first trigger (d ≥ 31 since 0228 added T-30) — pending, no email
  return {
    targetState:      "pending",
    daysUntilRenewal: daysOut,
    shouldSendEmail:  false,
    tone:             null,
    shouldSuspend:    false,
  };
}

/** Days before renewal_date the first reminder of a term goes out: T-30, or T-7 on a one-month term. */
export function firstReminderDaysOut(termMonths: number | null | undefined): number {
  return triggersForTerm(termMonths)[0].daysOut;
}

/**
 * R-1562 — "paid for this term, nothing due yet". True only while the state is 'renewed'
 * AND the new term's first reminder is still ahead. The manual buttons (Generate quote,
 * Send now) and the bulk reminder hold back on exactly this, instead of on the bare
 * 'renewed' state — which would hold them back for every term after the first paid one.
 */
export function renewalIsSettled(
  state: string | null | undefined,
  renewalDate: Date | string | null | undefined,
  termMonths: number | null | undefined,
  today: Date = new Date(),
): boolean {
  if (state !== "renewed" || !renewalDate) return false;
  const at = renewalDate instanceof Date ? renewalDate : new Date(renewalDate);
  return daysBetween(today, at) > firstReminderDaysOut(termMonths);
}

/**
 * R-1562 — the cron re-opens a paid row for its new term: 'renewed' and today's decision
 * is past 'pending' (a reminder, grace or final notice is due). The cron writes 'pending'
 * first, so the Renewals screen and Today inbox show the row even if the email fails.
 */
export function reopensForNewTerm(state: string | null | undefined, decision: CadenceDecision): boolean {
  return state === "renewed" && decision.targetState !== "pending";
}

/** Friendly label for a renewal state, for UI badges. */
export function renewalStateLabel(state: RenewalState): string {
  switch (state) {
    case "pending":      return "Pending";
    case "early_notice": return "Early notice (T-30)";
    case "notice_sent":  return "Notice sent (T-15)";
    case "reminder_1":   return "Reminder 1 (T-12)";
    case "reminder_2":   return "Reminder 2 (T-9)";
    case "reminder_3":   return "Reminder 3 (T-6)";
    case "reminder_4":   return "Urgent (T-3)";
    case "final_sent":   return "Final notice";
    case "grace_period": return "Grace period";
    case "renewed":      return "Renewed";
    case "suspended":    return "Suspended";
  }
}

/** Color hint for badge rendering. */
export function renewalStateTone(state: RenewalState): "muted" | "info" | "warning" | "danger" | "success" {
  switch (state) {
    case "pending":
    case "renewed":      return "muted";
    // T-30 is a heads-up, not a chase — it must not look like a warning.
    case "early_notice": return "info";
    case "notice_sent":
    case "reminder_1":   return "info";
    case "reminder_2":
    case "reminder_3":   return "warning";
    case "reminder_4":
    case "final_sent":
    case "grace_period": return "danger";
    case "suspended":    return "danger";
  }
}
