/**
 * Reading the contract amendment ledger.
 *
 * The rows are written by a Postgres trigger and can never be edited, so everything
 * here is presentation: turning `{"seats":{"from":10,"to":30}}` into a sentence a
 * customer-facing conversation can be had over.
 *
 * ─── IT DESCRIBES WHAT CHANGED, NOT WHY ─────────────────────────────────────
 * The trigger sees a subscription go from 10 seats to 30. It cannot know whether that
 * was an approved seat request, a correction of a typo, or somebody's mistake — so
 * this never guesses a reason. "Seats went from 10 to 30" is a fact; "Customer added
 * 20 seats" is a story, and in a dispute the difference is the whole point.
 */
import type { ContractAmendment } from "@/lib/supabase/database.types";

export type AmendmentTone = "increase" | "decrease" | "neutral" | "warning";

export interface AmendmentLine {
  /** Plain sentence, no jargon. */
  text: string;
  tone: AmendmentTone;
}

const FIELD_LABEL: Record<string, string> = {
  seats: "Seats",
  mrr: "Monthly price",
  plan: "Plan",
  renewal_date: "Renewal date",
  status: "Status",
  billing_cycle: "Billing frequency",
};

/** ₹ formatting kept local so this module has no UI dependency. */
function money(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN")}` : String(v ?? "—");
}

function plain(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

/** One readable line per field that moved. */
export function describeAmendment(a: ContractAmendment): AmendmentLine[] {
  const out: AmendmentLine[] = [];
  const changes = a.changes ?? {};

  for (const [field, move] of Object.entries(changes)) {
    const label = FIELD_LABEL[field] ?? field;
    const from = move?.from;
    const to = move?.to;

    if (field === "mrr") {
      const up = Number(to) > Number(from);
      out.push({
        text: `${label}: ${money(from)} → ${money(to)}`,
        tone: up ? "increase" : "decrease",
      });
      continue;
    }
    if (field === "seats") {
      const up = Number(to) > Number(from);
      const delta = Math.abs(Number(to) - Number(from));
      out.push({
        text: `${label}: ${plain(from)} → ${plain(to)} (${up ? "+" : "−"}${delta})`,
        tone: up ? "increase" : "decrease",
      });
      continue;
    }
    if (field === "status") {
      /* A move to paused or cancelled is the one status change worth colouring —
         it is what somebody is looking for when they open this list. */
      const bad = to === "paused" || to === "cancelled" || to === "expired";
      out.push({ text: `${label}: ${plain(from)} → ${plain(to)}`, tone: bad ? "warning" : "neutral" });
      continue;
    }
    out.push({ text: `${label}: ${plain(from)} → ${plain(to)}`, tone: "neutral" });
  }

  return out;
}

/**
 * An amendment row as read with `select("*")`. `actor_label` arrives with migration
 * 20261007040000 (R-096) and is optional here on purpose: until that migration is
 * applied the column is simply absent from the row, and the reader must behave exactly
 * as before rather than crash. Naming the column in a select would 42703 on such a DB.
 */
export type AmendmentWithActor = ContractAmendment & { actor_label?: string | null };

/** Who made the change, in words. */
export function amendmentActor(a: AmendmentWithActor, nameById?: Map<string, string>): string {
  if (a.source === "system") {
    /* Named as automatic rather than left blank. An unattributed change reads as
       hidden; "automatic" reads as explainable. */
    return "Automatic (renewal, payment or import)";
  }
  if (a.changed_by && nameById?.has(a.changed_by)) return nameById.get(a.changed_by)!;
  if (a.changed_by) return "A team member";
  /* R-326: a portal customer has no public.users row, so changed_by is null and the
     trigger records who it was in actor_label ("Customer Acme Pvt Ltd"). */
  const label = typeof a.actor_label === "string" ? a.actor_label.trim() : "";
  return label || "Unknown";
}

/**
 * The seat history alone — what a seat dispute actually needs.
 *
 * Oldest first, because the question is "how did we get to 30?" and that reads
 * forwards.
 */
export function seatHistory(amendments: readonly ContractAmendment[]): Array<{
  at: string; from: number; to: number; delta: number; source: string;
}> {
  return amendments
    .filter((a) => a.seats_from != null && a.seats_to != null)
    .slice()
    .sort((x, y) => x.created_at.localeCompare(y.created_at))
    .map((a) => ({
      at: a.created_at,
      from: a.seats_from!,
      to: a.seats_to!,
      delta: a.seats_to! - a.seats_from!,
      source: a.source,
    }));
}

/**
 * Does the ledger's seat history reconcile with where the subscription is now?
 *
 * A gap means seats moved without the trigger seeing it — which should be
 * impossible, and is exactly the kind of thing worth surfacing rather than trusting.
 * Returns null when there is no history to check against.
 */
export function seatHistoryReconciles(
  amendments: readonly ContractAmendment[],
  currentSeats: number,
): boolean | null {
  const hist = seatHistory(amendments);
  if (hist.length === 0) return null;
  return hist[hist.length - 1].to === currentSeats;
}
