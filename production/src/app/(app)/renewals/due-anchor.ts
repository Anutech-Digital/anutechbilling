/**
 * R-2817 (Renewals 12-question audit 14 Nov, Q2 "one day count"): the Due column shows the row's ONE
 * anchor (lib/renewals/stage.ts rowAnchor) — the same date and day count as the chip. Greentin Check
 * reads "1 Oct 26 · 44d ago" (its part due 1 Oct), no longer its renewal date "31 Oct 26 · 14d ago"
 * next to a chip saying "Overdue 44d". The tooltip names both dates. Before the stage is read (the
 * documents still loading) it is the renewal date with its own IST day count — never a guessed part date.
 * Pure — tested in lib/renewals/stage-anchor-r2817.test.ts.
 */
import { formatDate } from "@/lib/utils";
import type { RenewalStage } from "@/lib/renewals/stage";

export interface DueFacts {
  /** The date the Due column shows (YYYY-MM-DD); null = no date. */
  date: string | null;
  /** IST days to it — the chip's own count; null = no date. */
  days: number | null;
  /** The tooltip: "Part due 1 Oct 2026 · renews 31 Oct 2026" / "Renews 12 Nov 2026 · part due 14 Nov 2026". */
  title: string | null;
}

export function dueCellFacts(
  stage: Pick<RenewalStage, "anchorDate" | "anchorKind" | "days" | "partDueDate"> | null,
  sub: { renewal_date: string | null },
  daysUntil: number,
): DueFacts {
  const renews = sub.renewal_date ? formatDate(sub.renewal_date) : null;
  if (!stage || !stage.anchorDate) {
    return sub.renewal_date ? { date: sub.renewal_date.slice(0, 10), days: daysUntil, title: `Renews ${renews}` } : { date: null, days: null, title: null };
  }
  const title = stage.anchorKind === "part"
    ? [`Part due ${formatDate(stage.anchorDate)}`, renews ? `renews ${renews}` : null].filter(Boolean).join(" · ")
    : [`Renews ${formatDate(stage.anchorDate)}`, stage.partDueDate ? `part due ${formatDate(stage.partDueDate)}` : null].filter(Boolean).join(" · ");
  return { date: stage.anchorDate, days: stage.days, title };
}
