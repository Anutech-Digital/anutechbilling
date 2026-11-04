/**
 * R-2407 — Banking → Reconcile → Employee, money-out: a salary payout that ALSO pays back money
 * owed to the same employee (e.g. money they paid the company by mistake, booked "owed back").
 * The line is split in one atomic RPC (reconcile_salary_with_owed_back): the salary part pays the
 * salary (no extra salary expense — it was booked for its month) and the rest settles the payable.
 * Shown only when this line = a payable salary's part + a payable owed to that employee.
 */
"use client";

import * as React from "react";

import { rupee } from "@/lib/utils";
import { owedBackMatches, type OwedBackSalary } from "@/lib/accounting/owed-back";
import { usePendingReimbursements, useReconcileSalaryWithOwedBack } from "@/lib/queries/employee-advance-bank";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useFooterSaveReport, type FooterSave } from "./reconcile-who-tiles";

export function SalaryOwedBackSection({ transaction, salaries, onDone, onFooterSave }: {
  transaction: BankTransactionRow;
  salaries: readonly OwedBackSalary[];
  onDone: () => void;
  /** The sticky footer draws the Save (R-2348). */
  onFooterSave?: (save: FooterSave | null) => void;
}) {
  const amount = transaction.debit ?? 0;
  const isDebit = amount > 0 && !(transaction.credit > 0);
  const pending = usePendingReimbursements(isDebit);
  const pay = useReconcileSalaryWithOwedBack();

  const matches = React.useMemo(
    () => (isDebit ? owedBackMatches(amount, salaries, pending.data ?? []) : []),
    [isDebit, amount, salaries, pending.data],
  );
  const key = (m: { salary: { id: string }; owed: { id: string } }) => `${m.salary.id}|${m.owed.id}`;
  const [pick, setPick] = React.useState("");
  React.useEffect(() => { setPick(""); }, [transaction.id]);
  /* One fit → pre-picked. Several → the owner picks; a pick that stops fitting (data refetched)
     is NOT swapped for another pair silently — the Save goes away until they pick again. */
  const picked = pick ? matches.find((m) => key(m) === pick) ?? null : matches.length === 1 ? matches[0] : null;

  const save: FooterSave | null = picked ? {
    label: `Pay salary + ${rupee(picked.owed.amount)} owed back · ${picked.salary.employee_name}`,
    onSave: () => { void submit(); },
    loading: pay.isPending,
  } : null;
  useFooterSaveReport(onFooterSave, save);

  if (matches.length === 0) return null;

  async function submit() {
    if (!picked) return;
    try {
      await pay.mutateAsync({ transactionId: transaction.id, salaryId: picked.salary.id, reimbursementId: picked.owed.id });
      onDone();
    } catch { /* the hook shows the error */ }
  }

  return (
    <div className="rounded-md border border-emerald/40 bg-emerald/5 p-3" data-testid="salary-owed-back">
      <p className="text-xs font-semibold text-ink-2 mb-1">
        {picked ? <>Also pays back {rupee(picked.owed.amount)} owed to {picked.salary.employee_name}</>
          : <>Also pays back money owed to the employee?</>}
      </p>
      <p className="text-xs text-ink-3 mb-2 leading-relaxed">
        This line is the salary plus money owed back to the employee (e.g. paid to us by mistake). It is split: the salary is paid and what is owed is settled — no extra salary expense.
      </p>
      {matches.length > 1 && (
        <select aria-label="Salary and amount owed back" value={picked ? key(picked) : ""} onChange={(e) => setPick(e.target.value)}
          className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-emerald/40 mb-2">
          <option value="" disabled>Pick the salary…</option>
          {matches.map((m) => (
            <option key={key(m)} value={key(m)}>
              {m.salary.employee_name} · {m.salary.period} · {rupee(m.salaryPart)} salary + {rupee(m.owed.amount)} owed back
            </option>
          ))}
        </select>
      )}
      {picked && (
        <p className="text-xs text-ink-2">
          <span className="text-emerald font-medium">{rupee(picked.salaryPart)}</span> → salary {picked.salary.period} (paid in full)
          {" · "}
          <span className="text-emerald font-medium">{rupee(picked.owed.amount)}</span> → owed back (settled)
        </p>
      )}
    </div>
  );
}
