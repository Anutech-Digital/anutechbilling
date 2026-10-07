/**
 * R-282 — start a Google Workspace trial from an ACCEPTED, UNPAID quote ("trial first, pay later").
 *
 * The customer accepted Q-FBB9-27-0009 and asked for a trial before paying. The only trial path
 * was StartTrialDialog, which creates a NEW phone lead — so the accepted quote sat in "Awaiting
 * payment" with no way to say "they are trialling, money is due when the trial ends".
 *
 * Pardeep decided (6 Oct 2026):
 *   - 14 days by default; at most 10 users (Google's trial cap — more is a warning, not a block,
 *     because the extra seats are added after payment, outside this app).
 *   - The quote stays 'accepted'. Payment is due on the trial's last day (= the lead's
 *     trial_expires_at — no new column).
 *   - Three tasks for the owner. Tasks ONLY: nothing is sent to the customer automatically, and
 *     nothing is suspended when the trial ends. The last task asks a person to decide.
 *   - When a payment lands, the lead gets trial_converted_at and the open trial tasks close —
 *     done in the database (migration 20261007010000_trial_convert_on_payment.sql) so it also
 *     happens for payments that arrive by webhook, not only from this screen.
 *
 * Everything here that decides something is a pure function, tested in start-from-quote.test.ts.
 * `startTrialFromQuote` is the thin writer the dialog calls.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LifecycleStep } from "@/lib/quotes/lifecycle";
import { addDaysISO, daysBetweenISO, istDayStartUtc, toIstDate } from "@/lib/dates/ist";

export const QUOTE_TRIAL_DAYS = 14;
/** Google's own cap on a Workspace trial. Above this is a warning — never a silent clamp. */
export const GOOGLE_TRIAL_MAX_USERS = 10;
export const QUOTE_TRIAL_MIN_DAYS = 1;
export const QUOTE_TRIAL_MAX_DAYS = 30;
/** Every task this flow writes starts with this, so the payment trigger can close them. */
export const TRIAL_TASK_PREFIX = "Trial";

const HOUR_MS = 3_600_000;

// ── Who may start one ────────────────────────────────────────────────────────

export interface TrialQuoteFacts {
  status: "draft" | "sent" | "viewed" | "accepted" | "rejected" | "expired";
  payment_status: "none" | "awaiting" | "partial" | "received" | "invoiced" | null;
  /** Sum of received payments on this quote, whole rupees. */
  received: number;
}

export interface TrialLeadFacts {
  trial_started_at: string | null;
  trial_expires_at: string | null;
  trial_converted_at: string | null;
  trial_expired_at: string | null;
}

export type TrialEligibility = { ok: true } | { ok: false; reason: string };

/**
 * Only an accepted quote with no money in. A draft or sent quote has not been agreed, and a paid
 * one needs no trial — the customer has already bought.
 */
export function quoteTrialEligibility(
  quote: TrialQuoteFacts,
  lead: TrialLeadFacts | null | undefined,
  now: Date = new Date(),
): TrialEligibility {
  if (quote.status === "rejected" || quote.status === "expired") {
    return { ok: false, reason: "This quote is closed, so a trial cannot start from it." };
  }
  if (quote.status !== "accepted") {
    return { ok: false, reason: "A trial starts after the customer accepts the quote. Mark it accepted first." };
  }
  if (quote.received > 0 || quote.payment_status === "received" || quote.payment_status === "partial") {
    return { ok: false, reason: "Payment is already recorded on this quote, so no trial is needed." };
  }
  const trial = lead ? quoteTrialState(lead, now) : null;
  if (trial?.kind === "running") {
    return { ok: false, reason: `A trial is already running. It ends ${formatIstDate(trial.endDate)}.` };
  }
  return { ok: true };
}

// ── Defaults and the 10-user warning ─────────────────────────────────────────

/** Quote seats, capped at Google's trial limit. No seats on the quote → the cap. */
export function defaultTrialUsers(quoteSeats: number | null | undefined): number {
  const seats = Number(quoteSeats);
  if (!Number.isFinite(seats) || seats < 1) return GOOGLE_TRIAL_MAX_USERS;
  return Math.min(Math.floor(seats), GOOGLE_TRIAL_MAX_USERS);
}

export function trialUsersWarning(users: number): string | null {
  if (users > GOOGLE_TRIAL_MAX_USERS) {
    return `Google allows at most ${GOOGLE_TRIAL_MAX_USERS} users on a trial. Start with ${GOOGLE_TRIAL_MAX_USERS} and add the rest after payment.`;
  }
  return null;
}

export function validTrialDays(days: number): boolean {
  return Number.isInteger(days) && days >= QUOTE_TRIAL_MIN_DAYS && days <= QUOTE_TRIAL_MAX_DAYS;
}

// ── The plan: dates and tasks, all in IST ────────────────────────────────────

export interface TrialTaskPlan {
  title: string;
  notes: string;
  kind: "custom" | "followup";
  due_at: string;
}

export interface QuoteTrialPlan {
  /** IST calendar day the trial starts (YYYY-MM-DD). */
  startDate: string;
  /** IST calendar day the trial ends — the payment due date. */
  endDate: string;
  trialStartedAt: string;
  /** The last instant of the end day in IST, so the whole last day is still "in trial". */
  trialExpiresAt: string;
  tasks: TrialTaskPlan[];
}

/** 10:00 IST on an IST calendar day, as a UTC ISO string. */
function istTenAm(isoDay: string): number {
  return istDayStartUtc(isoDay).getTime() + 10 * HOUR_MS;
}

export function planQuoteTrial(input: {
  now: Date;
  days: number;
  users: number;
  company: string;
  quoteId: string;
}): QuoteTrialPlan {
  const { now, days, users, company, quoteId } = input;
  if (!validTrialDays(days)) {
    throw new Error(`Trial length must be ${QUOTE_TRIAL_MIN_DAYS}–${QUOTE_TRIAL_MAX_DAYS} days.`);
  }
  const startDate = toIstDate(now);
  const endDate   = addDaysISO(startDate, days);
  // End of the IST end day: next IST midnight minus 1 ms.
  const trialExpiresAt = new Date(istDayStartUtc(addDaysISO(endDate, 1)).getTime() - 1).toISOString();

  /* Day 1 is today. At 10:00 IST if that is still ahead, otherwise now — a task created at
     15:00 and due "10:00 today" would open already overdue. */
  const day1 = Math.max(istTenAm(startDate), now.getTime());
  /* Payment-link reminder 4 days before the end. A short trial would put that before day 1;
     it is never earlier than the setup task. */
  const linkDay = Math.max(istTenAm(addDaysISO(endDate, -4)), day1);
  const endDay  = Math.max(istTenAm(endDate), linkDay);

  const endLabel = formatIstDate(endDate);
  const who = company.trim() || quoteId;

  const tasks: TrialTaskPlan[] = [
    {
      title: `${TRIAL_TASK_PREFIX} setup: DNS and ${users} users · ${who}`,
      notes: `Workspace trial from quote ${quoteId}. ${users} users, ${days} days, ends ${endLabel}. Verify the domain (DNS) and create the users.`,
      kind: "custom",
      due_at: new Date(day1).toISOString(),
    },
    {
      title: `${TRIAL_TASK_PREFIX}: send payment link · ${who}`,
      notes: `Trial ends ${endLabel}. Send the payment link for quote ${quoteId}. This is a reminder only — nothing is sent to the customer automatically.`,
      kind: "followup",
      due_at: new Date(linkDay).toISOString(),
    },
    {
      title: `${TRIAL_TASK_PREFIX} ends today: extend, stop or convert · ${who}`,
      notes: `Trial on quote ${quoteId} ends today. Payment not in? Decide: extend the trial, stop it, or convert. Nothing is suspended automatically.`,
      kind: "followup",
      due_at: new Date(endDay).toISOString(),
    },
  ];

  return { startDate, endDate, trialStartedAt: now.toISOString(), trialExpiresAt, tasks };
}

// ── Reading a trial back ─────────────────────────────────────────────────────

export type QuoteTrialState =
  | { kind: "running"; endDate: string; daysLeft: number }
  | { kind: "ended"; endDate: string; daysPast: number }
  | { kind: "converted"; endDate: string | null };

/** IST-calendar reading of a lead's trial. null = no trial on this lead. */
export function quoteTrialState(lead: TrialLeadFacts, now: Date = new Date()): QuoteTrialState | null {
  if (!lead.trial_started_at) return null;
  const endDate = lead.trial_expires_at ? toIstDate(lead.trial_expires_at) : null;
  if (lead.trial_converted_at) return { kind: "converted", endDate };
  if (!endDate) return null;
  const diff = daysBetweenISO(toIstDate(now), endDate);
  if (diff < 0 || lead.trial_expired_at) return { kind: "ended", endDate, daysPast: Math.max(0, -diff) };
  return { kind: "running", endDate, daysLeft: diff };
}

/** "21 Oct 2026" from an IST YYYY-MM-DD. */
export function formatIstDate(isoDay: string): string {
  const d = new Date(Date.parse(`${isoDay.slice(0, 10)}T00:00:00Z`));
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Put TRIAL between SIGNED and PAID on the quote's steps line.
 *
 * Running or ended-unpaid → the trial is what the quote waits on, so it becomes the one
 * "current" step and Paid drops back to "todo". Converted → a done step. No trial → the
 * steps are returned untouched.
 */
export function withTrialStep(
  steps: LifecycleStep[],
  lead: TrialLeadFacts | null | undefined,
  quoteStatus: TrialQuoteFacts["status"],
  now: Date = new Date(),
): LifecycleStep[] {
  if (!lead || quoteStatus !== "accepted") return steps;
  const trial = quoteTrialState(lead, now);
  if (!trial) return steps;
  const paidIdx = steps.findIndex((s) => s.stage === "paid");
  if (paidIdx < 0) return steps;
  const paidDone = steps[paidIdx].state === "done";

  let step: LifecycleStep;
  if (trial.kind === "converted" || paidDone) {
    step = { stage: "trial", label: "Trial", state: "done", detail: "Trial converted to paid." };
  } else if (trial.kind === "running") {
    const left = trial.daysLeft === 0 ? "ends today" : `${trial.daysLeft} ${trial.daysLeft === 1 ? "day" : "days"} left`;
    step = {
      stage: "trial", label: `Trial · ${left}`, state: "current",
      detail: `Trial ends ${formatIstDate(trial.endDate)} · payment due then.`,
    };
  } else {
    step = {
      stage: "trial", label: "Trial · ended", state: "current",
      detail: `Trial ended ${formatIstDate(trial.endDate)} — payment not in. Extend, stop or convert.`,
    };
  }

  const out = steps.map((s) => ({ ...s }));
  if (step.state === "current") {
    for (const s of out) if (s.state === "current") s.state = "todo";
  }
  out.splice(paidIdx, 0, step);
  return out;
}

// ── The writer ───────────────────────────────────────────────────────────────

export interface StartTrialFromQuoteInput {
  quote: { id: string; tenant_id: string; lead_id: string | null; customer_id: string | null; customer_name: string; domain: string | null };
  /** The quote's lead, when it has one. */
  lead: { id: string; notes: string | null } | null;
  /** For a quote with no lead — the lead is created from the customer. */
  customer?: { contact_name: string | null; contact_email: string | null; contact_phone: string | null; domain: string | null } | null;
  days: number;
  users: number;
  ownerId: string;
  now?: Date;
}

export interface StartTrialFromQuoteResult {
  leadId: string;
  endDate: string;
  tasksCreated: number;
}

/**
 * Lead → stage 'trial' with the dates; three tasks for the owner. The quote's status and amounts
 * are never written — only lead_id, and only when the quote had no lead.
 */
export async function startTrialFromQuote(
  supabase: SupabaseClient,
  input: StartTrialFromQuoteInput,
): Promise<StartTrialFromQuoteResult> {
  const now  = input.now ?? new Date();
  const plan = planQuoteTrial({ now, days: input.days, users: input.users, company: input.quote.customer_name, quoteId: input.quote.id });
  const noteLine = `TRIAL from quote ${input.quote.id}: ${input.users} users, ${input.days} days, ${plan.startDate} to ${plan.endDate}. Payment due ${plan.endDate}.`;

  const trialFields = {
    stage: "trial" as const,
    trial_started_at: plan.trialStartedAt,
    trial_expires_at: plan.trialExpiresAt,
    trial_converted_at: null,
    trial_expired_at: null,
  };

  let leadId: string;
  if (input.quote.lead_id) {
    leadId = input.quote.lead_id;
    /* Append, never replace: if the caller did not have the lead loaded, read its notes first
       rather than overwrite them with one line. */
    let existing = input.lead?.notes ?? null;
    if (!input.lead) {
      const { data, error } = await supabase.from("leads").select("notes").eq("id", leadId).maybeSingle();
      if (error) throw new Error(`Trial not started — the lead could not be read. ${error.message}`);
      existing = (data as { notes: string | null } | null)?.notes ?? null;
    }
    const notes = existing ? `${existing}\n${noteLine}` : noteLine;
    const { error } = await supabase.from("leads").update({ ...trialFields, notes })
      .eq("id", leadId).eq("tenant_id", input.quote.tenant_id);
    if (error) throw new Error(`Trial not started — the lead could not be updated. ${error.message}`);
  } else {
    leadId = "L-" + now.getTime().toString(36).toUpperCase();
    const c = input.customer ?? null;
    const { error } = await supabase.from("leads").insert({
      id: leadId,
      tenant_id: input.quote.tenant_id,
      company: input.quote.customer_name,
      customer_id: input.quote.customer_id,
      contact_name: c?.contact_name ?? null,
      contact_email: c?.contact_email ?? null,
      contact_phone: c?.contact_phone ?? null,
      domain: input.quote.domain ?? c?.domain ?? null,
      seats: input.users,
      value: 0,
      source: "quote-trial",
      owner_id: input.ownerId,
      notes: noteLine,
      ...trialFields,
    });
    if (error) throw new Error(`Trial not started — the lead could not be created. ${error.message}`);
    const { error: qErr } = await supabase.from("quotes").update({ lead_id: leadId })
      .eq("id", input.quote.id).eq("tenant_id", input.quote.tenant_id);
    if (qErr) throw new Error(`Trial lead ${leadId} was created but not linked to the quote. ${qErr.message}`);
  }

  const { error: tErr } = await supabase.from("tasks").insert(
    plan.tasks.map((t) => ({
      tenant_id: input.quote.tenant_id,
      title: t.title,
      notes: t.notes,
      kind: t.kind,
      due_at: t.due_at,
      /* lead_id only: tasks_one_link_only allows ONE of lead/quote/customer/subscription.
         The quote id is in every task note. */
      lead_id: leadId,
      owner_id: input.ownerId,
    })),
  );

  return { leadId, endDate: plan.endDate, tasksCreated: tErr ? 0 : plan.tasks.length };
}

