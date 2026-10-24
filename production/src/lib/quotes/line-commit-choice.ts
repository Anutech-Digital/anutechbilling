/**
 * R-389 (F4) — the quote builder's per-line "Commit" select.
 *
 * It offered only "Monthly flex" and "Annual (1-yr)", and showed a line with NO commitment
 * as Annual — but a line without a commitment is a one-time charge: record_payment and
 * activate_quote_on_credit skip it (`commitment is not null`), so no subscription is made.
 * A custom "Data migration" line on Q-FBB9-27-0013 read "Annual (1-yr)" while saved as
 * one-off. The select now has "One-time" and shows what is saved.
 */
import type { LineCommitment, QuoteLineItem } from "@/lib/supabase/database.types";

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

/**
 * R-1688 (19 Oct 2026): the lines as the builder SAVES them — every line with no commitment (the
 * select's "One-time") carries `one_time: true`, every line with a term carries no marker.
 *
 * A missing commitment alone is ambiguous in the database: older annual lines can lack one, so
 * "Invoice now" and "pay later" filed a missing commitment as Annual (Q-F588-27-0024 filed its
 * "T-M5 Email migration (one-time)" line as a ₹417-MRR subscription). The marker is what
 * quote_line_is_subscription() reads to never file it. Prices are untouched (R-1668: × qty).
 * Returns new objects; the caller's array is not changed.
 */
export function markOneTimeLines(lines: readonly QuoteLineItem[]): QuoteLineItem[] {
  return lines.map((l) => {
    const { one_time: _marker, ...rest } = l;
    return rest.commitment ? rest : { ...rest, one_time: true };
  });
}
