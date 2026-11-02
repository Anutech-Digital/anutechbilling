/**
 * R-2380 — "Merge into…": the same person was added twice (owner, 2 Nov 2026: "saare Prashant
 * ek hi hai, sabko merge kar do").
 *
 * Opened from the duplicate's ⋯ menu. The owner picks the employee to KEEP; a dry run of the
 * merge_employees RPC shows what moves (salary records, attendance, leave, documents, advances,
 * login …), which empty fields get filled, and any month where BOTH have a salary. Such a month
 * blocks the merge unless "Keep both — they are different payments" is ticked (that month's
 * salary then stays on the duplicate as its own record). One server transaction does the move;
 * no amount changes.
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/label";
import { rupee } from "@/lib/utils";
import { useMergeEmployees, useMergeEmployeesPreview, type MergeEmployeesResult } from "@/lib/queries/payroll";

const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";

type Emp = { id: string; name: string; designation?: string | null; is_active?: boolean | null };

/** Plain words for each count the RPC returns. */
const WHAT: Record<string, [string, string]> = {
  salary: ["salary record", "salary records"],
  attendance: ["attendance day", "attendance days"],
  leave: ["leave entry", "leave entries"],
  documents: ["document", "documents"],
  property: ["company property item", "company property items"],
  expense_claims: ["expense claim", "expense claims"],
  reimbursements: ["reimbursement", "reimbursements"],
  advances: ["advance / loan", "advances / loans"],
  project_labour: ["project labour line", "project labour lines"],
  tasks: ["task", "tasks"],
  credentials: ["access credential", "access credentials"],
  assessments: ["assessment", "assessments"],
  attendance_fixes: ["attendance fix", "attendance fixes"],
  attendance_devices: ["attendance device", "attendance devices"],
  login: ["login", "logins"],
  director: ["director link", "director links"],
};

const FIELD_LABEL: Record<string, string> = {
  email: "email", phone: "phone", pan: "PAN", pf_no: "PF no.", esi_no: "ESI no.", designation: "designation",
  date_of_birth: "date of birth", address: "address", emergency_contact_name: "emergency contact",
  emergency_contact_phone: "emergency phone", joining_date: "joining date", biometric_id: "biometric ID",
};

function lines(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const w = WHAT[k] ?? [k.replace(/_/g, " "), k.replace(/_/g, " ")];
      return `${n} ${n === 1 ? w[0] : w[1]}`;
    });
}

export function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) return period;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** The other employee most likely to be the same person: one whose name shares the first word. */
export function guessKeep(dup: Emp, others: Emp[]): string | null {
  const first = dup.name.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  const hits = others.filter((o) => o.name.trim().split(/\s+/)[0]?.toLowerCase() === first);
  return hits.length === 1 ? hits[0].id : null;
}

export function MergeEmployeeDialog({
  employee, employees, onClose,
}: {
  employee: Emp;
  employees: Emp[];
  onClose: () => void;
}) {
  const others = React.useMemo(
    () => employees
      .filter((e) => e.id !== employee.id)
      .sort((a, b) => Number(b.is_active !== false) - Number(a.is_active !== false) || a.name.localeCompare(b.name)),
    [employees, employee.id],
  );
  const [keepId, setKeepId] = React.useState<string>(() => guessKeep(employee, others) ?? "");
  const [keepBoth, setKeepBoth] = React.useState(false);
  const preview = useMergeEmployeesPreview(keepId || null, employee.id);
  const merge = useMergeEmployees();
  const keep = others.find((o) => o.id === keepId) ?? null;

  const p: MergeEmployeesResult | undefined = preview.data;
  const clashes = p?.clashes ?? [];
  const moved = p ? lines({ ...p.moved, ...p.renamed }) : [];
  const left = p ? lines(p.left) : [];
  const valid = !!keep && !!p && (clashes.length === 0 || keepBoth);

  const submit = () => {
    if (!valid || !keep) return;
    merge.mutate({ keepId: keep.id, dupId: employee.id, keepBoth }, { onSuccess: () => onClose() });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge {employee.name} into…</DialogTitle>
          <DialogDescription>
            For the same person added twice. Everything of {employee.name} moves to the employee you keep,
            and {employee.name} becomes inactive. No amount changes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <FormField label="Employee to keep" required htmlFor="merge-keep">
            <select id="merge-keep" value={keepId} onChange={(e) => { setKeepId(e.target.value); setKeepBoth(false); }} className={selectCls}>
              <option value="">Choose…</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}{o.designation ? ` · ${o.designation}` : ""}{o.is_active === false ? " (inactive)" : ""}
                </option>
              ))}
            </select>
          </FormField>

          {keep && preview.isLoading && <p className="text-xs text-ink-3">Checking what moves…</p>}
          {keep && preview.isError && (
            <p className="text-xs text-rose">{(preview.error as Error)?.message || "Could not check this merge."}</p>
          )}

          {keep && p && (
            <div className="rounded-md bg-paper-2/60 px-3 py-2 text-sm text-ink-2 space-y-1.5">
              <p>
                <b>Moves to {keep.name}:</b>{" "}
                {moved.length ? moved.join(", ") : "nothing — the record is empty"}.
              </p>
              {p.fields.length > 0 && (
                <p>Fills empty on {keep.name}: {p.fields.map((f) => FIELD_LABEL[f] ?? f).join(", ")}.</p>
              )}
              {left.length > 0 && (
                <p className="text-xs text-ink-3">
                  Stays on {employee.name} (both already have it): {left.join(", ")}.
                </p>
              )}
            </div>
          )}

          {keep && clashes.length > 0 && (
            <div className="rounded-md border border-rose/40 bg-rose-soft/30 px-3 py-2 space-y-2">
              <p className="text-sm text-ink">
                Both have a salary for{" "}
                {clashes.map((c) => `${monthLabel(c.period)} (${rupee(c.dup_net)} here, ${rupee(c.keep_net)} on ${keep.name})`).join("; ")}.
                One person cannot have two salaries for one month — undo the wrong one first, or keep both.
              </p>
              <label htmlFor="merge-keep-both" className="flex items-start gap-2 text-sm text-ink cursor-pointer">
                <Checkbox id="merge-keep-both" checked={keepBoth} onCheckedChange={(v) => setKeepBoth(v === true)} className="mt-0.5" />
                <span>
                  Keep both — they are different payments
                  <span className="block text-xs text-ink-3">That month&apos;s salary stays on {employee.name} as its own record.</span>
                </span>
              </label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={merge.isPending}>Cancel</Button>
          <Button variant="primary" loading={merge.isPending} disabled={!valid} onClick={submit}>
            {keep ? `Merge into ${keep.name}` : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
