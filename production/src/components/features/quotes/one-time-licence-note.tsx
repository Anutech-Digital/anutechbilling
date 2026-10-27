/**
 * R-1963 — a line saved with NO term (One-time) whose name reads like a plan billed by term
 * ("Google Workspace Business Starter (1 year)", "… per user", "/month"). Accepting the quote
 * makes no subscription and no renewal for it, so the builder says so next to its Commit
 * select — on drafts saved before the Custom item form asked "Billing" too. Label only: the
 * line, its price and its term are untouched until the user picks a term in the select.
 */
import { looksLikeSubscription } from "@/lib/quotes/line-commit-choice";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

export function OneTimeLicenceNote({ line, className }: { line: Pick<QuoteLineItem, "name" | "commitment">; className?: string }) {
  if (line.commitment || !looksLikeSubscription(line.name ?? "")) return null;
  return (
    <span role="note" className={`text-3xs text-amber-ink ${className ?? ""}`.trim()}>
      Looks like a subscription — One-time makes no subscription or renewal. Pick a term if it renews.
    </span>
  );
}
