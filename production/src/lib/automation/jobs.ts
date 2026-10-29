/**
 * R-897: every job the app runs on its own, and the one switch for customer messages.
 *
 * The /automation page lists exactly these, and every cron route under app/api/cron must be
 * one of them (jobs.test.ts checks both directions), so a new cron cannot ship without a
 * switch — and it starts OFF like the rest. A missing automation_jobs row means OFF.
 *
 * scope
 *   "tenant"   — the work belongs to each company; each company's owner turns it on for
 *                their own company, and the cron only works on companies where it is on.
 *   "platform" — one run for the whole app (backups, the demo reset, the error digest);
 *                governed by the platform company's row (Anutech, BUY_PAGE_TENANT_ID).
 * dryRun
 *   true  — "practice run" works: the job does its selection and reports what it WOULD do,
 *           and sends / changes nothing.
 *   false — the job has nothing safe to rehearse; a practice run does nothing at all and the
 *           last result says so.
 */

export const CUSTOMER_MESSAGES = "customer_messages" as const;

/**
 * Internal safety jobs that are ON when nobody has set them (manager, 12 Oct 2026): a forgotten
 * switch must never mean "no backups". Only jobs that send nothing to anyone and protect data
 * belong here. The owner can still turn them off (that writes a row, and the row wins).
 * attendance-retention is deliberately NOT here: it deletes data per company, and a forgotten
 * switch only delays a deletion, while a wrong default would delete.
 * The SQL automation_state() does not know this list; the gate (cron-gate.ts) and the
 * /automation page do — nothing else asks about these jobs.
 */
export const SAFETY_JOBS_DEFAULT_ON = ["backup"] as const;

export interface AutomationJobSpec {
  label: string;
  /** One plain-English line for the page. */
  what: string;
  customerFacing: boolean;
  scope: "tenant" | "platform";
  dryRun: boolean;
}

/** Order = order on the page: customer-facing first. */
export const AUTOMATION_JOBS = {
  "invoice-dunning":      { label: "Overdue invoice reminders", what: "Emails and WhatsApps customers about unpaid invoices, and can pause an overdue service.", customerFacing: true, scope: "tenant", dryRun: true },
  "renewals":             { label: "Renewal reminders", what: "Reminds customers before a subscription renews and makes the renewal quote.", customerFacing: true, scope: "tenant", dryRun: true },
  "birthday-greetings":   { label: "Birthday and anniversary greetings", what: "Sends greetings to customers on their day.", customerFacing: true, scope: "tenant", dryRun: true },
  "trial-expiry":         { label: "Trial ending reminders", what: "Tells customers their trial is ending, and ends it when it runs out.", customerFacing: true, scope: "tenant", dryRun: true },
  "compliance-reminders": { label: "Compliance due-date reminders", what: "Reminds about GST, TDS and other statutory due dates.", customerFacing: true, scope: "tenant", dryRun: true },
  "health-digest":        { label: "Error digest email", what: "Reads the app's error logs and emails the owner when something broke.", customerFacing: false, scope: "platform", dryRun: true },
  "ai-reflection":        { label: "AI daily reflection", what: "Emails the platform owner a short daily summary of what the AI did.", customerFacing: false, scope: "platform", dryRun: true },
  "billing":              { label: "Instalment payment requests", what: "Sends a payment request for each subscription part when it falls due; the tax invoice is raised when it is paid.", customerFacing: true, scope: "tenant", dryRun: true },
  "ai-reply-retry":       { label: "AI reply retry", what: "Answers customer emails the AI could not answer the first time.", customerFacing: true, scope: "tenant", dryRun: false },
  "ai-sales-loop":        { label: "AI sales follow-ups", what: "Sends the AI's planned follow-ups to leads.", customerFacing: true, scope: "tenant", dryRun: false },
  "ai-support-sla":       { label: "AI support ticket sweep", what: "Closes support tickets the customer never came back to, and flags unowned ones.", customerFacing: true, scope: "tenant", dryRun: false },
  "ai-telecall-renewals": { label: "AI renewal calls", what: "Calls customers whose subscription renews in five days.", customerFacing: true, scope: "tenant", dryRun: false },
  "cold-calls":           { label: "AI cold calls", what: "Calls the numbers on running Cold Calling lists, within their hours and daily limit.", customerFacing: true, scope: "tenant", dryRun: false },
  "provision-hosting":    { label: "Set up paid hosting", what: "Creates the hosting account for a paid hosting order.", customerFacing: true, scope: "tenant", dryRun: false },
  "register-domains":     { label: "Register paid domains", what: "Registers a domain once it is paid for.", customerFacing: true, scope: "tenant", dryRun: false },
  "renew-domains":        { label: "Renew paid domains", what: "Renews a domain once the renewal is paid for.", customerFacing: true, scope: "tenant", dryRun: false },
  "renew-hosting":        { label: "Renew paid hosting", what: "Extends a hosting account once the renewal is paid for.", customerFacing: true, scope: "tenant", dryRun: false },
  "attendance-reminders": { label: "Attendance reminders", what: "Sends the attendance nudge to your team's phones.", customerFacing: false, scope: "tenant", dryRun: true },
  "attendance-retention": { label: "Old attendance photo clean-up", what: "Deletes attendance selfies older than the keep period.", customerFacing: false, scope: "tenant", dryRun: false },
  "gmail-inbox":          { label: "Read the sales mailbox", what: "Reads new emails in the connected mailbox and adds them as enquiries.", customerFacing: false, scope: "tenant", dryRun: false },
  "google-contacts-sync": { label: "Google Contacts sync", what: "Keeps Google Contacts and your customers in step.", customerFacing: false, scope: "tenant", dryRun: false },
  "support-sync":         { label: "Support plan sync", what: "Tells the support desk when a support plan is sold, renewed or cancelled, so the customer gets the right plan there.", customerFacing: false, scope: "tenant", dryRun: false },
  "gbp-sync":             { label: "Google Business Profile sync", what: "Pulls reviews and details from your Google Business Profile.", customerFacing: false, scope: "tenant", dryRun: false },
  "ads-sync":             { label: "Ad spend sync", what: "Pulls Google Ads and Meta Ads spend.", customerFacing: false, scope: "tenant", dryRun: false },
  "indiamart-leads":      { label: "IndiaMART leads", what: "Pulls new leads from IndiaMART.", customerFacing: false, scope: "tenant", dryRun: false },
  "lead-finder":          { label: "Lead finder", what: "Looks for new business leads.", customerFacing: false, scope: "tenant", dryRun: false },
  "mrr-snapshot":         { label: "Monthly revenue snapshot", what: "Saves each customer's monthly revenue for the reports.", customerFacing: false, scope: "tenant", dryRun: true },
  "backup":               { label: "Nightly backup", what: "Saves a restore point of every company's data each night. On unless you turn it off.", customerFacing: false, scope: "platform", dryRun: false },
  "demo-reset":           { label: "Demo reset", what: "Resets the public \"Try the demo\" workspace each night.", customerFacing: false, scope: "platform", dryRun: false },
} as const satisfies Record<string, AutomationJobSpec>;

export type AutomationJob = keyof typeof AUTOMATION_JOBS;
export type AutomationSwitch = AutomationJob | typeof CUSTOMER_MESSAGES;
export type AutomationState = "off" | "dry_run" | "on";

export const CUSTOMER_MESSAGES_SPEC = {
  label: "Customer messages",
  what: "Every email and WhatsApp to a customer — from a job or from a person pressing Send. While this is off, nothing reaches a customer.",
} as const;

export function isAutomationJob(job: string): job is AutomationJob {
  return Object.prototype.hasOwnProperty.call(AUTOMATION_JOBS, job);
}

export function isAutomationSwitch(job: string): job is AutomationSwitch {
  return job === CUSTOMER_MESSAGES || isAutomationJob(job);
}

/** The platform company (Anutech). Same fallback every public route uses. */
export function platformTenantId(): string {
  return process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";
}

export function isDefaultOn(job: string): boolean {
  return (SAFETY_JOBS_DEFAULT_ON as readonly string[]).includes(job);
}

/**
 * A row → its state. Missing row = "off" (mirrors public.automation_state()), except a
 * SAFETY_JOBS_DEFAULT_ON job, which is "on" until a row says otherwise.
 */
export function stateOf(row: { enabled?: boolean | null; dry_run?: boolean | null } | null | undefined, job?: string): AutomationState {
  if (!row) return job && isDefaultOn(job) ? "on" : "off";
  if (!row.enabled) return "off";
  return row.dry_run ? "dry_run" : "on";
}
