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
import type { SalaryBankLink } from "@/lib/payroll/salary-bank-link";
import type * as React from "react";

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

/**
 * R-1895: next to the status — "Bank line" opens the bank-statement line that paid this salary
 * (highlighted there); a Paid salary no bank line points at reads "Not matched to bank" with
 * Match (the bank reconcile flow). Nothing for Not paid yet. Links stop propagation: a register
 * row is itself clickable.
 */
export function SalaryBankLinkAction({ link, canWrite }: { link: SalaryBankLink; canWrite: boolean }) {
  const stop = { onClick: (e: React.SyntheticEvent) => e.stopPropagation(), onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation() };
  if (link.kind === "open") {
    return (
      <Link href={link.href as never} {...stop} title="Open this payment in the bank statement"
        className="text-xs font-medium text-primary hover:underline whitespace-nowrap">
        Bank line
      </Link>
    );
  }
  if (link.kind === "not_matched") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ink-3 whitespace-nowrap">
        Not matched to bank
        {canWrite && (
          <Link href={link.matchHref as never} {...stop} title="Match this salary to its bank-statement line"
            className="font-medium text-primary hover:underline">
            Match
          </Link>
        )}
      </span>
    );
  }
  return null;
}
