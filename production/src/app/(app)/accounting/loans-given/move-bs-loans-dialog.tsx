/**
 * R-2604 — "Move to Loans given": old Balance Sheet lines "Advance/loan given · <name>" (booked from
 * Banking before R-2603) move here in one step. "Check first" shows each person (same name in any
 * case = one person, money returned taken off), where it goes, and the Balance Sheet total before and
 * after (the same). A name that is an employee is offered as an Employee loan — the owner ticks it.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee } from "@/lib/utils";
import {
  useBsLoanMovePreview, useApplyBsLoanMove, employeeLinks, type BsLoanMoveGroup,
} from "@/lib/queries/loans-given";

export function MoveBsLoansDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const preview = useBsLoanMovePreview(open);
  const apply = useApplyBsLoanMove();
  const [unticked, setUnticked] = React.useState<Set<string>>(new Set());
  const groups = preview.data?.groups ?? [];
  const movable = groups.filter((g) => g.target !== "skip");
  const skipped = groups.filter((g) => g.target === "skip");

  React.useEffect(() => { if (open) setUnticked(new Set()); }, [open]);

  const toggle = (key: string) => setUnticked((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const goesTo = (g: BsLoanMoveGroup) => {
    if (g.target === "employee" && g.employee && !unticked.has(g.key)) return `Employee loan — ${g.employee.name}`;
    if (g.merge_loan) return `Added to the open loan (${rupee(g.merge_loan.principal)})`;
    return "New loan on Loans given";
  };

  const onMove = () => {
    if (!preview.data) return;
    apply.mutate(
      { links: employeeLinks(groups, unticked), expectedNet: preview.data.movable_net },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="r2604-move-dialog">
        <DialogHeader>
          <DialogTitle>Move to Loans given — Check first</DialogTitle>
          <DialogDescription>
            Each person below becomes one loan. Nothing changes in the bank; the Balance Sheet total stays the same.
          </DialogDescription>
        </DialogHeader>

        {preview.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : preview.isError ? (
          <p className="text-sm text-rose" role="alert">{(preview.error as Error).message}</p>
        ) : movable.length === 0 ? (
          <p className="text-sm text-ink-2">Nothing to move — no “Advance/loan given” line with money still owed.</p>
        ) : (
          <div className="space-y-3 text-sm">
            <table className="w-full text-left">
              <thead className="text-xs text-ink-3">
                <tr><th className="py-1 pr-2">Person</th><th className="py-1 pr-2 text-right">Still owed</th><th className="py-1">Goes to</th></tr>
              </thead>
              <tbody>
                {movable.map((g) => (
                  <tr key={g.key} className="border-t border-hairline align-top" data-testid="r2604-move-row">
                    <td className="py-1.5 pr-2">
                      <div className="font-medium text-ink">{g.name}</div>
                      <div className="text-xs text-ink-3">
                        {g.rows.length} line{g.rows.length === 1 ? "" : "s"}
                        {g.returned > 0 && <> · given {rupee(g.given)}, returned {rupee(g.returned)}</>}
                      </div>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{rupee(g.net)}</td>
                    <td className="py-1.5">
                      <div>{goesTo(g)}</div>
                      {g.target === "employee" && g.employee && (
                        <label className="mt-1 flex items-center gap-2 text-xs text-ink-2">
                          <input type="checkbox" checked={!unticked.has(g.key)} onChange={() => toggle(g.key)} />
                          {g.employee.name} is our employee — move to Employee loans
                        </label>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {skipped.length > 0 && (
              <div className="rounded-md border border-hairline px-3 py-2 text-xs text-ink-2">
                <b>Stay on the Balance Sheet:</b>{" "}
                {skipped.map((g) => `${g.name} (${rupee(g.net)}) — ${g.skip_reason}`).join("; ")}
              </div>
            )}
            <p className="text-xs text-ink-2" data-testid="r2604-move-totals">
              Moving <b>{rupee(preview.data?.movable_net ?? 0)}</b> from Balance Sheet lines to loans. Loans and advances on the
              Balance Sheet stay {rupee(preview.data?.total_now ?? 0)} (unchanged) — the move is refused if they would not.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!preview.data || movable.length === 0 || apply.isPending} onClick={onMove}>
            {apply.isPending ? "Moving…" : `Move ${rupee(preview.data?.movable_net ?? 0)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
