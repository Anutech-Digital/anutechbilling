/**
 * R-2699 — "Salary revisions" in the employee profile drawer: the history (from which month,
 * old → new gross, CTC, who, when), the "Revise salary" button and Undo on the latest revision
 * (undo_salary_revision refuses it once a salary was booked on it).
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee, formatDate } from "@/lib/utils";
import { periodLabel } from "@/lib/payroll/period-label";
import { revisionMonth } from "@/lib/payroll/salary-revision";
import { useSalaryRevisions, useUndoSalaryRevision, type Employee } from "@/lib/queries/payroll";
import { useTeamMembers, memberLabel } from "@/lib/queries/team";
import { useConfirm } from "@/components/providers/confirm-provider";
import { istMonth } from "@/lib/dates/ist";
import { ReviseSalaryDialog } from "./revise-salary-dialog";

export function SalaryRevisions({ employee, canWrite }: { employee: Employee; canWrite: boolean }) {
  const revisionsQ = useSalaryRevisions();
  const undo = useUndoSalaryRevision();
  const confirm = useConfirm();
  const team = useTeamMembers();
  const [open, setOpen] = React.useState(false);

  const rows = React.useMemo(
    () => (revisionsQ.data ?? []).filter((r) => r.employee_id === employee.id).reverse(),
    [revisionsQ.data, employee.id],
  );
  const byId = React.useMemo(() => new Map((team.data ?? []).map((m) => [m.id, m])), [team.data]);
  const upcoming = rows.find((r) => revisionMonth(r) > istMonth());

  const onUndo = async (id: string, from: string) => {
    if (await confirm({
      title: `Undo the salary revision from ${periodLabel(from)}?`,
      body: "The employee goes back to the salary before it. Not possible once a salary was booked on this revision.",
      confirmLabel: "Undo revision",
      danger: true,
    })) {
      undo.mutate(id);
    }
  };

  return (
    <div data-testid="salary-revisions">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-ink-2">Salary revisions</p>
        {canWrite && <Button size="sm" variant="outline" icon="rupee" onClick={() => setOpen(true)}>Revise salary</Button>}
      </div>
      {upcoming && (
        <p className="mb-2 text-xs text-amber-ink">
          {rupee(upcoming.monthly_gross)}/month starts from {periodLabel(revisionMonth(upcoming))}; months before that are paid at {rupee(upcoming.prev_monthly_gross)}.
        </p>
      )}
      {revisionsQ.isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-hairline px-3 py-3 text-xs text-ink-3">
          No revisions yet. Use Revise salary for an increment — pick the month it starts from.
        </p>
      ) : (
        <ul className="divide-y divide-hairline rounded-md border border-hairline">
          {rows.map((r, i) => (
            <li key={r.id} className="flex items-start justify-between gap-2 px-3 py-2 text-xs">
              <div className="min-w-0">
                <div className="text-sm text-ink">
                  From <b>{periodLabel(revisionMonth(r))}</b>: {rupee(r.prev_monthly_gross)} → <b>{rupee(r.monthly_gross)}</b>/month
                </div>
                <div className="text-ink-3">
                  {r.annual_ctc ? `CTC ${rupee(r.annual_ctc)}/yr · ` : ""}
                  {r.created_by ? `${memberLabel(byId.get(r.created_by))}, ` : ""}{formatDate(r.created_at)}
                  {r.note ? ` · ${r.note}` : ""}
                </div>
              </div>
              {canWrite && i === 0 && (
                <Button size="sm" variant="ghost" loading={undo.isPending} onClick={() => onUndo(r.id, revisionMonth(r))}>Undo</Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && <ReviseSalaryDialog employee={employee} onClose={() => setOpen(false)} />}
    </div>
  );
}
