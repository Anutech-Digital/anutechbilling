/**
 * R-389 (F4) — the quote builder's per-line "Commit" select.
 *
 * It offered only "Monthly flex" and "Annual (1-yr)", and showed a line with NO commitment
 * as Annual — but a line without a commitment is a one-time charge: record_payment and
 * activate_quote_on_credit skip it (`commitment is not null`), so no subscription is made.
 * A custom "Data migration" line on Q-FBB9-27-0013 read "Annual (1-yr)" while saved as
 * one-off. The select now has "One-time" and shows what is saved.
 */
import type { LineCommitment } from "@/lib/supabase/database.types";

export type CommitChoice = "one_time" | "monthly" | "annual";

export const COMMIT_CHOICES: ReadonlyArray<{ value: CommitChoice; label: string }> = [
  { value: "one_time", label: "One-time" },
  { value: "monthly", label: "Monthly flex" },
  { value: "annual", label: "Annual (1-yr)" },
];

/** What the select shows for a saved line. */
export function commitChoiceOf(commitment: LineCommitment | null | undefined): CommitChoice {
  if (!commitment) return "one_time";
  return commitment === "monthly" ? "monthly" : "annual";
}

/** What a picked option saves on the line — null = one-time (no commitment). */
export function commitmentForChoice(choice: string): LineCommitment | null {
  if (choice === "monthly") return "monthly";
  if (choice === "annual") return "annual_yearly";
  return null;
}
