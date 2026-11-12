/**
 * R-2701 — "Delete employee". Before: a confirm, then "has salary payments on record" with no
 * months named. Now the salary check runs FIRST: when salary is booked the dialog names the months
 * and offers Start exit (R-1896 — marks them as left, history kept) and the profile's
 * "Salary & payments"; only an employee with no salary gets the Delete button. useDeleteEmployee
 * keeps its own check as the last guard (and salary_payments → employees is ON DELETE RESTRICT).
 * A loan / salary advance still due is named before the delete (loans are kept by name, not
 * deleted with the employee).
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatDate, rupee, toTitleCase } from "@/lib/utils";
import { useDeleteEmployee, useEmployeeSalaryHistory } from "@/lib/queries/payroll";
import { useEmployeeLoans } from "@/lib/queries/employee-loans";
import { deleteBlockedMessage, employeeLoansFor, outstandingLoanTotal } from "@/lib/accounting/employee-salary-months";

export interface EmployeeDeleteDialogProps {
  employee: { id: string; name: string; exit_date?: string | null };
  /** Owner only — start_employee_exit refuses anyone else. */
  canStartExit: boolean;
  onStartExit: () => void;
  onShowSalary: () => void;
  onClose: () => void;
}

export function EmployeeDeleteDialog({ employee, canStartExit, onStartExit, onShowSalary, onClose }: EmployeeDeleteDialogProps) {
  const del = useDeleteEmployee();
  const hist = useEmployeeSalaryHistory(employee.id);
  const loansQ = useEmployeeLoans();
  const periods = (hist.data ?? []).map((p) => p.period);
  const name = toTitleCase(employee.name.trim());
  const blocked = periods.length > 0;
  const owed = outstandingLoanTotal(employeeLoansFor(loansQ.data ?? [], employee.name));
  const checking = hist.isLoading || loansQ.isLoading;
  const failed = hist.isError || loansQ.isError;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{blocked ? `${name} can't be deleted` : checking || failed ? "Delete employee" : `Delete ${name}?`}</DialogTitle>
          <DialogDescription>
            {blocked ? deleteBlockedMessage(periods)
              : checking ? "Checking salary records…"
              : failed ? "Could not check salary records and loans."
              : "This deletes the employee and their attendance and leave records. It cannot be undone."}
          </DialogDescription>
        </DialogHeader>

        {blocked && !canStartExit && (
          <p className="text-sm text-ink-2">Only the owner can start an exit. Ask the owner to do it from this employee&apos;s menu.</p>
        )}
        {blocked && canStartExit && employee.exit_date && (
          <p className="text-sm text-ink-2">Their last working day is already set to {formatDate(employee.exit_date)}.</p>
        )}
        {!blocked && !checking && !failed && owed > 0 && (
          <p className="text-sm text-amber-ink">
            They still owe {rupee(owed)} on loans or salary advances. That stays on the Loans page under their name.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
          {blocked ? (
            <>
              <Button type="button" variant="outline" onClick={onShowSalary}>See salary months</Button>
              {canStartExit && !employee.exit_date && (
                <Button type="button" variant="primary" icon="logout" onClick={onStartExit}>Start exit</Button>
              )}
            </>
          ) : failed ? (
            <Button type="button" variant="primary" onClick={() => { void hist.refetch(); void loansQ.refetch(); }}>Try again</Button>
          ) : !checking ? (
            <Button
              type="button"
              variant="danger"
              loading={del.isPending}
              onClick={() => del.mutate(employee.id, { onSuccess: () => onClose() })}
            >
              Delete employee
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
