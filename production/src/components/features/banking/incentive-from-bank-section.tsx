/**
 * R-1839 — Banking → Reconcile, money-out line: "Employee incentive / bonus".
 *
 * An incentive is salary for the employee (Salaries expense, TDS u/s 192, payslip, Form 16) —
 * so it is booked through payroll: added to that month's salary record when there is one, else
 * a one-off payroll record. Never drawings, never a plain expense. The employee is suggested
 * from the bank text. Commission to someone outside the company (194H) is not this — the
 * screen says where that goes.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import { useEmployees } from "@/lib/queries/payroll";
import { previousPeriod } from "@/lib/banking/salary-lines";
import { suggestEmployee, useSalaryRecordFor, useBookBankTxnAsIncentive } from "@/lib/queries/incentive-from-bank";
import type { BankTransactionRow } from "@/lib/queries/bank";

export function IncentiveFromBankSection({ transaction, onDone }: { transaction: BankTransactionRow; onDone: () => void }) {
  const { data: employees } = useEmployees();
  const book = useBookBankTxnAsIncentive();
  const [open, setOpen] = React.useState(false);
  const [employeeId, setEmployeeId] = React.useState("");
  const [period, setPeriod] = React.useState("");
  const [tds, setTds] = React.useState("");

  const suggested = React.useMemo(() => suggestEmployee(transaction.description, employees ?? []), [transaction.description, employees]);
  React.useEffect(() => {
    setOpen(false);
    setEmployeeId("");
    setPeriod(previousPeriod(transaction.txn_date));
    setTds("");
  }, [transaction.id, transaction.txn_date]);
  React.useEffect(() => { if (open && !employeeId && suggested) setEmployeeId(suggested); }, [open, employeeId, suggested]);

  const existing = useSalaryRecordFor(employeeId, period);
  const paid = transaction.debit;
  const tdsNum = tds.trim() === "" ? 0 : Number(tds.replace(/[,\s₹]/g, ""));
  const tdsBad = !Number.isInteger(tdsNum) || tdsNum < 0;
  const incentive = paid + (tdsBad ? 0 : tdsNum);
  const empName = (employees ?? []).find((e) => e.id === employeeId)?.name ?? "";

  async function submit() {
    if (!employeeId || !period || tdsBad) return;
    try {
      await book.mutateAsync({ transactionId: transaction.id, employeeId, period, tds: tdsNum });
      onDone();
    } catch { /* the hook shows the error */ }
  }

  if (!((transaction.debit ?? 0) > 0)) return null;

  return (
    <div className="rounded-md border border-emerald/40 bg-emerald-soft/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-2">Employee incentive / bonus?</p>
          <p className="text-xs text-ink-3 mt-0.5 leading-relaxed">
            Salary for the employee — booked in Payroll, on the payslip and Form 16 (TDS u/s 192).
          </p>
        </div>
        {!open && <Button size="sm" variant="default" onClick={() => setOpen(true)}>Book incentive</Button>}
      </div>

      {open && (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label="Employee"
              className="rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-emerald/40">
              <option value="" disabled>Pick employee…</option>
              {(employees ?? []).filter((e) => e.is_active).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Incentive for month" />
          </div>
          <div>
            <Input aria-label="TDS deducted" inputMode="numeric" placeholder="TDS deducted (₹, 0 if none)" value={tds} onChange={(e) => setTds(e.target.value)} />
            <p className="text-xs text-amber-ink mt-1">TDS: check — enter the TDS you deducted on this incentive (u/s 192, on the year&apos;s salary). The app does not work it out here.</p>
            {tdsBad && <p role="alert" className="text-xs text-rose mt-1">Whole rupees only, e.g. 500.</p>}
          </div>
          {employeeId && period && (
            <p className="text-xs text-ink-2 bg-paper rounded px-2 py-1.5 border border-hairline">
              Incentive {rupee(incentive)} = {rupee(paid)} paid{tdsNum > 0 && !tdsBad ? ` + ${rupee(tdsNum)} TDS` : ""}.{" "}
              {existing.isLoading ? "Checking payroll…"
                : existing.isError ? "Could not check payroll for that month — try again."
                : existing.data
                  ? <>Added to {empName}&apos;s {period} salary (gross {rupee(existing.data.gross)}) — its Bonus, TDS and net go up.</>
                  : <>No {period} salary for {empName} yet — a one-off payroll record is made for this incentive.</>}
            </p>
          )}
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="primary" icon="check" loading={book.isPending}
              disabled={!employeeId || !period || tdsBad || existing.isLoading || existing.isError} onClick={submit}>
              Book {rupee(paid)} as incentive
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
          <p className="text-xs text-ink-3">
            Commission to someone outside the company (not an employee)? That is not salary — book it as a partner
            commission or a Commission expense with TDS u/s 194H.
          </p>
        </div>
      )}
    </div>
  );
}
