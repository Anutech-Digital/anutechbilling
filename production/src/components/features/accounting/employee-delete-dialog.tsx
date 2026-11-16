/**
 * "Delete employee" — the ONE delete dialog (R-2698 + R-2701).
 *
 * R-2698: what ties the employee to the books (booked salary months, project labour, expense
 * claims — fetchEmployeeDeleteBlockers, the same three things tg_employee_delete_guard refuses on)
 * is read BEFORE the delete and named, with the way on: Start exit (owner, R-1896) or Edit employee.
 * R-2701: "See salary months" opens the profile's Salary & payments section; a loan / salary
 * advance still due is named before a delete (loans are kept by name, not deleted with them).
 * Only an employee with nothing booked gets the Delete button; useDeleteEmployee checks again.
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatDate, rupee, toTitleCase } from "@/lib/utils";
import { useDeleteEmployee, useEmployeeDeleteBlockers } from "@/lib/queries/payroll";
import { useEmployeeLoans } from "@/lib/queries/employee-loans";
import { deleteBlockMessage, hasDeleteBlockers } from "@/lib/payroll/statutory";
import { employeeLoansFor, outstandingLoanTotal } from "@/lib/accounting/employee-salary-months";

export interface EmployeeDeleteDialogProps {
  employee: { id: string; name: string; exit_date?: string | null };
  /** Owner only — start_employee_exit refuses anyone else. */
  isOwner: boolean;
  onStartExit: () => void;
  onEdit: () => void;
  onShowSalary: () => void;
  onClose: () => void;
}

export function EmployeeDeleteDialog({ employee, isOwner, onStartExit, onEdit, onShowSalary, onClose }: EmployeeDeleteDialogProps) {
  const del = useDeleteEmployee();
  const blockersQ = useEmployeeDeleteBlockers(employee.id);
  const loansQ = useEmployeeLoans();
  const name = toTitleCase(employee.name.trim());
  const blockers = blockersQ.data;
  const blocked = !!blockers && hasDeleteBlockers(blockers);
  const canExit = isOwner && !employee.exit_date;
  /* Loans are only a note: a failed or slow loans read never holds up the delete. */
  const owed = outstandingLoanTotal(employeeLoansFor(loansQ.data ?? [], employee.name));
  /* isFetching: a cached answer from an earlier open is re-read before Delete is offered. */
  const checking = blockersQ.isLoading || blockersQ.isFetching;
  const failed = blockersQ.isError;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{blocked ? `${name} can't be deleted` : checking || failed ? "Delete employee" : `Delete ${name}?`}</DialogTitle>
          <DialogDescription>
            {blocked ? deleteBlockMessage(name, blockers, canExit)
              : checking ? "Checking what is booked against them…"
              : failed ? "Could not check what is booked against them."
              : "This deletes the employee and their attendance and leave records. Nothing is booked against them (no salary, project labour or expense claim). It cannot be undone."}
          </DialogDescription>
        </DialogHeader>

        {blocked && isOwner && employee.exit_date && (
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
              {blockers.salaryMonths.length > 0 && (
                <Button type="button" variant="outline" onClick={onShowSalary}>See salary months</Button>
              )}
              {canExit ? (
                <Button type="button" variant="primary" icon="logout" onClick={onStartExit}>Start exit</Button>
              ) : (
                <Button type="button" variant="primary" icon="edit" onClick={onEdit}>Edit employee</Button>
              )}
            </>
          ) : failed ? (
            <Button type="button" variant="primary" onClick={() => void blockersQ.refetch()}>Try again</Button>
          ) : !checking ? (
            <Button
              type="button"
              variant="danger"
              loading={del.isPending}
              onClick={() => del.mutate(
                { id: employee.id, name: employee.name, canExit },
                { onSuccess: () => onClose(), onError: () => void blockersQ.refetch() },
              )}
            >
              Delete employee
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
