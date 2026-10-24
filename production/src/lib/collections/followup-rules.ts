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
 *     it to another person. The API route checks it (resolveAssignee), the form hides the picker,
 *     and since R-1528 the DB says the same (trigger trg_payment_followups_reassign_guard: others
 *     may only write NULL, themselves or this same default; billing included). Keep them in step.
 *   • created_by / tenant_id / id / created_at are never sent by the browser: created_by
 *     defaults to auth.uid() in the DB (and RLS insists on it), tenant_id comes from the
 *     server's own users row. The request schema is strict, so a body carrying them is refused.
 */
import { z } from "zod";
import { addDaysISO, toIstDate } from "@/lib/dates/ist";
import { cashReceived } from "@/lib/payments/cash-received";

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
  /** R-1540: promiseStatus(...) — null when the entry carries no promise. */
  promiseStatus: PromiseStatus | null;
  /** promiseStatus === "broken" — the history shows it red. */
  broken: boolean;
}

/** Newest first; equal times by id, so the order never depends on how rows arrived. */
export function compareFollowupsNewestFirst(a: Pick<FollowupHistoryRow, "created_at" | "id">, b: Pick<FollowupHistoryRow, "created_at" | "id">): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// ─── Promise status (R-1540) — THE one rule ──────────────────────────────────
//
// /collections (lib/queries/collections.ts), the follow-up history (customer card + dialog) and
// the owner's weekly report (weekly-report.ts) all ask promiseStatus, so one promise never gets
// two answers. Before R-1540 the list said "broken" whenever the date had passed and the
// customer still owed ANYTHING, while the report said "kept" when the promised amount came in.
//
//   kept   — the customer paid the promised amount (any amount when none was promised) in CASH
//            between the day the promise was first logged and the promise date, both IST days
//            inclusive; or they owe nothing any more (the debt is cleared).
//   broken — not kept, and the promise date is before today.
//   due    — not kept, the promise date is today (they still have today).
//   open   — not kept, the promise date is still ahead.
// Cash = payments with status "received", amount − credit_applied (R-1565: advance credit
// applied is not money the customer paid). Money paid after the promise date does not keep it.

export type PromiseStatus = "kept" | "broken" | "due" | "open";

/** A payment row as the screens read it (payments: customer_id, amount, credit_applied, received_at, status). */
export interface PromisePayment {
  customer_id: string | null;
  amount: number | null;
  /** R-1565: advance credit applied — not cash. */
  credit_applied?: number | null;
  received_at: string;
  status: string;
}

/** Cash that came in on an IST day, whole rupees. */
export interface PromiseReceipt {
  customerId: string;
  on: string;
  amount: number;
}

const wholeRupees = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0);

/** Received cash, whole rupees, IST day. Refunded / pending rows and pure credit are dropped. */
export function promiseReceipts(payments: readonly PromisePayment[]): PromiseReceipt[] {
  const out: PromiseReceipt[] = [];
  for (const p of payments) {
    if (p.status !== "received" || !p.customer_id) continue;
    const amount = wholeRupees(cashReceived({ amount: wholeRupees(p.amount), credit_applied: p.credit_applied }));
    if (amount > 0) out.push({ customerId: p.customer_id, on: toIstDate(p.received_at), amount });
  }
  return out;
}

/**
 * The IST day a promise was FIRST logged: the same date promised again later is the same
 * promise, and money paid since the first entry counts towards it.
 */
export function promiseLoggedOn(
  entries: readonly { customer_id?: string; promised_on: string | null; created_at: string }[],
  promisedOn: string,
  customerId?: string,
): string | null {
  let first: string | null = null;
  for (const e of entries) {
    if (e.promised_on?.slice(0, 10) !== promisedOn) continue;
    if (customerId !== undefined && e.customer_id !== undefined && e.customer_id !== customerId) continue;
    const d = toIstDate(e.created_at);
    if (first === null || d < first) first = d;
  }
  return first;
}

export function promiseStatus(p: {
  promisedOn: string;
  promisedAmount: number | null | undefined;
  /** IST day the promise was first logged (promiseLoggedOn). */
  loggedOn: string;
  today: string;
  /** This customer's received cash (promiseReceipts). */
  receipts: readonly Pick<PromiseReceipt, "on" | "amount">[];
  /** The customer still owes money now. */
  stillOwes: boolean;
}): { status: PromiseStatus; paid: number; want: number | null } {
  const on = p.promisedOn.slice(0, 10);
  const paid = p.receipts.filter((r) => r.on >= p.loggedOn && r.on <= on).reduce((s, r) => s + r.amount, 0);
  const want = p.promisedAmount != null && p.promisedAmount > 0 ? wholeRupees(p.promisedAmount) : null;
  const kept = !p.stillOwes || (want === null ? paid > 0 : paid >= want);
  const status: PromiseStatus = kept ? "kept" : on < p.today ? "broken" : on === p.today ? "due" : "open";
  return { status, paid, want };
}

/**
 * One customer's follow-ups, newest first, each promise with its status. `payments` = this
 * customer's payments since their oldest promise was logged (CollectionRow.payments); none →
 * only "debt cleared" can keep a promise.
 */
export function buildFollowupHistory(
  rows: readonly FollowupHistoryRow[],
  today: string,
  stillOwes: boolean,
  payments: readonly PromisePayment[] = [],
): FollowupHistoryEntry[] {
  const receipts = promiseReceipts(payments);
  return [...rows]
    .sort(compareFollowupsNewestFirst)
    .map((r) => {
      const on = r.promised_on?.slice(0, 10);
      const status = on
        ? promiseStatus({
            promisedOn: on,
            promisedAmount: r.promised_amount,
            loggedOn: promiseLoggedOn(rows, on) ?? toIstDate(r.created_at),
            today,
            receipts,
            stillOwes,
          }).status
        : null;
      return { ...r, promiseStatus: status, broken: status === "broken" };
    });
}
