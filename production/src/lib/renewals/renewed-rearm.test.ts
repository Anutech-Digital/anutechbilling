import { describe, it, expect } from "vitest";
import { decideCadence, renewalIsSettled, type RenewalState } from "./cadence";

/* R-1562 (audit 18 Oct 2026). record_payment writes renewal_state = 'renewed' when a
   renewal quote is paid AND moves renewal_date one term on, in the same UPDATE
   (supabase/migrations/20261011120000_r718_money_roles.sql:1800-1827). The cadence
   treated 'renewed' as terminal (cadence.ts shouldSendEmail / shouldSuspend), and the
   cron's drift-sync refused to move off it — so after one paid renewal the NEXT term got
   no T-30/T-15 reminder, no renewal quote and no grace/suspend, for good.

   These tests run the subscription through whole terms the way production does: the
   cron's daily decision, and record_payment's roll-forward on payment. */

const DAY = 86_400_000;

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

interface Sub { renewalDate: string; state: RenewalState; termMonths: number }

/** One cron day: decide, and on a sent email move the state like the cron does. */
function cronDay(sub: Sub, today: Date, graceDays = 7) {
  const d = decideCadence({
    renewalDate: sub.renewalDate, graceDays, currentState: sub.state,
    termMonths: sub.termMonths, today,
  });
  if (d.shouldSuspend) sub.state = "suspended";
  else if (d.shouldSendEmail) sub.state = d.targetState;
  return d;
}

/** record_payment's roll-forward on a paid renewal quote. */
function payRenewal(sub: Sub) {
  sub.renewalDate = addMonths(sub.renewalDate, sub.termMonths);
  sub.state = "renewed";
}

/** Run the cron once a day from `from` to `to` (both inclusive, IST midday); returns the steps emailed. */
function runDays(sub: Sub, from: string, to: string, graceDays = 7) {
  const sent: string[] = [];
  let suspended = false;
  const start = new Date(`${from}T06:00:00Z`).getTime();
  const days = Math.round((new Date(`${to}T06:00:00Z`).getTime() - start) / DAY) + 1;
  for (let i = 0; i < days; i++) {
    const d = cronDay(sub, new Date(start + i * DAY), graceDays);
    if (d.shouldSendEmail) sent.push(d.targetState);
    if (d.shouldSuspend) suspended = true;
  }
  return { sent, suspended };
}

const ANNUAL_LADDER = ["early_notice", "notice_sent", "reminder_1", "reminder_2", "reminder_3", "reminder_4", "final_sent"];

describe("R-1562 — a paid renewal re-opens the ladder for the next term", () => {
  it("renewed once → the next term's T-30 … T-0 reminders all fire", () => {
    const sub: Sub = { renewalDate: "2026-11-20", state: "pending", termMonths: 12 };
    expect(runDays(sub, "2026-10-01", "2026-11-20").sent).toEqual(ANNUAL_LADDER);
    payRenewal(sub);                                     // paid on 2026-11-20 → 2027-11-20
    expect(sub.renewalDate).toBe("2027-11-20");
    /* The year between: quiet, and the "Renewed" badge holds. */
    const quiet = runDays(sub, "2026-11-21", "2027-10-20");
    expect(quiet.sent).toEqual([]);
    expect(sub.state).toBe("renewed");
    /* From T-30 of the new term the ladder runs again. */
    expect(runDays(sub, "2027-10-21", "2027-11-20").sent).toEqual(ANNUAL_LADDER);
  });

  it("renewed twice → the third term is chased too", () => {
    const sub: Sub = { renewalDate: "2026-11-20", state: "renewed", termMonths: 12 };
    payRenewal(sub); payRenewal(sub);
    expect(sub.renewalDate).toBe("2028-11-20");
    expect(runDays(sub, "2028-10-21", "2028-11-20").sent).toEqual(ANNUAL_LADDER);
  });

  it("renewed but the new term goes unpaid → grace, then suspended", () => {
    const sub: Sub = { renewalDate: "2027-11-20", state: "renewed", termMonths: 12 };
    const r = runDays(sub, "2027-10-21", "2027-11-30", 7);
    expect(r.sent).toContain("grace_period");
    expect(r.suspended).toBe(true);
  });

  it("monthly term: renewed → next month's T-7/T-3/T-0 fire", () => {
    const sub: Sub = { renewalDate: "2026-11-20", state: "renewed", termMonths: 1 };
    expect(runDays(sub, "2026-10-21", "2026-11-20").sent).toEqual(["notice_sent", "reminder_4", "final_sent"]);
  });

  it("renewed with the date already past (never chased) → a final notice first, never a silent suspend", () => {
    const today = new Date("2026-08-01T06:00:00Z");
    const d = decideCadence({ renewalDate: "2026-07-01", graceDays: 7, currentState: "renewed", today });
    expect(d.shouldSuspend).toBe(false);
    expect(d.shouldSendEmail).toBe(true);
    expect(d.targetState).toBe("final_sent");
  });

  it("renewed inside grace → the grace reminder is sent", () => {
    const today = new Date("2026-08-01T06:00:00Z");
    const d = decideCadence({ renewalDate: "2026-07-29", graceDays: 7, currentState: "renewed", today });
    expect(d.targetState).toBe("grace_period");
    expect(d.shouldSendEmail).toBe(true);
    expect(d.shouldSuspend).toBe(false);
  });

  it("suspended stays terminal — no email, no second suspend", () => {
    const today = new Date("2026-08-01T06:00:00Z");
    expect(decideCadence({ renewalDate: "2026-08-10", graceDays: 7, currentState: "suspended", today }).shouldSendEmail).toBe(false);
    expect(decideCadence({ renewalDate: "2026-07-01", graceDays: 7, currentState: "suspended", today }).shouldSuspend).toBe(false);
  });
});

describe("R-1562 — renewalIsSettled (manual buttons / bulk reminder)", () => {
  const today = new Date("2026-08-01T06:00:00Z");
  it("renewed and the new term's first reminder not yet due → settled", () => {
    expect(renewalIsSettled("renewed", "2027-08-01", 12, today)).toBe(true);
    expect(renewalIsSettled("renewed", "2026-09-01", 12, today)).toBe(true);   // T-31
  });
  it("renewed but the new term's window is open → not settled", () => {
    expect(renewalIsSettled("renewed", "2026-08-31", 12, today)).toBe(false);  // T-30
    expect(renewalIsSettled("renewed", "2026-07-20", 12, today)).toBe(false);  // past
  });
  it("monthly: window opens at T-7", () => {
    expect(renewalIsSettled("renewed", "2026-08-09", 1, today)).toBe(true);    // T-8
    expect(renewalIsSettled("renewed", "2026-08-08", 1, today)).toBe(false);   // T-7
  });
  it("any other state is never settled", () => {
    expect(renewalIsSettled("pending", "2027-08-01", 12, today)).toBe(false);
    expect(renewalIsSettled(null, "2027-08-01", 12, today)).toBe(false);
  });
});
