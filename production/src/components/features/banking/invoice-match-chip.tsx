/**
 * R-399 — "Matches INV-…" on a bank transaction row (R-109 slice 3).
 *
 * Shown only for an unmatched credit whose best candidate is "certain"
 * (lib/banking/invoice-credit-match.ts certainInvoiceMatches). It points, it does not
 * record: a click opens the existing reconcile drawer, where the invoice match section
 * shows the reasons and the one-click "Match & record payment".
 */
"use client";

import { Icon } from "@/components/ui/icon";
import type { InvoiceMatch } from "@/lib/banking/invoice-credit-match";

export function InvoiceMatchChip({ match, onOpen }: { match: InvoiceMatch; onOpen: () => void }) {
  const who = match.customerName ? ` (${match.customerName})` : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${match.reasons.join(" · ")} — open to match`}
      aria-label={`Matches invoice ${match.invoiceId}${who}. Open reconcile.`}
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald/30 bg-emerald-soft/40 px-2 py-0.5 text-xs font-medium text-emerald-ink hover:bg-emerald-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald/50"
    >
      <Icon name="check_circle" size={11} className="shrink-0" />
      <span className="truncate">Matches <span className="font-mono">{match.invoiceId}</span></span>
    </button>
  );
}
