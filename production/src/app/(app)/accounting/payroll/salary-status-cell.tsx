"use client";
/**
 * R-1831: the salary status badge (+ its next-step button) — the one place the Salary
 * Register and the Payroll screens show whether a salary was paid. The words come from
 * lib/payroll/salary-status.ts; this only draws them.
 */
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import { salaryPayState, salaryBankLineKey, type SalaryPayFacts } from "@/lib/payroll/salary-status";

export function SalaryStatusCell({
  p, waitingLines, canWrite, size = "md", showAmounts = false,
}: {
  p: SalaryPayFacts;
  /** From useUnlinkedSalaryBankLines: whole-rupee amount → bank account holding an unlinked line. */
  waitingLines?: Map<number, string>;
  canWrite: boolean;
  size?: "sm" | "md";
  /** Partial: also show paid / net (the payroll month view has room for it). */
  showAmounts?: boolean;
}) {
  const accountId = p.paid_amount > 0 ? undefined : waitingLines?.get(salaryBankLineKey(p.net));
  const s = salaryPayState(p, Boolean(accountId));
  const label = s.key === "partial" && showAmounts ? `Partial · ${rupee(p.paid_amount)}/${rupee(p.net)}` : s.label;
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap justify-end">
      <Badge kind={s.tone} size={size} dot title={s.hint}>{label}</Badge>
      {s.key === "link_bank" && canWrite && accountId && (
        <Button asChild size="sm" variant="default" title={s.hint}>
          {/* The bank page's existing deep link: opens that line's reconcile, salary preselected by amount. */}
          {/* stopPropagation: the register's whole row is a link to the employee. */}
          <Link
            href={`/accounting/banking/${accountId}?match=${salaryBankLineKey(p.net)}` as never}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            Link now
          </Link>
        </Button>
      )}
    </span>
  );
}
