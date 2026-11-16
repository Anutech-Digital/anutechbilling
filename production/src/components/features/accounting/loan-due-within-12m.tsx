/**
 * R-2674: "Due back within 12 months?" — the one control for where a loan shows on the Balance
 * Sheet (current vs non-current asset). Used on Loans given (a loan with no due date) and on
 * Loans & Salary Advances (a staff loan). Saving calls set_loan_due_within_12m (owner /
 * accountant; nothing about the loan's money changes).
 */
"use client";

import * as React from "react";
import { DUE_WITHIN_LABEL } from "@/lib/accounting/loans-current-split";
import { useSetLoanDueWithin12m, type LoanChoiceKind } from "@/lib/queries/loans-current-split";

const cls = "rounded-md border border-hairline bg-paper px-2 py-1.5 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber min-h-[44px] md:min-h-[32px] max-w-full disabled:opacity-60";

export function LoanDueWithin12m({ kind, loanId, name, value, canEdit }: {
  kind: LoanChoiceKind;
  loanId: string;
  /** Borrower / employee — for the control's accessible name. */
  name: string;
  /** true = current, false = non-current, null = not answered yet (loans given only). */
  value: boolean | null;
  canEdit: boolean;
}) {
  const save = useSetLoanDueWithin12m();
  const id = React.useId();
  const shown = value === null ? "" : value ? "yes" : "no";
  if (!canEdit) {
    return (
      <div className="text-xs text-ink-3" data-testid={`due-within-12m-${loanId}`}>
        Balance Sheet: {value === null ? "non-current until the owner or accountant answers" : value ? "current (due within 12 months)" : "non-current (due after 12 months)"}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5" data-testid={`due-within-12m-${loanId}`}>
      <label htmlFor={id} className="text-xs text-ink-3">{DUE_WITHIN_LABEL}</label>
      <select
        id={id}
        className={cls}
        aria-label={`${DUE_WITHIN_LABEL} ${name}`}
        value={shown}
        disabled={save.isPending}
        onChange={(e) => {
          const v = e.target.value;
          if (v !== "yes" && v !== "no") return;
          save.mutate({ kind, loanId, dueWithin: v === "yes" });
        }}
      >
        {value === null && <option value="" disabled>Choose…</option>}
        <option value="yes">Yes — current asset</option>
        <option value="no">No — non-current asset</option>
      </select>
    </div>
  );
}
