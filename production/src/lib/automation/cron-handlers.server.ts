/**
 * R-1104: the cron route of every job, for "Run now" / "Retry" on /automation.
 *
 * The run route (app/api/automation/jobs/run) calls the job's own exported GET in-process,
 * inside runManually() — so a manual run goes through exactly the code the scheduler calls:
 * the same gatedCron() switch check, the same route, the same idempotency the job already has.
 * Nothing goes over the network and the cron secret never leaves the server.
 *
 * One line per job; cron-handlers.test.ts fails when a job in AUTOMATION_JOBS has no line here.
 */
import "server-only";
import type { AutomationJob } from "./jobs";

export type CronGet = (req: Request) => Promise<Response>;
type Loader = () => Promise<{ GET: unknown }>;

export const CRON_ROUTES: Record<AutomationJob, Loader> = {
  "invoice-dunning":      () => import("@/app/api/cron/invoice-dunning/route"),
  "renewals":             () => import("@/app/api/cron/renewals/route"),
  "birthday-greetings":   () => import("@/app/api/cron/birthday-greetings/route"),
  "trial-expiry":         () => import("@/app/api/cron/trial-expiry/route"),
  "compliance-reminders": () => import("@/app/api/cron/compliance-reminders/route"),
  "health-digest":        () => import("@/app/api/cron/health-digest/route"),
  "ai-reflection":        () => import("@/app/api/cron/ai-reflection/route"),
  "billing":              () => import("@/app/api/cron/billing/route"),
  "ai-reply-retry":       () => import("@/app/api/cron/ai-reply-retry/route"),
  "ai-sales-loop":        () => import("@/app/api/cron/ai-sales-loop/route"),
  "ai-support-sla":       () => import("@/app/api/cron/ai-support-sla/route"),
  "ai-telecall-renewals": () => import("@/app/api/cron/ai-telecall-renewals/route"),
  "cold-calls":           () => import("@/app/api/cron/cold-calls/route"),
  "provision-hosting":    () => import("@/app/api/cron/provision-hosting/route"),
  "register-domains":     () => import("@/app/api/cron/register-domains/route"),
  "renew-domains":        () => import("@/app/api/cron/renew-domains/route"),
  "renew-hosting":        () => import("@/app/api/cron/renew-hosting/route"),
  "attendance-reminders": () => import("@/app/api/cron/attendance-reminders/route"),
  "attendance-retention": () => import("@/app/api/cron/attendance-retention/route"),
  "gmail-inbox":          () => import("@/app/api/cron/gmail-inbox/route"),
  "google-contacts-sync": () => import("@/app/api/cron/google-contacts-sync/route"),
  "gbp-sync":             () => import("@/app/api/cron/gbp-sync/route"),
  "ads-sync":             () => import("@/app/api/cron/ads-sync/route"),
  "indiamart-leads":      () => import("@/app/api/cron/indiamart-leads/route"),
  "lead-finder":          () => import("@/app/api/cron/lead-finder/route"),
  "mrr-snapshot":         () => import("@/app/api/cron/mrr-snapshot/route"),
  "backup":               () => import("@/app/api/cron/backup/route"),
  "demo-reset":           () => import("@/app/api/cron/demo-reset/route"),
};

/** The job's GET handler (the gated one), or null when the module has none. */
export async function loadCronGet(job: AutomationJob): Promise<CronGet | null> {
  const mod = await CRON_ROUTES[job]();
  return typeof mod.GET === "function" ? (mod.GET as CronGet) : null;
}
