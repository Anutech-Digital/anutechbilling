/**
 * R-2622: the P&L's one control for the view of cost of goods — "Management (matched)" (bills in
 * the month the licence was used) / "As invoiced (GST)" (bills on their date). Same pill style as
 * the Compare control above it. When Management was asked for but the database cannot give it,
 * the page shows the GST numbers and this says so.
 */
"use client";

import { PNL_BASIS_OPTIONS, type PnlBasis } from "@/lib/accounting/pnl-basis";

export function BasisToggle({ basis, onPick, unavailable }: { basis: PnlBasis; onPick: (b: PnlBasis) => void; unavailable: boolean }) {
  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-hairline pt-3" role="group" aria-label="View">
        <span className="text-xs text-ink-3 font-semibold uppercase tracking-wide mr-1">View</span>
        {PNL_BASIS_OPTIONS.map((o) => (
          <button
            key={o.basis}
            type="button"
            aria-pressed={basis === o.basis}
            onClick={() => onPick(o.basis)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              basis === o.basis
                ? "border-amber bg-amber-soft text-amber-ink font-semibold"
                : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
            }`}
          >
            {o.label}
          </button>
        ))}
        <span className="text-xs text-ink-3 ml-1" data-testid="pnl-basis-help">
          {PNL_BASIS_OPTIONS.find((o) => o.basis === basis)?.help}
        </span>
      </div>
      {unavailable && (
        <p role="status" className="mt-2 text-xs text-rose" data-testid="pnl-basis-unavailable">
          The Management view is not available on this database yet — showing As invoiced (GST).
        </p>
      )}
    </>
  );
}
