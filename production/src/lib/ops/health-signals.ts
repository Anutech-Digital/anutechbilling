// Not wired yet — R-1608 (built, kept for later)
/**
 * Whether the scheduled work actually happened, answered from the database.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Asked on 23 Aug 2026: "jo mene error handling ke liye automation ka kaam karwaya tha
 * kya wo sahi kaam kar raha hai." Measured, the answer was: two of its three eyes are
 * shut.
 *
 *   Cloud Run logs   the primary source — gcloud auth expired mid-session
 *   Sentry           us din SENTRY_DSN khaali tha. ⚠️ 1 Sep 2026 ko naapa:
 *                    ab DONO DSN Cloud Run par SET hain (95 chars) — ye
 *                    itihaas hai, aaj ki haalat nahi. Delivery ki tasdeeq
 *                    dashboard se hi ho sakti hai.
 *   DB log tables    working — and the only thing that found anything all day
 *
 * So a scan that reported "System healthy" was reporting on what it could still see,
 * which is precisely the failure AGENTS.md L1 is about: a failure that looks like a
 * success. Worse, the day's real defects were reported by the operator or found by
 * reading code, not by the scan.
 *
 * This module reads the signals the database CAN answer, so the check no longer depends
 * on a token that expires. It is pure — the caller does the queries and hands the counts
 * in — so every rule below is testable without a database.
 *
 * ─── AND IT REFUSES TO SAY "HEALTHY" WHEN IT CANNOT SEE ─────────────────────
 * `sourcesUnavailable` is not decoration. A checker that answers "healthy" while blind
 * is worse than one that errors, because the answer is indistinguishable from the real
 * thing. Anything unavailable downgrades the verdict to `unknown`, which reads as
 * "nobody knows" rather than "nothing is wrong".
 */

export type Severity = "ok" | "warn" | "alarm";

export interface HealthFinding {
  /** Short slug, for grepping a log: "renewals-never-ran". */
  id: string;
  severity: Severity;
  /** What is wrong and what to do — never a bare status (CLAUDE.md §24). */
  text: string;
}

export interface HealthInput {
  /** IST date the check is running for, YYYY-MM-DD. */
  today: string;
  /** ISO day of week for `today`: 1 = Monday … 7 = Sunday. */
  todayDow: number;

  /** Rows in backup.snapshots for YESTERDAY. The job runs at 00:00 IST. */
  backupsYesterday: number;
  /** Rows in renewal_email_log, ever. */
  renewalEmailsEver: number;
  /**
   * Subscriptions that have genuinely MISSED a reminder: `reminder_count = 0` while
   * having existed on or before their own T-15, with that step now in the past.
   *
   * ─── ALL THREE CONDITIONS, AND THE THIRD IS THE ONE I MISSED ──────────────
   * The first version of this check counted "inside the 30-day window with
   * reminder_count = 0" and raised an ALARM on today's data. It was wrong. The one
   * subscription it found was created 22 Aug for a 27 Aug renewal — five days apart —
   * and the ladder opens at T-15, which for that row was 12 Aug, before it existed.
   * Today is T-4, and T-4 is not a step (the ladder is T-30/15/12/9/6/3/0).
   *
   * So the cron was working and the check was crying wolf on its second query of the
   * day. `renewal_email_log` being empty means "no subscription has yet reached a ladder
   * step", which in a workspace this young is the correct and quiet answer.
   *
   * L38 says absence of evidence needs both halves. It needed three: never reminded, a
   * step has passed, AND the row existed when it passed.
   */
  subsDueUnreminded: number;
  /** Rows in attendance_reminder_log for today. */
  attendanceRemindersToday: number;
  /** Rows in email_log with status <> 'sent', ever. */
  emailFailuresEver: number;

  /**
   * Telemetry sources that could NOT be consulted — "cloud-run-logs", "sentry".
   * Present entries make the overall verdict `unknown`, whatever else is clean.
   */
  sourcesUnavailable: readonly string[];
}

export interface HealthReport {
  /** `unknown` whenever a source was unavailable — never "ok" while half-blind. */
  verdict: "ok" | "attention" | "unknown";
  findings: HealthFinding[];
  /** One line for a log or a chat message. */
  summary: string;
}

export function checkHealth(input: HealthInput): HealthReport {
  const findings: HealthFinding[] = [];

  /* ── What the loop could not see ─────────────────────────────────────────── */
  for (const src of input.sourcesUnavailable) {
    findings.push({
      id: `source-unavailable-${src}`,
      severity: "warn",
      text: src === "cloud-run-logs"
        ? "Cloud Run logs could not be read (gcloud auth expired). Run `gcloud auth login` — until then 5xx and cron output are invisible."
        : src === "sentry"
          ? "Sentry is not configured (SENTRY_DSN is empty), so unhandled exceptions are dropped rather than reported. Set it, or accept that the only error signal is the DB."
          : `Telemetry source "${src}" could not be read, so anything it would have shown is unknown.`,
    });
  }

  /* ── The nightly backup ──────────────────────────────────────────────────── */
  if (input.backupsYesterday <= 0) {
    findings.push({
      id: "backup-missing",
      severity: "alarm",
      text: "No backup snapshot for yesterday. This is a free plan with no PITR, so a missed night is a night with no restore point — check /api/cron/backup and the Scheduler job.",
    });
  }

  /* ── The renewal ladder ──────────────────────────────────────────────────── */
  if (input.renewalEmailsEver === 0 && input.subsDueUnreminded > 0) {
    /* Both halves matter. Zero emails with nothing due is a quiet system; zero emails
       with something due is a job that is not running. */
    findings.push({
      id: "renewals-never-ran",
      severity: "alarm",
      text: `renewal_email_log is empty and ${input.subsDueUnreminded} subscription(s) inside the reminder window have never been reminded. The renewals cron has not done its job — check the Scheduler entry for /api/cron/renewals and hit it with ?dry=1.`,
    });
  } else if (input.subsDueUnreminded > 0) {
    findings.push({
      id: "renewals-behind",
      severity: "warn",
      text: `${input.subsDueUnreminded} subscription(s) are inside the reminder window with reminder_count = 0. Run /api/cron/renewals?dry=1 to see why they are being skipped.`,
    });
  }

  /* ── Reminders on a day nobody works ─────────────────────────────────────── */
  if (input.todayDow === 7 && input.attendanceRemindersToday > 0) {
    findings.push({
      id: "attendance-on-weekly-off",
      severity: "warn",
      text: `${input.attendanceRemindersToday} attendance reminder(s) were sent today, a Sunday. If that is after the working-day fix landed, the fix is not live — check lib/attendance/working-day.ts is being reached.`,
    });
  }

  if (input.emailFailuresEver > 0) {
    findings.push({
      id: "email-failures",
      severity: "warn",
      text: `${input.emailFailuresEver} row(s) in email_log did not send. Read their error_message — a stale one from before a fix is fine, a fresh one is not.`,
    });
  }

  const alarms = findings.filter((f) => f.severity === "alarm").length;
  const warns = findings.filter((f) => f.severity === "warn").length;

  /* Blind beats clean. A verdict of "ok" while a source is down is the lie this module
     exists to stop telling. */
  const verdict: HealthReport["verdict"] =
    input.sourcesUnavailable.length > 0 ? "unknown"
      : alarms + warns > 0 ? "attention"
        : "ok";

  const summary =
    verdict === "ok"
      ? "All scheduled work accounted for, and every telemetry source was readable."
      : verdict === "unknown"
        ? `Cannot say the system is healthy — ${input.sourcesUnavailable.length} telemetry source(s) unreadable, ${alarms} alarm(s) and ${warns} warning(s) from what could be checked.`
        : `${alarms} alarm(s) and ${warns} warning(s).`;

  return { verdict, findings, summary };
}
