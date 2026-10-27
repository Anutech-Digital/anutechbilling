/**
 * R-1913 — the vendor's advance on an expense bill row (Expenses page):
 *   · "Advance ₹30,000 applied · ₹20,000 due" under the amount, with "Undo advance";
 *   · R-1915: "₹25,000 paid · ₹34,000 due" for a bill part-paid from the bank;
 *   · "Apply advance ₹X" when the vendor has money left with them and the bill is still to pay.
 * One transaction each (apply_vendor_advance / undo_vendor_advance); no second expense row.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import type { BillAdvanceView } from "@/lib/accounting/vendor-account";
import { useApplyVendorAdvance, useUndoVendorAdvance } from "@/lib/queries/vendor-advance";

/** Under the amount: what the advance settled, (R-1915) what the bank parts paid, and what is
 *  still due. */
export function AdvanceAppliedLine({ expenseId, view }: { expenseId: string; view: BillAdvanceView }) {
  const undo = useUndoVendorAdvance();
  if (view.applied <= 0 && view.paidPart <= 0) return null;
  const parts = [
    view.applied > 0 ? `Advance ${rupee(view.applied)} applied` : null,
    view.paidPart > 0 ? `${rupee(view.paidPart)} paid` : null,
  ].filter(Boolean).join(" · ");
  return (
    <div className="text-xs text-ink-3 tabular-nums" onClick={(ev) => ev.stopPropagation()}>
      <span>{parts}</span>
      {view.due > 0 && <span className="text-rose"> · {rupee(view.due)} due</span>}
      {view.canUndo && (
        <button type="button" className="ml-1.5 underline hover:no-underline text-ink-2 disabled:opacity-50"
          disabled={undo.isPending} onClick={() => undo.mutate(expenseId)}>
          Undo advance
        </button>
      )}
    </div>
  );
}

/** The action: set the vendor's advance off against this bill. */
export function ApplyAdvanceButton({ expenseId, view, className }: { expenseId: string; view: BillAdvanceView; className?: string }) {
  const apply = useApplyVendorAdvance();
  if (view.canApply <= 0) return null;
  return (
    <Button variant="primary" className={className ?? "h-7 px-2 py-0 text-xs"} loading={apply.isPending}
      title="Set the money already paid to this vendor as an advance off against this bill"
      onClick={(ev) => { ev.stopPropagation(); apply.mutate({ expenseId }); }}>
      Apply advance {rupee(view.canApply)}
    </Button>
  );
}
