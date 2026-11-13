/**
 * R-2738 (Pardeep, 13 Nov 2026 — Renewals audit §5.1 / §5.2, problems P2–P5): ONE stage per
 * Renewals row (one chip) and ONE primary button that follows from that stage.
 *
 * Before: a row carried the status chip (renewalRowStatus), a second "decision" chip
 * (renewalDecision: Not contacted / Quote sent / Confirmed / Invoiced), "Overdue Nd" again in the
 * date cell, and up to four buttons ("Renew anyway" + "Cancel" + the primary + ⋯) whose verb
 * changed with the billing cycle and the quote status — six verbs for one job (get paid for the
 * next term). This module replaces both chips and the button choice. Pure — no I/O; the page
 * hands in what it already reads (subscription, linked renewal document, the renewal's unpaid
 * invoice, follow-up / risk facts). Tested in stage-r2738.test.ts.
 *
 * Stage, first match wins:
 *   stopped   Service stopped                         (status / renewal_state suspended)
 *   ending    Won't renew · ends <date>               (auto_renew = false)
 *   renewed   Renewed                                 (the renewal is PAID — never on raise: R-2735 / money rule N7)
 *   invoiced  Invoiced · ₹x due | ₹x overdue Nd       (the renewal's tax invoice is raised and something is still due)
 *   draft     Draft part quote · <period> / Draft renewal quote   (ownerRule2: the editor was closed unsaved)
 *   sent      Renewal quote sent · <period>           (renewal quote / the part's quote with the customer, unpaid)
 *   part-due  Part not billed (<Mon>) / N parts not billed        (billed in parts, the next term's part started, nothing raised)
 *   due       Due in Nd / Due today / Overdue Nd      (nothing sent yet)
 *
 * Why invoiced / draft / sent come BEFORE part-due (the audit listed part-due first): since R-2735
 * "Bill next part" no longer moves renewal_date, so partsDue() — which counts by dates only — still
 * counts the part that was just billed. An open renewal document is the truth for that part.
 * A stale 'renewed' state (rolled on raise before R-2735, never repaired) with an unpaid part bill
 * is NOT Renewed: the money is not in.
 *
 * Primary button (renewalPrimary), one label per intention:
 *   due (whole term)  Send renewal    — opens the quote editor (R-2710) / send-now with confirm for a
 *                                       role that cannot open quotes
 *   due (in parts)    Bill next part  — only inside the 7-day window before the part's due date
 *                                       (ownerRule, IST); earlier Follow up, and Bill next part in ⋯
 *   part-due          Bill next part
 *   draft             Continue        — reopens THAT quote (R-2232: never a second one)
 *   sent              Follow up
 *   invoiced          Record payment
 *   ending / renewed / stopped  none
 * Retired as row labels: Review / Change renewal quote, Send renewal quote, Bill renewal · part 1
 * of next year / term.
 * Grace over (past the date and the grace, unpaid): "Renew anyway" (owner / manager, vendor hold)
 * and "Cancel" move INTO ⋯ — no more buttons side by side (P3).
 */
import { isSplitBilled } from "@/lib/billing/instalments";
import type { BillingCycle } from "@/lib/supabase/database.types";
import { partsDue } from "@/lib/renewals/split-billed-next-part";
import { canRenewAnyway, type VendorHoldState } from "@/lib/renewals/vendor-hold";
import { RENEWAL_FUTURE_DAYS, RENEWAL_UPCOMING_DAYS, RENEWAL_URGENT_DAYS } from "@/lib/renewals/buckets";
import { canOpenQuotes } from "@/lib/quotes/access";
import { formatDate, rupee } from "@/lib/utils";
import { isSettledRenewed } from "@/app/(app)/renewals/row-action";
import { isGraceOver } from "@/components/features/renewals/renewal-actions-rules";

// ─── Input ──────────────────────────────────────────────────────────────────

export interface StageSub {
  status?: string | null;
  renewal_state?: string | null;
  renewal_date: string | null;
  term_months?: number | null;
  billing_cycle?: string | null;
  start_date?: string | null;
  auto_renew?: boolean | null;
  grace_until?: string | null;
  renewal_quote_id?: string | null;
}

/** The renewal's open document: the linked renewal quote, or the part's quote that Bill next part made. */
export interface StageDoc {
  /** renewal = the whole-term renewal quote; part = the quote / proforma for a billed part. */
  kind: "renewal" | "part";
  quoteId: string;
  /** quotes.status — draft / sent / viewed / accepted (anything else is not open). */
  status: string;
  /** quotes.payment_status — received = paid. */
  paymentStatus?: string | null;
  /** part: the date the part is due (subscription_billings.due_on / period_start). */
  dueDate?: string | null;
  /** The period it covers, in words ("Dec 2026", "1 Dec 2026 – 30 Nov 2027"); null = not known. */
  period?: string | null;
}

/** The renewal's tax invoice (raised from the renewal quote, or for the renewal's part). */
export interface StageInvoice {
  id: string;
  kind: "renewal" | "part";
  /** What is still to collect (net payable − money in), rupees / the invoice currency. */
  amountDue: number;
  currency?: string | null;
  /** part: the part's due date; else the renewal date is used. */
  dueDate?: string | null;
  period?: string | null;
}

/** Facts shown as small icons after the chip — never a second chip. */
export interface StageFlagInput {
  /** renewalRisk(...).level === "high" and its reasons. */
  atRisk?: { reasons: readonly string[] } | null;
  vendorHold?: VendorHoldState | null;
  /** priorTermDueText(...) — "Previous term ₹x still unpaid"; null = nothing owed. */
  priorTermUnpaid?: string | null;
  promiseBroken?: { promisedOn: string | null } | null;
  followUpDue?: { nextFollowUpOn: string | null } | null;
}

export interface StageInput {
  sub: StageSub;
  /** Today in IST, YYYY-MM-DD. */
  todayIst: string;
  /** The renewal is paid: its renewal quote's payment_status = received, or the renewal part's invoice is paid (R-2735). */
  renewalPaid?: boolean;
  /** The renewal's open document (draft / sent / viewed / accepted and unpaid), if any. */
  doc?: StageDoc | null;
  /** The renewal's tax invoice with money still due, if any. */
  invoice?: StageInvoice | null;
  flags?: StageFlagInput;
}

// ─── Stage ──────────────────────────────────────────────────────────────────

export type StageKey = "stopped" | "ending" | "renewed" | "invoiced" | "draft" | "sent" | "part-due" | "due";
export type StageTone = "danger" | "warning" | "info" | "success" | "muted";

export type FlagKey = "atRisk" | "vendorHold" | "priorTermUnpaid" | "promiseBroken" | "followUpDue";
export interface StageFlag { key: FlagKey; reason: string }

export interface RenewalStage {
  key: StageKey;
  /** The ONE chip on the row. */
  label: string;
  tone: StageTone;
  /** A second line only when the chip shows the period instead of the day count ("Overdue 3d"). */
  note: string | null;
  /** IST days to the date that counts (the part's due date for a part, else renewal_date); null = no date. */
  days: number | null;
  split: boolean;
  /** The open document / invoice the stage is about (for Continue / Follow up / Record payment). */
  quoteId: string | null;
  invoiceId: string | null;
  /** part-due: how many parts have started unbilled. */
  partsBehind: number;
  flags: StageFlag[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const OPEN_DOC = new Set(["sent", "viewed", "accepted"]);

/** Whole calendar days from one IST date to another (YYYY-MM-DD); negative = in the past. */
export function istDays(fromIst: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIst.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** "Due in 5d" / "Due today" / "Overdue 3d" — one wording (queue.ts renewalDueText). */
export function dueWords(days: number): string {
  if (days < 0) return `Overdue ${-days}d`;
  if (days === 0) return "Due today";
  return `Due in ${days}d`;
}

/** Red when overdue or ≤7 days, amber 8–30, grey after (audit §5.1). */
export function daysTone(days: number | null): StageTone {
  if (days == null) return "muted";
  if (days <= RENEWAL_URGENT_DAYS) return "danger";
  if (days <= RENEWAL_UPCOMING_DAYS) return "warning";
  return "muted";
}

function money(amount: number, currency: string | null | undefined): string {
  if (currency && currency.toUpperCase() === "USD") return `$${Math.round(amount).toLocaleString("en-US")}`;
  return rupee(Math.round(amount));
}

const isSplit = (sub: StageSub) => isSplitBilled((sub.billing_cycle ?? null) as BillingCycle | null);

/** A noon-IST Date for helpers that take a Date (isSettledRenewed). */
const istNoon = (todayIst: string) => new Date(`${todayIst.slice(0, 10)}T06:30:00Z`);

function stageFlags(f: StageFlagInput | undefined): StageFlag[] {
  if (!f) return [];
  const out: StageFlag[] = [];
  if (f.atRisk) out.push({ key: "atRisk", reason: f.atRisk.reasons.length ? `At risk: ${f.atRisk.reasons.join(", ")}` : "At risk" });
  if (f.vendorHold === "hold") out.push({ key: "vendorHold", reason: "Payment due — do not renew at the vendor yet" });
  if (f.priorTermUnpaid) out.push({ key: "priorTermUnpaid", reason: f.priorTermUnpaid });
  if (f.promiseBroken) out.push({ key: "promiseBroken", reason: f.promiseBroken.promisedOn ? `Promised to pay by ${formatDate(f.promiseBroken.promisedOn)} — not paid` : "Payment promise broken" });
  if (f.followUpDue) out.push({ key: "followUpDue", reason: f.followUpDue.nextFollowUpOn ? `Follow-up due ${formatDate(f.followUpDue.nextFollowUpOn)}` : "Follow-up due" });
  return out;
}

/**
 * The row's ONE stage. First match wins (see the file header). `doc` / `invoice` that are paid,
 * closed or zero are ignored here, so a page that passes a stale one cannot make a row "owe".
 */
export function renewalStage(input: StageInput): RenewalStage {
  const { sub, todayIst } = input;
  const split = isSplit(sub);
  const renewalDays = sub.renewal_date ? istDays(todayIst, sub.renewal_date) : null;
  const base = { split, quoteId: null, invoiceId: null, partsBehind: 0, note: null };
  const live = (s: Omit<RenewalStage, "flags">): RenewalStage => ({ ...s, flags: stageFlags(input.flags) });

  if (sub.status === "suspended" || sub.renewal_state === "suspended") {
    return { ...base, key: "stopped", label: "Service stopped", tone: "danger", days: renewalDays, flags: [] };
  }
  if (sub.auto_renew === false) {
    const label = sub.renewal_date ? `Won't renew · ends ${formatDate(sub.renewal_date)}` : "Won't renew";
    return { ...base, key: "ending", label, tone: "warning", days: renewalDays, flags: [] };
  }

  const d = input.doc ?? null;
  const doc = d && (OPEN_DOC.has(d.status) || d.status === "draft") && d.paymentStatus !== "received" ? d : null;
  const invoice = input.invoice && input.invoice.amountDue > 0 ? input.invoice : null;

  if (input.renewalPaid || d?.paymentStatus === "received") return { ...base, key: "renewed", label: "Renewed", tone: "success", days: renewalDays, flags: [] };
  /* A settled 'renewed' state counts only when no renewal document is still unpaid (pre-R-2735 rows rolled on raise). */
  if (!doc && !invoice && isSettledRenewed(sub, istNoon(todayIst))) {
    return { ...base, key: "renewed", label: "Renewed", tone: "success", days: renewalDays, flags: [] };
  }

  if (invoice) {
    const ref = invoice.kind === "part" && invoice.dueDate ? invoice.dueDate : sub.renewal_date;
    const days = ref ? istDays(todayIst, ref) : null;
    const amt = money(invoice.amountDue, invoice.currency);
    const label = days != null && days < 0 ? `Invoiced · ${amt} overdue ${-days}d` : `Invoiced · ${amt} due`;
    return live({ ...base, key: "invoiced", label, tone: daysTone(days), days, invoiceId: invoice.id, note: invoice.period ?? null });
  }

  if (doc) {
    const ref = doc.kind === "part" && doc.dueDate ? doc.dueDate : sub.renewal_date;
    const days = ref ? istDays(todayIst, ref) : null;
    const period = doc.period?.trim() || null;
    if (doc.status === "draft") {
      const word = doc.kind === "part" ? "Draft part quote" : "Draft renewal quote";
      return live({
        ...base, key: "draft", label: period ? `${word} · ${period}` : word,
        tone: daysTone(days), days, quoteId: doc.quoteId, note: days != null ? dueWords(days) : null,
      });
    }
    /* ownerRule (13 Nov): "renewal quote sent with this period" — the period on the chip, the day count under it. */
    return live({
      ...base, key: "sent",
      label: period ? `Renewal quote sent · ${period}` : "Renewal quote sent",
      tone: daysTone(days), days, quoteId: doc.quoteId, note: days != null ? dueWords(days) : null,
    });
  }

  if (split && sub.renewal_date) {
    const behind = partsDue({
      billing_cycle: (sub.billing_cycle ?? null) as BillingCycle | null,
      term_months: sub.term_months ?? 12,
      start_date: sub.start_date ?? null,
      renewal_date: sub.renewal_date,
    }, todayIst);
    if (behind) {
      const label = behind.count === 1 ? `Part not billed (${MONTHS[Number(behind.from.slice(5, 7)) - 1]})` : `${behind.count} parts not billed`;
      return live({ ...base, key: "part-due", label, tone: "danger", days: renewalDays, partsBehind: behind.count });
    }
  }

  return live({
    ...base, key: "due",
    label: renewalDays == null ? "No renewal date" : dueWords(renewalDays),
    tone: daysTone(renewalDays), days: renewalDays,
  });
}

// ─── Primary button + ⋯ menu ────────────────────────────────────────────────

export const SEND_RENEWAL = "Send renewal";
export const BILL_NEXT_PART = "Bill next part";
export const CONTINUE = "Continue";
export const FOLLOW_UP = "Follow up";
export const RECORD_PAYMENT = "Record payment";
/** ownerRule (13 Nov): a part's Bill next part is the main button only from this many days before its due date. */
export const BILL_PART_WINDOW_DAYS = 7;

export type PrimaryKind = "send-renewal" | "bill-part" | "continue" | "follow-up" | "record-payment";

export interface PrimaryAction {
  kind: PrimaryKind;
  label: string;
  /** send-renewal / bill-part / continue: open the quote editor first (R-2710, ownerRule2). false = the confirm path. */
  opensEditor: boolean;
  quoteId: string | null;
  invoiceId: string | null;
}

/** ⋯ items, in the order they show; the ending ones last. */
export type MenuItem =
  | "send-as-is" | "bill-part" | "record-payment" | "change-renewal" | "resend" | "resend-invoice"
  | "follow-up" | "nudge" | "voice" | "renew-anyway" | "not-renewing" | "cancel" | "undo-wont-renew" | "view-subscription";

export const MENU_LABEL: Record<MenuItem, string> = {
  "send-as-is": "Send as is (no changes)",
  "bill-part": BILL_NEXT_PART,
  "record-payment": RECORD_PAYMENT,
  "change-renewal": "Change renewal",
  resend: "Resend",
  "resend-invoice": "Resend invoice / link",
  "follow-up": FOLLOW_UP,
  nudge: "Nudge",
  voice: "Voice",
  "renew-anyway": "Renew anyway",
  "not-renewing": "Customer not renewing",
  cancel: "Cancel subscription",
  "undo-wont-renew": "Undo won't renew",
  "view-subscription": "View subscription",
};

export interface PrimaryContext {
  role: string | null | undefined;
  /** The user may end a subscription (Won't renew / Cancel dialogs). */
  canEndSubscription: boolean;
  tenantGraceDays: number;
  /** The screen offers a Follow up dialog / Nudge + Voice (Renewals does; Payment Follow-up passes neither). */
  offers: { followup: boolean; messaging: boolean };
  vendorHold?: VendorHoldState | null;
}

export interface RowActions {
  /** The ONE button; null = nothing to do on this row. */
  primary: PrimaryAction | null;
  menu: MenuItem[];
  /** Past the date and the grace, unpaid — Renew anyway / Cancel are in the menu. */
  graceOver: boolean;
}

const btn = (kind: PrimaryKind, label: string, opensEditor: boolean, stage: RenewalStage): PrimaryAction =>
  ({ kind, label, opensEditor, quoteId: stage.quoteId, invoiceId: stage.invoiceId });

/**
 * ONE primary button + the ⋯ list for a stage. `sub` is the same subscription renewalStage read
 * (grace and Won't-renew need its dates).
 */
export function renewalPrimary(stage: RenewalStage, sub: StageSub, ctx: PrimaryContext): RowActions {
  const canQuote = canOpenQuotes(ctx.role);
  const followUp = ctx.offers.followup ? btn("follow-up", FOLLOW_UP, false, stage) : null;
  const days = stage.days ?? 0;
  const graceOver = (stage.key === "due" || stage.key === "part-due" || stage.key === "draft" || stage.key === "sent" || stage.key === "invoiced")
    && isGraceOver(sub, stage.days ?? 0, ctx.tenantGraceDays);

  let primary: PrimaryAction | null = null;
  const menu: MenuItem[] = [];
  switch (stage.key) {
    case "stopped":
    case "renewed":
      return { primary: null, menu: ["view-subscription"], graceOver: false };
    case "ending":
      return { primary: null, menu: ctx.canEndSubscription ? ["undo-wont-renew"] : [], graceOver: false };
    case "due":
      if (stage.split) {
        /* ownerRule: inside the 7-day window the part is the next step; earlier only in ⋯ (early billing). */
        primary = days <= BILL_PART_WINDOW_DAYS ? btn("bill-part", BILL_NEXT_PART, canQuote, stage) : followUp;
      } else {
        primary = btn("send-renewal", SEND_RENEWAL, canQuote, stage);
        if (canQuote) menu.push("send-as-is");
      }
      break;
    case "part-due":
      primary = btn("bill-part", BILL_NEXT_PART, canQuote, stage);
      break;
    case "draft":
      /* R-2232: Continue reopens the same quote; without the editor the whole-term draft is sent as is. */
      if (canQuote) primary = btn("continue", CONTINUE, true, stage);
      else if (!stage.split && stage.quoteId) primary = btn("send-renewal", SEND_RENEWAL, false, stage);
      else primary = followUp;
      if (canQuote && !stage.split) menu.push("send-as-is");
      break;
    case "sent":
      primary = followUp ?? btn("record-payment", RECORD_PAYMENT, false, stage);
      if (primary.kind !== "record-payment") menu.push("record-payment");
      if (canQuote && !stage.split) menu.push("change-renewal");
      menu.push("resend");
      break;
    case "invoiced":
      primary = btn("record-payment", RECORD_PAYMENT, false, stage);
      menu.push("resend-invoice");
      break;
  }

  /* ownerRule (3): Bill next part stays in ⋯ on a live split row (early billing) whenever it is not the button. */
  if (stage.split && primary?.kind !== "bill-part") menu.push("bill-part");
  if (ctx.offers.followup && primary?.kind !== "follow-up") menu.push("follow-up");
  if (ctx.offers.messaging) menu.push("nudge", "voice");
  if (graceOver && canRenewAnyway(ctx.role) && ctx.vendorHold === "hold") menu.push("renew-anyway");
  if (ctx.canEndSubscription) menu.push(graceOver ? "cancel" : "not-renewing");
  return { primary, menu: [...new Set(menu)], graceOver };
}

/** Which dialog "Customer not renewing" opens: Won't renew before the date, Cancel after it. */
export function notRenewingDialog(stage: RenewalStage): "non-renewing" | "cancel" {
  return (stage.days ?? 0) < 0 ? "cancel" : "non-renewing";
}

// ─── Bulk "Send renewal" ────────────────────────────────────────────────────

/** R-2586: why bulk Send renewal skips a row 91+ days out. */
export const BULK_LATER_REASON = "renews in 91+ days — too early to send";

/**
 * Bulk Send renewal takes a row only when its own button is Send renewal (never a split row —
 * R-808, never one already sent / invoiced / renewed — R-2232) and it is not 91+ days out (R-2586).
 * Otherwise the reason names the row's own state / button.
 */
export function bulkSendDecision(stage: RenewalStage, actions: RowActions): { send: true } | { send: false; reason: string } {
  if (actions.primary?.kind === "send-renewal") {
    return (stage.days ?? 0) > RENEWAL_FUTURE_DAYS ? { send: false, reason: BULK_LATER_REASON } : { send: true };
  }
  if (stage.split && stage.key !== "renewed" && stage.key !== "ending" && stage.key !== "stopped") {
    return { send: false, reason: `billed in parts — use ${BILL_NEXT_PART}` };
  }
  return { send: false, reason: stage.label };
}
