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

/* R-1963 (26 Oct 2026): a licence typed as a Custom item (empty catalogue, "Add my own item")
   had no commitment, so markOneTimeLines saved it as one_time — accepting "Google Workspace
   Business Starter (1 year)" × 10 made no subscription and no renewal. The Custom item form
   now asks the term (the same three choices as the line's select) and pre-fills it from the
   name; the user still sees and can change it. Name only — the default qty (10) says nothing. */
const ONE_TIME_WORDS = /\b(one[\s-]?time|once|setup|set-up|migration|installation|onboarding fee)\b/i;
const MONTHLY_WORDS = /(\/\s*(mo|month)\b|\bper\s+month\b|\bmonthly\b|\(\s*1\s*month\s*\)|\bmonth[\s-]?to[\s-]?month\b)/i;
const YEARLY_WORDS = new RegExp(
  [
    String.raw`\/\s*(yr|year)\b`,
    String.raw`\bper\s+(year|annum|user|seat|licen[cs]e|mailbox)\b`,
    String.raw`\byearly\b`,
    String.raw`\bannual(ly)?\b`,
    String.raw`\b\d+\s*years?\b`,
    String.raw`\bseats?\b`,
    String.raw`\blicen[cs]es?\b`,
    String.raw`\bsubscription\b`,
    String.raw`\bworkspace\b`,
    String.raw`\bbusiness\s+(starter|standard|plus|basic|premium)\b`,
    String.raw`\b(microsoft|office)\s*365\b`,
    String.raw`\b[mo]365\b`,
    String.raw`\bzoho\s+(mail|workplace|one)\b`,
    String.raw`\benterprise\s+(standard|plus|e3|e5)\b`,
  ].join("|"),
  "i",
);

/** The term a Custom item's name suggests: monthly, annual, or one-time when nothing says so. */
export function suggestCommitChoice(name: string): CommitChoice {
  const n = (name ?? "").trim();
  if (!n || ONE_TIME_WORDS.test(n)) return "one_time";
  if (MONTHLY_WORDS.test(n)) return "monthly";
  if (YEARLY_WORDS.test(n)) return "annual";
  return "one_time";
}

/** A name that reads like a plan billed by term — saving it One-time deserves a warning. */
export function looksLikeSubscription(name: string): boolean {
  return suggestCommitChoice(name) !== "one_time";
}

/** What each choice means for the customer once the quote is accepted — one line, plain. */
export const COMMIT_CHOICE_HINT: Readonly<Record<CommitChoice, string>> = {
  one_time: "Charged once — no subscription or renewal.",
  monthly: "Becomes a monthly subscription when the quote is accepted.",
  annual: "Becomes a yearly subscription with a renewal when the quote is accepted.",
};

/** The unit the typed rate is in for each choice (R-369: monthly ₹/month, annual ₹/year). */
export const COMMIT_CHOICE_RATE_UNIT: Readonly<Record<CommitChoice, string>> = {
  one_time: "per unit, once",
  monthly: "per unit per month",
  annual: "per unit per year",
};
