import { describe, it, expect } from "vitest";
import { decideCadence, type RenewalState } from "./cadence";

// Fixed "today" = 1 Aug 2026, 11:30 IST. Renewal dates below are date-only, so
// daysBetween (IST-snapped) yields the exact daysOut noted in each case.
const TODAY = new Date("2026-08-01T06:00:00Z");

function decide(renewalDate: string, currentState: RenewalState, graceDays = 5) {
  return decideCadence({ renewalDate, graceDays, currentState, today: TODAY });
}

describe("decideCadence — normal cadence", () => {
  it("T-15, pending → sends the notice", () => {
    const d = decide("2026-08-16", "pending"); // daysOut 15
    expect(d.targetState).toBe("notice_sent");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("T-0 (renewal today), reminder_4 → sends the final notice", () => {
    const d = decide("2026-08-01", "reminder_4"); // daysOut 0
    expect(d.targetState).toBe("final_sent");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("far out (d ≥ 31) → pending, no email", () => {
    // Was "d ≥ 16" with a 19-day case. Migration 0228 opened the cadence at
    // T-30, so 19 days out now legitimately fires the early notice — the old
    // assertion was describing the old ladder, not a broken one.
    const d = decide("2026-09-20", "pending"); // daysOut 50
    expect(d.targetState).toBe("pending");
    expect(d.shouldSendEmail).toBe(false);
  });
});

describe("decideCadence — T-30 early notice (migration 0228)", () => {
  it("T-30 exactly → early_notice, one email", () => {
    const d = decide("2026-08-31", "pending"); // daysOut 30
    expect(d.targetState).toBe("early_notice");
    expect(d.tone).toBe("early");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("T-31 is still too early", () => {
    const d = decide("2026-09-01", "pending"); // daysOut 31
    expect(d.targetState).toBe("pending");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("catch-up: a cron that missed T-30 still sends it at T-22", () => {
    // Same catch-up rule the rest of the ladder uses — an outage or a deploy
    // must not silently swallow a step.
    const d = decide("2026-08-23", "pending"); // daysOut 22
    expect(d.targetState).toBe("early_notice");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("does not resend the early notice once it has been sent", () => {
    const d = decide("2026-08-25", "early_notice"); // daysOut 24
    expect(d.targetState).toBe("early_notice");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("T-15 still fires after the early notice — the ladder advances", () => {
    // The reason early_notice needed its OWN enum value: folding T-30 into
    // 'notice_sent' would make this look already-sent and skip the real notice.
    const d = decide("2026-08-16", "early_notice"); // daysOut 15
    expect(d.targetState).toBe("notice_sent");
    expect(d.shouldSendEmail).toBe(true);
  });

  /* R-1562: this said "renewed never gets an early notice" — and that was the money leak.
     record_payment writes 'renewed' while rolling renewal_date one term on, so a renewed
     row at T-30 is at T-30 of its NEW term and must be told. A renewed row with its new
     date still far off stays quiet (renewed-rearm.test.ts). */
  it("a renewed subscription gets the NEW term's early notice at T-30", () => {
    const d = decide("2026-08-31", "renewed");
    expect(d.targetState).toBe("early_notice");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("a renewed subscription far from its new date stays quiet", () => {
    const d = decide("2027-08-01", "renewed");
    expect(d.targetState).toBe("pending");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("T-30 does not suspend anything", () => {
    expect(decide("2026-08-31", "pending").shouldSuspend).toBe(false);
  });
});

describe("decideCadence — catch-up (audit bug #21)", () => {
  it("RN-04: T-15 cron missed, runs at T-12 with state still pending → fires the current-urgency reminder, not the stale notice", () => {
    const d = decide("2026-08-13", "pending"); // daysOut 12
    expect(d.targetState).toBe("reminder_1");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("RN-05: renewal_date nudged to a non-trigger day (T-2), only the notice was ever sent → still fires the urgent reminder (old exact-match code skipped this)", () => {
    const d = decide("2026-08-03", "notice_sent"); // daysOut 2 (between T-3 and T-0)
    expect(d.targetState).toBe("reminder_4");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("missed T-6: at T-5 with state reminder_2 → catches up to reminder_3", () => {
    const d = decide("2026-08-06", "reminder_2"); // daysOut 5 (between T-6 and T-3)
    expect(d.targetState).toBe("reminder_3");
    expect(d.shouldSendEmail).toBe(true);
  });
});

describe("decideCadence — idempotency & no-op", () => {
  it("already at the reached step → no resend", () => {
    const d = decide("2026-08-04", "reminder_4"); // daysOut 3 == T-3, already reminder_4
    expect(d.targetState).toBe("reminder_4");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("between triggers, already at the reached step → no email, state stable", () => {
    const d = decide("2026-08-08", "reminder_2"); // daysOut 7 (between T-9 and T-6)
    expect(d.targetState).toBe("reminder_2");
    expect(d.shouldSendEmail).toBe(false);
  });

  it("R-1562: 'renewed' near a trigger day re-enters the cadence for the new term (catch-up)", () => {
    const d = decide("2026-08-03", "renewed"); // daysOut 2
    expect(d.targetState).toBe("reminder_4");
    expect(d.shouldSendEmail).toBe(true);
  });

  it("'suspended' stays terminal near a trigger day", () => {
    expect(decide("2026-08-03", "suspended").shouldSendEmail).toBe(false);
  });
});

describe("decideCadence — past renewal (grace / suspend)", () => {
  it("within grace → grace reminder once", () => {
    const d = decide("2026-07-30", "final_sent", 5); // daysOut -2, grace 5
    expect(d.targetState).toBe("grace_period");
    expect(d.shouldSendEmail).toBe(true);
    expect(d.shouldSuspend).toBe(false);
  });

  it("past grace → suspend, no email", () => {
    const d = decide("2026-07-20", "grace_period", 5); // daysOut -12, grace 5
    expect(d.targetState).toBe("suspended");
    expect(d.shouldSuspend).toBe(true);
    expect(d.shouldSendEmail).toBe(false);
  });
});

/* ── Monthly subscriptions (22 Aug 2026) ─────────────────────────────────────
   A tester's monthly Google Workspace sale produced no subscription at all; once it did,
   the question became which reminders it should get. The annual ladder is not merely
   noisy on a 30-day cycle — T-30 lands on the day the PREVIOUS term renewed, so the
   customer would be on seven emails a month, for ever. */
import { triggersForTerm, MONTHLY_CADENCE_TRIGGERS, CADENCE_TRIGGERS } from "./cadence";

describe("the ladder depends on the billing cycle", () => {
  it("gives monthly its own, shorter ladder", () => {
    expect(triggersForTerm(1)).toBe(MONTHLY_CADENCE_TRIGGERS);
    expect(triggersForTerm(1).map((t) => t.daysOut)).toEqual([7, 3, 0]);
  });

  it("leaves every other cycle on the annual ladder", () => {
    /* Quarterly (90 days) and half-yearly (180) are fine with a 30-day heads-up, and
       inventing two more schedules nobody asked for is more code to keep true than it is
       worth. Asserted so that decision is visible rather than an omission. */
    for (const t of [3, 6, 12, null, undefined] as const) {
      expect(triggersForTerm(t), String(t)).toBe(CADENCE_TRIGGERS);
    }
  });
});

describe("a monthly subscription's reminders", () => {
  const at = (daysOut: number, currentState: RenewalState = "pending") => {
    const today = new Date("2026-09-01T06:00:00Z");
    const renewal = new Date(today);
    renewal.setUTCDate(renewal.getUTCDate() + daysOut);
    return decideCadence({
      renewalDate: renewal, graceDays: 7, currentState,
      termMonths: 1, today,
    });
  };

  it("says nothing three weeks out", () => {
    /* THE WHOLE POINT. On the annual ladder T-30 and T-15 would both have fired by now,
       and on a 30-day cycle T-30 is the day the last term renewed. */
    expect(at(21).shouldSendEmail).toBe(false);
    expect(at(21).targetState).toBe("pending");
    expect(at(10).shouldSendEmail).toBe(false);
  });

  it("gives a week's notice, then chases, then the day itself", () => {
    expect(at(7).targetState).toBe("notice_sent");
    expect(at(7).shouldSendEmail).toBe(true);
    expect(at(3, "notice_sent").targetState).toBe("reminder_4");
    expect(at(3, "notice_sent").shouldSendEmail).toBe(true);
    expect(at(0, "reminder_4").targetState).toBe("final_sent");
    expect(at(0, "reminder_4").shouldSendEmail).toBe(true);
  });

  it("sends at most three emails in a cycle, not seven", () => {
    /* Counted rather than asserted by eye: a monthly customer getting the annual ladder
       receives seven emails every month. */
    let sent = 0;
    let state: RenewalState = "pending";
    for (let d = 30; d >= 0; d--) {
      const decision = at(d, state);
      if (decision.shouldSendEmail) sent += 1;
      state = decision.targetState;
    }
    expect(sent).toBe(3);
  });

  it("does not resend a step it has already reached", () => {
    expect(at(7, "notice_sent").shouldSendEmail).toBe(false);
    expect(at(3, "reminder_4").shouldSendEmail).toBe(false);
  });

  it("still falls into grace and then suspension after the date", () => {
    /* The tail of the machine is cycle-independent and must not have been disturbed. */
    expect(at(-2, "final_sent").targetState).toBe("grace_period");
    expect(at(-30, "grace_period").targetState).toBe("suspended");
    expect(at(-30, "grace_period").shouldSuspend).toBe(true);
  });

  it("counts the annual ladder as seven, for contrast", () => {
    let sent = 0;
    let state: RenewalState = "pending";
    const today = new Date("2026-09-01T06:00:00Z");
    for (let d = 40; d >= 0; d--) {
      const renewal = new Date(today);
      renewal.setUTCDate(renewal.getUTCDate() + d);
      const decision = decideCadence({ renewalDate: renewal, graceDays: 7, currentState: state, today });
      if (decision.shouldSendEmail) sent += 1;
      state = decision.targetState;
    }
    expect(sent).toBe(7);
  });
});

/* ── The case Pardeep named, 22 Aug 2026 ─────────────────────────────────────
   "monthly renewal do cases me ho sakta hai — ek monthly commitment monthly payment,
   doosra annual commitment monthly payment."

   He is right, and the second one broke my first attempt. I had keyed the ladder off
   billing_cycle, so a Google Workspace annual plan PAID MONTHLY — invoiced twelve times,
   renewing once — would have been handed the three-touch monthly schedule for the end of
   a year-long commitment. No 30-day runway to raise a PO or clear a budget, which is the
   entire reason T-30 exists.

   The ladder is decided by the TERM. billing_cycle answers a different question. */
describe("annual commitment paid monthly", () => {
  const decide = (daysOut: number, termMonths: number, currentState: RenewalState = "pending") => {
    const today = new Date("2026-09-01T06:00:00Z");
    const renewal = new Date(today);
    renewal.setUTCDate(renewal.getUTCDate() + daysOut);
    return decideCadence({ renewalDate: renewal, graceDays: 7, currentState, termMonths, today });
  };

  it("gets the ANNUAL runway even though it is invoiced every month", () => {
    /* term 12, billed monthly. T-30 must fire — it is a year-long commitment ending. */
    expect(decide(30, 12).targetState).toBe("early_notice");
    expect(decide(30, 12).shouldSendEmail).toBe(true);
  });

  it("is not confused with a flex-monthly plan, which renews every month", () => {
    /* Same invoice frequency, completely different renewal event. Only the term differs,
       and only the term should decide. */
    expect(decide(30, 12).shouldSendEmail).toBe(true);   // annual term: 30 days' notice
    expect(decide(30, 1).shouldSendEmail).toBe(false);   // monthly term: far too early
  });

  it("gives the annual-paid-monthly plan all seven touches, not three", () => {
    let sent = 0;
    let state: RenewalState = "pending";
    for (let d = 40; d >= 0; d--) {
      const decision = decide(d, 12, state);
      if (decision.shouldSendEmail) sent += 1;
      state = decision.targetState;
    }
    expect(sent).toBe(7);
  });
});
