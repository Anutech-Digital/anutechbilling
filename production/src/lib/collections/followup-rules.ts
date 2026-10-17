/**
 * R-1517 — the rules of a payment follow-up entry (table payment_followups, R-1515).
 * Pure, no "use client": the form (components/features/collections/followup-dialog.tsx) and
 * the API route (app/api/collections/followups/route.ts) both use them, so the browser and the
 * server agree on what is valid and on who may hand a follow-up to someone else.
 *
 * DECISIONS (Pardeep, 17 Oct, R-1514 / R-1517 mustDo)
 *   • Every entry needs a NEXT follow-up date — that is what keeps a customer from being
 *     dropped. Default: 3 days from today (IST).
 *   • A promise-to-pay needs a date (the DB check payment_followups_promise_has_date says the
 *     same); the amount is optional ("will pay the balance"), whole rupees (§13).
 *   • The follow-up belongs to the customer's owner (customers.account_manager_id) unless an
 *     earlier follow-up was handed to someone else. Only owner / manager / accountant may hand
 *     it to another person. The DB does NOT stop a sales person from writing another user into
 *     assigned_to, so the API route checks it (resolveAssignee) and the form hides the picker.
 *   • created_by / tenant_id / id / created_at are never sent by the browser: created_by
 *     defaults to auth.uid() in the DB (and RLS insists on it), tenant_id comes from the
 *     server's own users row. The request schema is strict, so a body carrying them is refused.
 */
import { z } from "zod";
import { addDaysISO } from "@/lib/dates/ist";

export const FOLLOWUP_KINDS = ["call", "whatsapp", "email", "meeting", "note", "promise"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export const FOLLOWUP_KIND_LABEL: Record<FollowupKind, string> = {
  call: "Call",
  whatsapp: "WhatsApp",
  email: "Email",
  meeting: "Meeting",
  note: "Note",
  promise: "Promise to pay",
};

/** Who may give a follow-up to another person (R-1514: owner/accountant; manager too). */
export const REASSIGN_ROLES = ["owner", "manager", "accountant"] as const;

export function mayReassignFollowup(role: string | null | undefined): boolean {
  return !!role && (REASSIGN_ROLES as readonly string[]).includes(role);
}

/** Default next follow-up: 3 days after today (both YYYY-MM-DD, IST calendar). */
export const DEFAULT_NEXT_DAYS = 3;
export function defaultNextFollowUp(today: string): string {
  return addDaysISO(today, DEFAULT_NEXT_DAYS);
}

/** The person a new entry goes to when nobody picks: who has it now → the customer's owner → me. */
export function defaultAssignee(opts: {
  latestAssignedTo: string | null | undefined;
  ownerId: string | null | undefined;
  meId: string | null | undefined;
}): string | null {
  return opts.latestAssignedTo || opts.ownerId || opts.meId || null;
}

export type AssigneeDecision =
  | { ok: true; assignedTo: string | null }
  | { ok: false; status: 403; error: string };

export const REASSIGN_REFUSED =
  "Only an owner, manager or accountant can give this follow-up to someone else. " +
  "Save it with the person it is with now, or ask your manager to reassign it.";

/**
 * The server's decision on assigned_to. Nothing asked → the default. A reassigner gets what
 * they asked. Anyone else may only keep the default — a different person is refused (403),
 * never silently swapped, so the person knows it did not happen.
 */
export function resolveAssignee(opts: {
  role: string | null | undefined;
  requested: string | null | undefined;
  defaultId: string | null;
}): AssigneeDecision {
  const requested = opts.requested || null;
  if (!requested) return { ok: true, assignedTo: opts.defaultId };
  if (mayReassignFollowup(opts.role)) return { ok: true, assignedTo: requested };
  if (requested === opts.defaultId) return { ok: true, assignedTo: requested };
  return { ok: false, status: 403, error: REASSIGN_REFUSED };
}

// ─── Validation ──────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const blankToUndefined = (v: unknown) => (v === "" || v === null || v === undefined ? undefined : v);

export const NEXT_REQUIRED = "Pick the next follow-up date — every customer needs one, so nobody is forgotten.";
export const PROMISE_DATE_REQUIRED = "A promise to pay needs a date — when did they say they will pay?";
export const WHOLE_RUPEES = "Whole rupees only (no paise), 0 or more.";

const nextDate = z.string({ required_error: NEXT_REQUIRED }).regex(ISO_DATE, NEXT_REQUIRED);
const optDate = z.preprocess(blankToUndefined, z.string().regex(ISO_DATE, "Pick a valid date.").optional());
const optAmount = z.preprocess(
  (v) => {
    const b = blankToUndefined(v);
    return typeof b === "string" ? Number(b) : b;
  },
  z.number({ invalid_type_error: WHOLE_RUPEES }).int(WHOLE_RUPEES).min(0, WHOLE_RUPEES).max(1_000_000_000, "That amount looks too big — check the zeros.").optional(),
);

const fields = {
  kind: z.enum(FOLLOWUP_KINDS, { errorMap: () => ({ message: "Pick what kind of follow-up this was." }) }),
  note: z.preprocess(blankToUndefined, z.string().trim().max(4000, "Keep the note under 4,000 characters.").optional()),
  promisedAmount: optAmount,
  promisedOn: optDate,
  nextFollowUpOn: nextDate,
};

function promiseRule(v: { kind: FollowupKind; promisedOn?: string }, ctx: z.RefinementCtx) {
  if (v.kind === "promise" && !v.promisedOn) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["promisedOn"], message: PROMISE_DATE_REQUIRED });
  }
}

/** The form. `link` = "" | "invoice:<id>" | "subscription:<id>" (see linkOptions). */
export const followupFormSchema = z
  .object({
    ...fields,
    assignedTo: z.string().optional(),
    link: z.string().optional(),
  })
  .superRefine(promiseRule);
export type FollowupFormValues = z.input<typeof followupFormSchema>;
export type FollowupFormData = z.output<typeof followupFormSchema>;

/** The API body. Strict: created_by, tenant_id, id, created_at are refused, not ignored. */
export const followupRequestSchema = z
  .object({
    ...fields,
    customerId: z.string().uuid("Open the follow-up from a customer row and try again."),
    assignedTo: z.preprocess(blankToUndefined, z.string().uuid().optional()),
    invoiceId: z.preprocess(blankToUndefined, z.string().max(200).optional()),
    quoteId: z.preprocess(blankToUndefined, z.string().max(200).optional()),
    subscriptionId: z.preprocess(blankToUndefined, z.string().uuid().optional()),
  })
  .strict("Only the follow-up fields may be sent — reload the page and try again.")
  .superRefine(promiseRule);
export type FollowupRequest = z.output<typeof followupRequestSchema>;

// ─── Links (what the follow-up is about) ─────────────────────────────────────

export interface FollowupLinkSource {
  kind: "invoice" | "subscription";
  id: string;
  label: string;
  quoteId: string | null;
}

export interface FollowupLinkOption {
  value: string;
  label: string;
  invoiceId: string | null;
  subscriptionId: string | null;
  quoteId: string | null;
}

export function linkOptions(items: readonly FollowupLinkSource[]): FollowupLinkOption[] {
  return items.map((i) => ({
    value: `${i.kind}:${i.id}`,
    label: `${i.kind === "invoice" ? "Invoice" : "Subscription"} ${i.label}`,
    invoiceId: i.kind === "invoice" ? i.id : null,
    subscriptionId: i.kind === "subscription" ? i.id : null,
    quoteId: i.quoteId,
  }));
}

/** Form → API body. Promise fields go only with a promise; nothing the DB fills itself. */
export function toFollowupRequest(
  data: FollowupFormData,
  ctx: { customerId: string; links: readonly FollowupLinkOption[]; canReassign: boolean },
): FollowupRequest {
  const link = data.link ? ctx.links.find((l) => l.value === data.link) : undefined;
  const isPromise = data.kind === "promise";
  return {
    customerId: ctx.customerId,
    kind: data.kind,
    note: data.note,
    promisedAmount: isPromise ? data.promisedAmount : undefined,
    promisedOn: isPromise ? data.promisedOn : undefined,
    nextFollowUpOn: data.nextFollowUpOn,
    assignedTo: ctx.canReassign ? data.assignedTo || undefined : undefined,
    invoiceId: link?.invoiceId ?? undefined,
    quoteId: link?.quoteId ?? undefined,
    subscriptionId: link?.subscriptionId ?? undefined,
  };
}

/** API body → the row inserted. No created_by (DB default auth.uid()), no id / created_at. */
export function buildFollowupInsert(req: FollowupRequest, tenantId: string, assignedTo: string | null) {
  const isPromise = req.kind === "promise";
  return {
    tenant_id: tenantId,
    customer_id: req.customerId,
    kind: req.kind,
    note: req.note ?? null,
    promised_amount: isPromise ? req.promisedAmount ?? null : null,
    promised_on: isPromise ? req.promisedOn ?? null : null,
    next_follow_up_on: req.nextFollowUpOn,
    assigned_to: assignedTo,
    invoice_id: req.invoiceId ?? null,
    quote_id: req.quoteId ?? null,
    subscription_id: req.subscriptionId ?? null,
  };
}

// ─── History ─────────────────────────────────────────────────────────────────

export interface FollowupHistoryRow {
  id: string;
  kind: string;
  note: string | null;
  promised_amount: number | null;
  promised_on: string | null;
  next_follow_up_on: string | null;
  assigned_to: string | null;
  created_by: string | null;
  created_at: string;
  invoice_id: string | null;
  quote_id: string | null;
  subscription_id: string | null;
}

export interface FollowupHistoryEntry extends FollowupHistoryRow {
  /** The promise date has passed and the customer still owes money. */
  broken: boolean;
}

/** Newest first; equal times by id, so the order never depends on how rows arrived. */
export function compareFollowupsNewestFirst(a: Pick<FollowupHistoryRow, "created_at" | "id">, b: Pick<FollowupHistoryRow, "created_at" | "id">): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function isPromiseBroken(promisedOn: string | null | undefined, today: string, stillOwes: boolean): boolean {
  return !!promisedOn && promisedOn.slice(0, 10) < today && stillOwes;
}

export function buildFollowupHistory(rows: readonly FollowupHistoryRow[], today: string, stillOwes: boolean): FollowupHistoryEntry[] {
  return [...rows]
    .sort(compareFollowupsNewestFirst)
    .map((r) => ({ ...r, broken: isPromiseBroken(r.promised_on, today, stillOwes) }));
}
