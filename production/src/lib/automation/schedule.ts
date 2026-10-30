/**
 * R-1104: when each scheduled job runs, in plain English for the /automation page.
 *
 * The times are Cloud Scheduler's, in IST (scripts/setup-cloud-scheduler.sh, TZ Asia/Kolkata).
 * schedule.test.ts reads that script and fails when a line here and the line there differ —
 * the page must never promise a time the scheduler does not keep.
 */
import type { AutomationJob } from "./jobs";

export const JOB_CRON: Record<AutomationJob, string> = {
  "invoice-dunning":      "15 9 * * *",
  "renewals":             "0 9 * * *",
  "birthday-greetings":   "1 21 * * *",
  "trial-expiry":         "0 10 * * *",
  "compliance-reminders": "30 9 * * *",
  "health-digest":        "30 8 * * *",
  "ai-reflection":        "0 8 * * *",
  "billing":              "0 8 * * *",
  "ai-reply-retry":       "*/5 * * * *",
  "ai-sales-loop":        "0 9-19 * * 1-6",
  "ai-support-sla":       "*/15 * * * *",
  "support-sync":         "*/5 * * * *",
  "panel-accounts":       "*/5 * * * *",
  "ai-telecall-renewals": "30 10 * * 1-5",
  "cold-calls":           "*/2 9-19 * * 1-5",
  "provision-hosting":    "*/15 9-21 * * *",
  "register-domains":     "*/15 9-21 * * *",
  "renew-domains":        "0 7 * * *",
  "renew-hosting":        "0 7 * * *",
  "attendance-reminders": "*/30 9-20 * * *",
  "attendance-retention": "0 2 * * *",
  "gmail-inbox":          "* * * * *",
  "google-contacts-sync": "0 */6 * * *",
  "gbp-sync":             "30 2 * * *",
  "ads-sync":             "0 3 * * *",
  "indiamart-leads":      "*/15 8-21 * * *",
  "lead-finder":          "30 3 * * *",
  "mrr-snapshot":         "30 0 1 * *",
  "backup":               "0 0 * * *",
  "demo-reset":           "30 2 * * *",
};

const DAYS: Record<string, string> = { "1-5": "Monday to Friday", "1-6": "Monday to Saturday" };

function clock(h: number, m: number): string {
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

/**
 * A cron line of the shapes this app uses, in words. Throws on any other shape — a wrong
 * sentence on the page is worse than a failing test that names the line.
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Not a cron line: ${cron}`);
  const [min, hour, dom, mon, dow] = parts;
  if (mon !== "*") throw new Error(`Month field not supported: ${cron}`);
  if (dow !== "*" && !DAYS[dow]) throw new Error(`Day-of-week field not supported: ${cron}`);
  const days = dow === "*" ? "" : `, ${DAYS[dow]}`;

  const stepMin = /^\*\/(\d+)$/.exec(min);
  const range = /^(\d+)-(\d+)$/.exec(hour);

  // Every N minutes (or every minute), all day or inside an hour range.
  if (min === "*" || stepMin) {
    if (dom !== "*") throw new Error(`Day-of-month with a minute step not supported: ${cron}`);
    const step = stepMin ? Number(stepMin[1]) : 1;
    const every = step === 1 ? "Every minute" : `Every ${step} minutes`;
    if (hour === "*") return `${every}, day and night${days}`;
    if (range) {
      const lastMin = 60 - (60 % step === 0 ? step : 60 % step);
      return `${every} from ${clock(Number(range[1]), 0)} to ${clock(Number(range[2]), lastMin)}${days}`;
    }
    throw new Error(`Hour field not supported: ${cron}`);
  }

  if (!/^\d+$/.test(min)) throw new Error(`Minute field not supported: ${cron}`);
  const m = Number(min);

  // Every N hours.
  const stepHour = /^\*\/(\d+)$/.exec(hour);
  if (stepHour && m === 0 && dom === "*") return `Every ${stepHour[1]} hours${days}`;

  // Every hour inside a range.
  if (range && dom === "*") {
    return `Every hour from ${clock(Number(range[1]), m)} to ${clock(Number(range[2]), m)}${days}`;
  }

  if (!/^\d+$/.test(hour)) throw new Error(`Hour field not supported: ${cron}`);
  const h = Number(hour);
  const at = `${clock(h, m)}${h === 0 && m === 0 ? " (midnight)" : ""}`;
  if (/^\d+$/.test(dom)) {
    if (dow !== "*") throw new Error(`Day-of-month with weekdays not supported: ${cron}`);
    return `On the ${ordinal(Number(dom))} of every month at ${at}`;
  }
  if (dom !== "*") throw new Error(`Day-of-month field not supported: ${cron}`);
  return dow === "*" ? `Every day at ${at}` : `At ${at}${days}`;
}

/** The page's line for one job. */
export function scheduleFor(job: AutomationJob): string {
  return `${describeCron(JOB_CRON[job])} (India time)`;
}
