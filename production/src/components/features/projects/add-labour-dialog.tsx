/**
 * AddLabourDialog — attach an employee to a project as a labour cost.
 *
 * Cost = employee monthly_gross × percent% × months. This is a MANAGEMENT overlay
 * (project_labour table) — it never writes to `expenses`, so payroll salaries are
 * never double-counted in the company P&L.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useEmployees } from "@/lib/queries/payroll";
import { useSaveProjectLabour, type ProjectLabourLine } from "@/lib/queries/projects";
import { rupee, formatDate, daysBetween } from "@/lib/utils";

export function AddLabourDialog({
  open, onClose, projectId, existing, projectStart, projectTarget,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Present = edit an existing allocation. */
  existing?: ProjectLabourLine | null;
  /** Project period — used to default this person's from/to dates. */
  projectStart?: string | null;
  projectTarget?: string | null;
}) {
  const { data: employees = [] } = useEmployees();
  const save = useSaveProjectLabour();

  const [employeeId, setEmployeeId] = React.useState("");
  const [percent, setPercent] = React.useState("100");
  const [fromDate, setFromDate] = React.useState("");
  const [toDate, setToDate] = React.useState("");
  const [note, setNote] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setEmployeeId(existing?.employee_id ?? "");
    setPercent(existing ? String(existing.percent) : "100");
    // Period defaults to the employee's saved dates, else the project's dates.
    setFromDate(existing?.start_date ?? projectStart ?? "");
    setToDate(existing?.end_date ?? projectTarget ?? "");
    setNote(existing?.note ?? "");
  }, [open, existing, projectStart, projectTarget]);

  const emp = employees.find((e) => e.id === employeeId);
  const pctN = Number(percent) || 0;
  // Months derived from the period (kab se kab tak). Fall back to the saved
  // months when dates aren't set. Rounded to the nearest half-month.
  const monthsFromDates = fromDate && toDate ? Math.max(0.5, Math.round((daysBetween(fromDate, toDate) / 30.44) * 2) / 2) : 0;
  const monN = monthsFromDates > 0 ? monthsFromDates : (existing?.months ?? 1);
  const cost = emp ? Math.round((emp.monthly_gross ?? 0) * (pctN / 100) * monN) : 0;
  // Keep the allocation logical: it must sit inside the project's own timeline —
  // an employee can't be bound before the project starts or after its target.
  const beforeStart = !!(projectStart && fromDate && fromDate < projectStart);
  const afterTarget = !!(projectTarget && toDate && toDate > projectTarget);
  const badRange = !!(fromDate && toDate && fromDate > toDate);
  const valid = !!employeeId && pctN > 0 && pctN <= 100 && monN > 0 && !badRange && !beforeStart && !afterTarget;

  async function handleSave() {
    if (!valid) return;
    await save.mutateAsync({
      id: existing?.id,
      projectId,
      employeeId,
      percent: pctN,
      months: monN,
      startDate: fromDate || null,
      endDate: toDate || null,
      note: note.trim() || null,
    }).catch(() => {});
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit labour" : "Add labour"}</DialogTitle>
          <DialogDescription>
            Attach an employee&apos;s time to this project. Their salary share counts as a project cost — it does NOT double-count in your overall P&amp;L (payroll books it once).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Employee" htmlFor="lab-emp">
            <Select value={employeeId} onValueChange={setEmployeeId} disabled={!!existing}>
              <SelectTrigger id="lab-emp"><SelectValue placeholder="Pick an employee" /></SelectTrigger>
              <SelectContent>
                {employees.filter((e) => e.is_active || e.id === employeeId).map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}{e.designation ? ` · ${e.designation}` : ""} — {rupee(e.monthly_gross ?? 0)}/mo
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <FormField label="Time on project (%)"><Input type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} /></FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="From"><Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></FormField>
            <FormField label="To"><Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></FormField>
          </div>
          {badRange && <p className="text-[11px] text-rose">To date must be after From date.</p>}
          {beforeStart && <p className="text-[11px] text-rose">Can&apos;t start before the project ({formatDate(projectStart!)}). Set the project&apos;s start earlier if needed.</p>}
          {afterTarget && <p className="text-[11px] text-rose">Ends after the project target ({formatDate(projectTarget!)}). Extend the project&apos;s target date first.</p>}

          <FormField label="Note (optional)"><Input placeholder="e.g. backend development" value={note} onChange={(e) => setNote(e.target.value)} /></FormField>

          {emp && (
            <div className="rounded-lg border border-hairline bg-paper-2/50 px-3 py-2.5 text-sm">
              <span className="text-ink-3">Labour cost: </span>
              <span className="font-semibold text-ink">{rupee(cost)}</span>
              <span className="text-[11px] text-ink-3"> = {rupee(emp.monthly_gross ?? 0)}/mo × {pctN}% × {monN} month{monN === 1 ? "" : "s"}</span>
              {fromDate && toDate && <span className="block text-[11px] text-ink-3">{formatDate(fromDate)} → {formatDate(toDate)}</span>}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={!valid} loading={save.isPending}>
            {existing ? "Save" : "Add labour"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
