/**
 * R-1755 (owner, 22 Oct 2026) — making a SEAT / PLAN line optional for the customer.
 *
 * A customer may buy two Workspace plans together (10 Starter + 5 Standard), and the owner may
 * offer the second one as an optional extra — so a plan line CAN be optional. But an optional
 * plan line lets the buyer drop those seats and pay less, so the builder asks first. Add-on and
 * one-time lines (support, Drive storage, migration, setup) need no question.
 *
 * "Is this line a subscription" is NOT a new rule: it mirrors quote_line_is_subscription()
 * (migration 20261019164713, R-1688) as the builder saves a line — the One-time marker → no;
 * a commitment other than 'one_time' → yes; no commitment → One-time (line-commit-choice.ts
 * commitChoiceOf; markOneTimeLines writes the marker on save). The one addition is the
 * catalogue's own Main / Add-on kind: a support or storage add-on also renews, but it is an
 * extra, not the seats the deal is about.
 */
import type { QuoteLineItem } from "@/lib/supabase/database.types";

/** The catalogue kind of a line's item, when the line came from the catalogue. */
export type CatalogKind = "main" | "addon" | null | undefined;

/** Does the builder treat this line as a subscription (renews), as quote_line_is_subscription does? */
export function lineIsSubscription(line: Pick<QuoteLineItem, "commitment" | "one_time">): boolean {
  if (line.one_time === true) return false;
  const c = (line.commitment ?? "").trim().toLowerCase();
  return c !== "" && c !== "one_time";
}

/**
 * Should "Make optional for customer" ask first? Yes for a subscription line that is not a
 * catalogue add-on — a plan's seats, or a custom recurring line we cannot tell apart from one.
 */
export function optionalNeedsConfirm(
  line: Pick<QuoteLineItem, "commitment" | "one_time">,
  kind: CatalogKind,
): boolean {
  return lineIsSubscription(line) && kind !== "addon";
}

/** The question asked before a plan / seat line becomes optional. */
export const SEAT_LINE_OPTIONAL_CONFIRM = {
  title: "Make this plan optional?",
  body: "The customer can remove these seats. Use this only for an extra plan they may or may not take.",
  confirmLabel: "Make optional",
  cancelLabel: "Cancel",
} as const;
