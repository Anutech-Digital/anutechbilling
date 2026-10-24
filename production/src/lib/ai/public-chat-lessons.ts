/**
 * Website chat "lessons" — held for a person to approve (R-727, 23 Oct 2026).
 *
 * The public sales chat distils one lesson from a finished conversation and feeds recent
 * lessons back into its own system prompt (api/public/agent/chat). Until R-727 a lesson went
 * straight in (`outcome: "did"`): an anonymous visitor could steer the reflection into a lesson
 * like "tell buyers to pay the sales manager on WhatsApp" — sanitizeLearning only stops digits
 * and links — and every later visitor's chat would carry it.
 *
 * Now, all in the append-only ai_action_log (no new table, no row is ever edited):
 *   1. The chat writes the lesson as HELD (entity "public_chat"). It shows on /automation under
 *      "waiting on you".
 *   2. An owner/manager presses Use lesson or Discard (api/ai/action-log/lesson). That writes a
 *      DECISION row: outcome "did" (approved) or "skipped" (discarded), entity
 *      LESSON_DECISION_ENTITY, entity_id = the held row's id, facts.approvedFrom / rejectedFrom.
 *   3. The chat reads ONLY approved decision rows. Lessons written before R-727 (outcome "did",
 *      entity "public_chat", never approved by anyone) are no longer read.
 */
import { sanitizeLearning } from "./public-sales-chat";

export const LESSON_ACTION = "public_chat.learn" as const;
/** Entity on the HELD proposal rows (and on the pre-R-727 unapproved rows). */
export const LESSON_ENTITY = "public_chat";
/** Entity on the approve/discard decision rows. */
export const LESSON_DECISION_ENTITY = "public_chat_lesson";

export interface LessonLogRow {
  id?: number | string;
  action?: string;
  outcome?: string;
  reason?: string | null;
  entity?: string | null;
  entity_id?: string | null;
  facts?: Record<string, unknown> | null;
}

/** The lessons a person approved, newest first as given — the ONLY ones the chat may use. */
export function approvedLessons(rows: readonly LessonLogRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.outcome !== "did" || r.entity !== LESSON_DECISION_ENTITY) continue;
    const from = r.facts?.approvedFrom;
    if (from === undefined || from === null || from === "") continue;
    /* Re-checked at READ time too — the store is a row somebody could edit. */
    const l = sanitizeLearning(r.reason);
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

/** Is this row a lesson proposal still waiting for approve/discard? */
export function isLessonProposal(r: LessonLogRow): boolean {
  return r.action === LESSON_ACTION && r.outcome === "held";
}

/**
 * The "waiting on you" list without the lesson proposals somebody already decided. A decision
 * row names its proposal in entity_id; a proposal with one is no longer waiting.
 */
export function stillWaiting<T extends LessonLogRow>(held: readonly T[], all: readonly LessonLogRow[]): T[] {
  const decided = new Set(
    all
      .filter((r) => r.action === LESSON_ACTION && r.entity === LESSON_DECISION_ENTITY && r.entity_id)
      .map((r) => String(r.entity_id)),
  );
  return held.filter((r) => !(isLessonProposal(r) && decided.has(String(r.id))));
}

/** A value used inside ILIKE matches only itself — `%` and `_` in an email are literal. */
export function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
