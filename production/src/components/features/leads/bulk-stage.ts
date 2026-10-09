/**
 * R-457: which selected leads may the bulk bar move to `stage`?
 *
 * The bulk bar used to write any stage to any lead. "Change stage → Won" on a lead with no
 * quote turned it Won with no customer, no payment and no subscription — the win rate went
 * up and the lead left the pipeline with nothing behind it.
 *
 * Won is never a bulk move: a lead becomes Won when its quote is accepted and paid (the quote
 * page's Record payment), which also creates the customer. Every other stage uses the same
 * gate as dragging a card on the board (lib/leads/deal-rules.ts#checkBoardMove).
 */
import type { Lead } from "@/lib/supabase/database.types";
import { checkBoardMove } from "@/lib/leads/deal-rules";

type Row = Pick<Lead, "id" | "stage" | "company" | "value" | "expected_close_date">;

export const BULK_WON_REFUSAL = {
  title: "Won can't be set in bulk",
  description: "A lead becomes Won when its quote is paid — open the lead → quote → Record payment. That also creates the customer.",
} as const;

export interface BulkPlan<T extends Row> {
  /** Leads that will move. */
  move: T[];
  /** Leads left where they are, with the first reason (for the toast). */
  refused: T[];
  reason: { title: string; description: string } | null;
}

export function planBulkStage<T extends Row>(rows: readonly T[], stage: Lead["stage"]): BulkPlan<T> {
  const targets = rows.filter((l) => l.stage !== stage);
  if (stage === "won") {
    return { move: [], refused: targets, reason: targets.length ? { ...BULK_WON_REFUSAL } : null };
  }
  const move: T[] = [];
  const refused: T[] = [];
  let reason: BulkPlan<T>["reason"] = null;
  for (const l of targets) {
    const v = checkBoardMove(l, stage);
    if (v.ok) { move.push(l); continue; }
    refused.push(l);
    reason ??= { title: v.title, description: v.description };
  }
  return { move, refused, reason };
}
