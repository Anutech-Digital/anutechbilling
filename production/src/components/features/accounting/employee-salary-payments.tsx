/**
 * R-2701 — "Salary & payments" in the employee profile drawer: every booked salary month (gross,
 * deductions, net, paid / not paid, the bank line that paid it) and the employee's loans /
 * salary advances. Read-only: figures come from salary_payments as booked; the status badge
 * (incl. "Paid — link bank line") and the bank-line link are the Salary Register's own pieces
 * (SalaryStatusCell, salaryBankLink, useUnlinkedSalaryBankLines — R-1831, R-1895), so both screens
 * read the same. The full month-by-month breakdown stays on the Salary Register — this links there.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee, formatDate } from "@/lib/utils";
import { useEmployeeSalaryHistory, useSalaryBankLines, useUnlinkedSalaryBankLines } from "@/lib/queries/payroll";
import { useEmployeeLoans, LOAN_KIND_LABEL } from "@/lib/queries/employee-loans";
import { salaryBankLink } from "@/lib/payroll/salary-bank-link";
import { salaryBankLineKey } from "@/lib/payroll/salary-status";
import { SalaryStatusCell, SalaryBankLinkAction } from "@/app/(app)/accounting/payroll/salary-status-cell";
import { salaryMonthRows, employeeLoansFor, waitingSalaryNets } from "@/lib/accounting/employee-salary-months";

export interface EmployeeSalaryPaymentsProps {
  employee: { id: string; name: string };
  canWrite: boolean;
}

export function EmployeeSalaryPayments({ employee, canWrite }: EmployeeSalaryPaymentsProps) {
  const hist = useEmployeeSalaryHistory(employee.id);
  const salaries = React.useMemo(() => hist.data ?? [], [hist.data]);
  const firstPeriod = salaries.reduce<string | null>((min, s) => (min === null || s.period < min ? s.period : min), null);
  const { data: waitingLines } = useUnlinkedSalaryBankLines(waitingSalaryNets(salaries), firstPeriod ? `${firstPeriod}-01` : null);
  const { data: bankLines } = useSalaryBankLines(salaries);
  const loansQ = useEmployeeLoans();
  const rows = React.useMemo(() => salaryMonthRows(salaries), [salaries]);
  const byId = React.useMemo(() => new Map(salaries.map((s) => [s.id, s])), [salaries]);
  const loans = React.useMemo(() => employeeLoansFor(loansQ.data ?? [], employee.name), [loansQ.data, employee.name]);

  return (
    <section aria-labelledby="employee-salary-payments-title" data-testid="employee-salary-payments">
      <div className="flex items-center justify-between mb-2">
        <p id="employee-salary-payments-title" className="text-xs font-semibold text-ink-2">Salary &amp; payments</p>
        {rows.length > 0 && (
          <Link
            href={`/accounting/salary-register?employee=${employee.id}` as never}
            className="text-xs font-medium text-primary hover:underline"
          >
            Full salary register
          </Link>
        )}
      </div>

      {hist.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : hist.isError ? (
        <p className="text-sm text-rose">
          Could not load salary records.{" "}
          <Button size="sm" variant="link" onClick={() => void hist.refetch()}>Try again</Button>
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-hairline bg-paper-2/20 px-3 py-3 text-sm text-ink-3">
          No salary booked yet.
        </p>
      ) : (
        <ul className="divide-y divide-hairline rounded-md border border-hairline bg-paper">
          {rows.map((r) => {
            const s = byId.get(r.id);
            if (!s) return null;
            const link = salaryBankLink(s, bankLines?.get(s.id), waitingLines?.get(salaryBankLineKey(s.net)));
            return (
              <li key={r.id} className="px-3 py-2" data-testid="salary-month-row">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{r.month}</span>
                  <span className="inline-flex items-center gap-2">
                    <span className="font-mono tabular-nums text-sm font-semibold text-ink" title="Net pay (in hand)">{rupee(r.net)}</span>
                    <SalaryStatusCell p={s} waitingLines={waitingLines} canWrite={canWrite} size="sm" />
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-ink-3">
                  {/* No pay date here: it is the booking date, not proof of payment — the badge says paid or not. */}
                  <span className="font-mono tabular-nums">Gross {rupee(r.gross)} − deductions {rupee(r.deductions)}</span>
                  <SalaryBankLinkAction link={link} canWrite={canWrite} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs font-semibold text-ink-2 mt-4 mb-2">Loans &amp; salary advances</p>
      {loansQ.isLoading ? (
        <Skeleton className="h-10 w-full" />
      ) : loansQ.isError ? (
        <p className="text-sm text-rose">
          Could not load loans and advances.{" "}
          <Button size="sm" variant="link" onClick={() => void loansQ.refetch()}>Try again</Button>
        </p>
      ) : loans.length === 0 ? (
        <p className="text-sm text-ink-3">None.</p>
      ) : (
        <ul className="divide-y divide-hairline rounded-md border border-hairline bg-paper" data-testid="employee-loans">
          {loans.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="text-ink">{LOAN_KIND_LABEL[l.kind] ?? "Loan"}</span>
                <span className="text-xs text-ink-3"> · {formatDate(l.disbursed_on)} · given {rupee(l.principal)}</span>
              </span>
              {l.outstanding > 0 ? (
                <Badge kind="warning" size="sm" title="Still to be repaid or recovered from salary">{rupee(l.outstanding)} due</Badge>
              ) : (
                <Badge kind="muted" size="sm">Repaid</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
      {loans.length > 0 && (
        <Link href={"/accounting/loans" as never} className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
          Open loans &amp; advances
        </Link>
      )}
    </section>
  );
}
