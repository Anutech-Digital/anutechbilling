/**
 * The rules a DEAL must satisfy — one place, so the Add/Edit form, the Kanban drag-drop and
 * the deal card cannot drift apart (audit, 30 Sep 2026).
 *
 *   • Which stages are "real deals" (the /deals page) — quote, demo, trial, won, lost.
 *     New / Contacted stay on /leads.
 *   • Expected close date — `leads.expected_close_date` existed but no screen wrote it, so
 *     "Closing this month" and the forecast were always empty. It is required once a deal is
 *     at quote / demo / trial / won, may not be set in the past (IST), and an open deal
 *     whose date has gone by is shown as overdue.
 *   • A board drag obeys the same gate as the form: no jumping the quote-first gate from
 *     New / Contacted (lib/leads/stage-options.ts), and Won needs a value and a close date.
 *
 * Pure: `today` is a parameter (IST YYYY-MM-DD, lib/dates/ist#istToday) so tests pin it.
 */
import type { Lead } from "@/lib/supabase/database.types";
import { rowStageOptions } from "@/lib/leads/stage-options";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";
import { toIstDate } from "@/lib/dates/ist";

type Stage = Lead["stage"];

/** Stages the /deals page holds. New / Contacted are leads, not deals. */
export const DEALS_PAGE_STAGES: readonly Stage[] = ["quote", "demo", "trial", "won", "lost"];

export function isDealStage(stage: Stage): boolean {
  return DEALS_PAGE_STAGES.includes(stage);
}

/** Stages at which a deal must carry plan, company and an expected close date. */
export const DEAL_DETAIL_STAGES: readonly Stage[] = ["quote", "demo", "trial", "won"];

export function needsDealDetails(stage: Stage): boolean {
  return DEAL_DETAIL_STAGES.includes(stage);
}

// ── Expected close date ─────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-15" → "15 Oct". The column is a plain `date`, so no timezone shift. */
export function closeDateShort(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  if (!m || !d) return iso;
  return `${d} ${MONTHS[m - 1]}`;
}

/**
 * R-1477: the IST date a Won deal was won — null for any other stage. A Won deal's
 * `expected_close_date` is only the forecast it carried (often still in the future), so the
 * card and detail page show this instead. `stage_changed_at` is set by trigger on every stage
 * move; deals won before that column existed fall back to `updated_at`.
 */
export function wonOnDate(
  l: Pick<Lead, "stage" | "stage_changed_at" | "updated_at">,
): string | null {
  if (l.stage !== "won") return null;
  const at = l.stage_changed_at ?? l.updated_at;
  return at ? toIstDate(at) : null;
}

/** An OPEN deal whose expected close date is before today (IST). Won / lost are finished. */
export function isCloseOverdue(
  l: Pick<Lead, "stage" | "expected_close_date">, today: string,
): boolean {
  if (!l.expected_close_date || l.stage === "won" || l.stage === "lost") return false;
  return l.expected_close_date < today;
}

// ── The Add / Edit form ─────────────────────────────────────────────────────

export type DealFormField = "company" | "plan" | "requirement" | "value" | "expected_close_date";

export interface DealFormInput {
  stage: Stage;
  isProject: boolean;
  company: string | null | undefined;
  plan: string | null | undefined;
  requirement: string | null | undefined;
  value: number | null | undefined;
  expectedClose: string | null | undefined;
  /** IST today, YYYY-MM-DD. */
  today: string;
  /** The date already saved on the lead being edited — an overdue deal can still be saved
   *  without being forced to invent a new date in the same breath. */
  savedClose?: string | null;
}

/**
 * The deal rules zod cannot express statically (they depend on the stage and on today).
 * Empty object = fine.
 */
export function dealFormErrors(i: DealFormInput): Partial<Record<DealFormField, string>> {
  const out: Partial<Record<DealFormField, string>> = {};
  const close = (i.expectedClose ?? "").trim();
  if (close && close < i.today && close !== (i.savedClose ?? "")) {
    out.expected_close_date = "Pick today or later";
  }
  /* 6 Oct 2026 (Pardeep's report): a typed ₹0 was saved as the deal value. Blank stays fine
     — the lead waits in the inbox until someone knows the amount — but 0 is not an amount,
     at any stage. Negative never reaches here: the form's zod min(0) refuses it first. */
  if (i.value === 0) out.value = "₹0 is not a deal value — leave it blank if the amount is not known yet";
  if (!needsDealDetails(i.stage)) return out;

  if ((i.company ?? "").trim().length < 2) out.company = "Company is required";
  if (i.isProject) {
    if (!(i.requirement ?? "").trim()) out.requirement = "Requirement is required";
  } else if (!(i.plan ?? "").trim()) {
    out.plan = "Plan is required";
  }
  if (!close) out.expected_close_date = "Expected close is required";
  if (i.stage === "won" && !((i.value ?? 0) > 0)) out.value = "Value is required for Won";
  return out;
}

// ── Kanban drag-drop ────────────────────────────────────────────────────────

export type MoveVerdict =
  | { ok: true }
  | { ok: false; title: string; description: string };

/**
 * May the board move this card to `to`? Same gate as the form and the row dropdown.
 * A refusal says what is missing and what to do (§24), and the caller leaves the card
 * where it was.
 */
export function checkBoardMove(
  lead: Pick<Lead, "stage" | "company" | "value" | "expected_close_date">, to: Stage,
): MoveVerdict {
  if (lead.stage === to) return { ok: true };
  const name = lead.company?.trim() || "This lead";

  /* R-1762: a Won deal may go to Lost (the customer backed out) — the money check and the
     lost reason follow in useChangeLeadStage, and the database refuses it with money behind it.
     Any other move out of Won is not a board move: a mistaken accept is undone on the quote. */
  if (lead.stage === "won" && to !== "lost") {
    return {
      ok: false,
      title: `${name} is already won`,
      description: "Accepted by mistake? Open the quote → Reopen. Customer backed out? Use Mark lost.",
    };
  }

  if (!rowStageOptions(lead.stage).includes(to)) {
    const preQuote = lead.stage === "new" || lead.stage === "contact";
    return preQuote && isDealStage(to)
      ? {
          ok: false,
          title: `${name}: Send a quote first`,
          description: `Sending a quote moves it to ${STAGE_LABEL.quote}. Open the lead → Send quote.`,
        }
      : {
          ok: false,
          title: `Can't move ${STAGE_LABEL[lead.stage]} → ${STAGE_LABEL[to]}`,
          description: "Open the lead to change its stage.",
        };
  }

  if (to === "won") {
    const missing: string[] = [];
    if (!((lead.value ?? 0) > 0)) missing.push("deal value (₹)");
    if (!lead.expected_close_date) missing.push("expected close");
    if (missing.length > 0) {
      return {
        ok: false,
        title: `Can't mark Won yet — missing: ${missing.join(", ")}`,
        description: `${name}: open the lead → Edit, fill these in, then drag again.`,
      };
    }
  }
  return { ok: true };
}

// ── Leaving Won (R-1762) ────────────────────────────────────────────────────

/** The refusal when a Won deal has money behind it — the same words the database raises
 *  (migration 20261022120019_r1762_won_deal_undo, trigger trg_r1762_won_exit_guard). */
export function wonMoneyRefusal(company: string | null | undefined): string {
  const name = company?.trim() || "This deal";
  return `${name} has a payment or invoice — refund or credit-note it first, then mark it lost.`;
}

/**
 * May a deal leave Won? Only when none of its quotes has a received payment, a live invoice or a
 * subscription (`hasMoney`, from the lead_has_money RPC). Deals that are not Won pass.
 */
export function checkWonExit(
  lead: Pick<Lead, "stage" | "company">, to: Stage, hasMoney: boolean,
): MoveVerdict {
  if (lead.stage !== "won" || to === "won" || !hasMoney) return { ok: true };
  return {
    ok: false,
    title: `Can't mark ${lead.company?.trim() || "this deal"} ${STAGE_LABEL[to]}`,
    description: wonMoneyRefusal(lead.company),
  };
}

// ── Deal value from seats × price ───────────────────────────────────────────

/**
 * The value the form should write, or null for "leave the value alone".
 *
 * `armed` is true only after the USER changed seats, price per seat or plan in this sitting.
 * Opening Edit on a saved deal is not a change — the old effect recalculated on open and
 * overwrote a negotiated value with list price × seats × 12 (audit, 30 Sep 2026).
 * `valueTyped` = the user typed a value themselves; it wins until they clear it.
 */
export function autoDealValue(i: {
  armed: boolean; valueTyped: boolean; seats: number | null | undefined; pricePerSeat: number | null | undefined;
}): number | null {
  if (!i.armed || i.valueTyped) return null;
  const seats = i.seats ?? 0;
  const price = i.pricePerSeat ?? 0;
  if (!Number.isFinite(seats) || !Number.isFinite(price) || seats < 1 || price <= 0) return null;
  return Math.round(seats * price * 12);
}
