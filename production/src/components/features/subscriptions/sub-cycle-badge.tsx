"use client";
/**
 * R-1774 — the term badge on a /subscriptions row (desktop table AND phone card), so the two
 * can never drift. The words come from subscriptionCycle().label — the same words as the
 * cycle chips ("Annual · billed yearly", "Monthly (Flexible)", "3 years · billed yearly").
 *
 * A row whose TERM is 3 or 6 months ("Check term") is something Google and Microsoft do not
 * sell, so it is shown as a yellow warning with "Correct details" one click away — the same
 * dialog the drawer opens. Nothing is changed until the operator saves that dialog.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { cycleInvoiceTitle, type SubCycle } from "@/lib/subscriptions/billing-cycle";

export interface SubCycleBadgeProps {
  cyc: SubCycle;
  /** One invoice's amount, already formatted ("₹7,646" / "about ₹2,004"); null when unknown. */
  amount: string | null;
  /** Opens Correct details for this row. Shown only on a Check term row. */
  onCorrect?: () => void;
  className?: string;
}

export function SubCycleBadge({ cyc, amount, onCorrect, className }: SubCycleBadgeProps) {
  if (!cyc.label) return null;
  const title = amount ? cycleInvoiceTitle(cyc, amount) : undefined;

  if (cyc.kind === "check_term") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 flex-wrap", className)}>
        <Badge kind="warning" size="sm" dot title={title}>{cyc.label}</Badge>
        {onCorrect && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCorrect(); }}
            onKeyDown={(e) => e.stopPropagation()}
            className={cn(
              "text-2xs font-medium text-amber-ink underline underline-offset-2 hover:no-underline cursor-pointer rounded-sm",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
            )}
          >
            Correct details
          </button>
        )}
      </span>
    );
  }

  const showAmount = !!amount && !!cyc.term && cyc.term.months > 1;
  return (
    <Badge kind="muted" size="sm" className={className} title={title}>
      {cyc.label}{showAmount ? ` · ${amount}` : ""}
    </Badge>
  );
}

export default SubCycleBadge;
