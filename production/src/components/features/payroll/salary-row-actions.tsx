/**
 * R-2771 — ONE "⋯" menu for a booked salary month, used by Payroll (month → row) and by both
 * Salary Register views (month view and ?employee= FY view). Hitesh (14 Nov, staging): "I want to
 * edit the salary of a specific month directly from here" — the register was read-only and the
 * only way was Payroll → that month → find the person → ⋯.
 *
 *  • Edit salary — opens the Pay salary form prefilled with THIS month's booked figures; nothing
 *    changes until Save, which reverses the old run and books the new one through the same RPCs
 *    as Payroll (delete_salary_payment, then pay_salary / pay_salary_with_arrears).
 *  • Edit salary — set LOP (R-2428, part-paid) and Undo salary — unchanged.
 *  • A month a bank line pays says why it is locked and links to that bank line.
 *
 * The menu, its dialogs and the confirm live inside one wrapper that stops clicks / keys from
 * reaching the register row (a row click opens the employee / the bank line).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { useConfirm } from "@/components/providers/confirm-provider";
import { AdjustSalaryLopDialog } from "@/components/features/payroll/adjust-salary-lop-dialog";
import { PaySalaryDialog } from "@/app/(app)/accounting/payroll/screens";
import { toTitleCase } from "@/lib/utils";
import { toastError } from "@/lib/errors/toast-error";
import { periodLabel } from "@/lib/payroll/period-label";
import { salaryRowActionState } from "@/lib/payroll/salary-edit";
import { revisionsByEmployee } from "@/lib/payroll/salary-revision";
import {
  useDeleteSalaryPayment, useSalaryRevisions, type Employee, type SalaryPayment,
} from "@/lib/queries/payroll";

export function SalaryRowActions({ employee, p, canWrite, bankLineHref, leading, onReconcile, ariaLabel }: {
  employee: Employee;
  /** The booked month; undefined = not run yet (only the `leading` items show). */
  p?: SalaryPayment;
  canWrite: boolean;
  /** The bank-statement line that pays this salary (lib/payroll/salary-bank-link) — shown with the lock. */
  bankLineHref?: string | null;
  /** Items above the salary actions (Payroll: Full-year payroll, Download payslip). */
  leading?: React.ReactNode;
  /** Payroll: booked but not bank-matched → jump to Banking with the matching line. */
  onReconcile?: () => void;
  /** Payroll keeps its old "More actions for <name>" label (the menu also holds payslip / full year). */
  ariaLabel?: string;
}) {
  /* The salary as it was when Edit was pressed — the form keeps it even if the row re-reads. */
  const [editing, setEditing] = React.useState<SalaryPayment | null>(null);
  const [lopOpen, setLopOpen] = React.useState(false);
  const undo = useDeleteSalaryPayment();
  const confirm = useConfirm();
  const state = p ? salaryRowActionState(p, canWrite, { exitDate: employee.exit_date }) : null;
  const revQ = useSalaryRevisions(Boolean(editing) && canWrite);
  const revisions = React.useMemo(() => revisionsByEmployee(revQ.data ?? []).get(employee.id) ?? [], [revQ.data, employee.id]);
  const name = toTitleCase(employee.name);
  const month = p ? periodLabel(p.period) : "";
  /* The form needs the salary revisions (the salary in force that month). Edit must never do
     nothing: while they load say so; if the read fails show the error and let Edit be pressed again. */
  const revFailed = Boolean(editing) && Boolean(revQ.isError);
  const revError = revQ.error;
  React.useEffect(() => {
    if (!revFailed) return;
    toastError(revError, { fallback: "Could not open Edit salary — the salary revisions did not load. Try again." });
    setEditing(null);
  }, [revFailed, revError]);

  const undoSalary = async () => {
    if (!p) return;
    if (await confirm({
      title: `Undo ${name}'s salary for ${month}?`,
      body: "This removes the salary + its booked expense so you can pay it again. (Blocked once it's reconciled to a bank line — un-reconcile that first.)",
      confirmLabel: "Undo",
      danger: true,
    })) undo.mutate(p.id);
  };

  const hasSalaryItems = Boolean(state && (state.edit || state.undo || state.adjustLop || state.lockReason || state.editNote));

  return (
    // Stops the register row's own click / Enter (open employee / bank line) — dialogs portal
    // out of the DOM but React events still bubble through this element.
    <div className="inline-flex" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={ariaLabel ?? (p ? `Salary actions for ${name}, ${month}` : `More actions for ${name}`)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2">
            <Icon name="more_h" size={18} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[13rem]">
          {leading}
          {p && state && hasSalaryItems && (
            <>
              {leading && <DropdownMenuSeparator />}
              {state.edit && onReconcile && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onReconcile}>
                  <Icon name="refresh" size={15} /> Reconcile in Banking →
                </DropdownMenuItem>
              )}
              {state.edit && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setEditing(p)}>
                  <Icon name="edit" size={15} /> Edit salary
                </DropdownMenuItem>
              )}
              {state.editNote && (
                <DropdownMenuItem disabled className="gap-2.5 py-2 text-ink-3 max-w-[18rem] whitespace-normal">
                  <Icon name="lock" size={15} className="shrink-0" /> {state.editNote}
                </DropdownMenuItem>
              )}
              {state.adjustLop && (
                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setLopOpen(true)}>
                  <Icon name="edit" size={15} /> Edit salary — set LOP
                </DropdownMenuItem>
              )}
              {state.undo && (
                <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={() => { void undoSalary(); }}>
                  <Icon name="trash" size={15} /> Undo salary
                </DropdownMenuItem>
              )}
              {state.lockReason && (
                <DropdownMenuItem disabled className="gap-2.5 py-2 text-ink-3">
                  <Icon name="lock" size={15} /> {state.lockReason}
                </DropdownMenuItem>
              )}
              {state.lockReason && bankLineHref && (
                <DropdownMenuItem asChild className="gap-2.5 py-2 cursor-pointer">
                  <Link href={bankLineHref as Route}><Icon name="link" size={15} /> Open bank line →</Link>
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {editing && canWrite && !revQ.isSuccess && !revQ.isError && (
        <span role="status" className="ml-1 self-center whitespace-nowrap text-xs text-ink-3">
          Opening {name}&apos;s salary for {periodLabel(editing.period)}…
        </span>
      )}
      {editing && canWrite && revQ.isSuccess && (
        <PaySalaryDialog employee={employee} period={editing.period} revisions={revisions} editing={editing} onClose={() => setEditing(null)} />
      )}
      {lopOpen && p && canWrite && <AdjustSalaryLopDialog name={name} salary={p} onClose={() => setLopOpen(false)} />}
    </div>
  );
}
