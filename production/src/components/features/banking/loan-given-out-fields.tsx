"use client";

/**
 * R-2603 — Banking → Reconcile a money-OUT line → Loan / EMI → "Loan / advance with a person?" →
 * "I am GIVING a loan/advance". The line becomes ONE row on Accounting → Loans given
 * (record_loan_given_from_bank_out), not a Balance Sheet "Advance/loan given" line. This part of the
 * box offers the borrower names already on Loans given (one per person) and owns the footer's Save
 * while the "I am GIVING" choice is picked. The name input itself stays in the parent's box.
 */
import * as React from "react";
import { rupee } from "@/lib/utils";
import { useLoanGivenFromBankLine, useLoanBorrowerNames } from "@/lib/queries/loans-given";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canUseLoansGiven } from "@/lib/accounting/loans-given";
import { useFooterSaveReport, type FooterSave } from "./reconcile-who-tiles";

export const LOAN_GIVEN_BORROWERS_LIST_ID = "r2603-borrowers";

export function LoanGivenOutFields({ txnId, amount, borrower, notes, onDone, onFooterSave }: {
  txnId: string;
  amount: number;
  borrower: string;
  notes: string | null;
  onDone: () => void;
  onFooterSave?: (save: FooterSave | null) => void;
}) {
  const me = useCurrentUser();
  /* Loans given is the owner's / accountant's (RLS + the RPC) — others are told before they click. */
  const allowed = canUseLoansGiven(me.data?.role);
  const loanOut = useLoanGivenFromBankLine();
  const { data: names } = useLoanBorrowerNames(allowed);
  const name = borrower.trim();
  /* one click, one call — a double click before "loading" reaches the footer is ignored */
  const busy = React.useRef(false);

  useFooterSaveReport(onFooterSave, {
    label: `Book ${rupee(amount)} as a loan given (Loans given)`,
    onSave: () => {
      if (!name || !allowed || busy.current) return;
      busy.current = true;
      void loanOut.mutateAsync({ txnId, borrower: name, notes })
        .then(onDone)
        .catch(() => { /* the hook toasts the error */ })
        .finally(() => { busy.current = false; });
    },
    loading: loanOut.isPending,
    disabledReason: me.isLoading ? "Checking your role…"
      : !allowed ? "Only the owner or the accountant can record a loan given — ask your owner."
      : !name ? "Enter the person's name." : null,
  });

  return (
    <>
      <datalist id={LOAN_GIVEN_BORROWERS_LIST_ID}>
        {(names ?? []).map((n) => <option key={n} value={n} />)}
      </datalist>
      <p className="text-xs text-ink-3 mt-1.5 leading-relaxed">
        Goes to <b>Accounting → Loans given</b> — pick a name already there so one person stays one loan list. Interest and due date can be set there.
      </p>
    </>
  );
}
