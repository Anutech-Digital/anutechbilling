"use client";
/**
 * R-2894: "Link now" / "Match" when SEVERAL unlinked bank lines carry the salary's net (two
 * employees on the same pay, or the same person in two months). A short list — date, narration,
 * bank account — nearest the salary's pay date first; each row opens exactly that line's Reconcile
 * sheet. Nothing is booked here: the link itself is the unchanged Reconcile flow.
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useBankAccounts } from "@/lib/queries/bank";
import { formatDate, rupee } from "@/lib/utils";
import { bankLineFocusHref, type WaitingBankLine } from "@/lib/payroll/salary-bank-link";

function Lines({ lines }: { lines: readonly WaitingBankLine[] }) {
  const { data: accounts } = useBankAccounts();
  const name = new Map((accounts ?? []).map((a) => [a.id, a.name]));
  return (
    <ul className="divide-y divide-hairline" aria-label="Unlinked bank lines of this amount">
      {lines.map((l, i) => (
        <li key={l.id}>
          <Link
            href={bankLineFocusHref(l) as never}
            onClick={(e) => e.stopPropagation()}
            className="block px-3 py-2 text-xs hover:bg-paper-2 focus-visible:bg-paper-2 outline-none"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink">{formatDate(l.txn_date)}</span>
              <span className="tabular-nums text-ink-2">{rupee(l.debit)}</span>
            </span>
            <span className="block truncate text-ink-3" title={l.description ?? undefined}>{l.description || "No narration"}</span>
            <span className="flex items-center justify-between gap-2 text-ink-3">
              <span className="truncate">{name.get(l.bank_account_id) ?? "Bank account"}</span>
              {i === 0 && <span className="text-primary font-medium whitespace-nowrap">Closest date</span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SalaryBankLinePicker({
  lines, label = "Link now", variant = "default", title,
}: {
  lines: readonly WaitingBankLine[];
  label?: string;
  variant?: "default" | "link";
  title?: string;
}) {
  const stop = { onClick: (e: React.SyntheticEvent) => e.stopPropagation(), onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation() };
  return (
    <Popover>
      <PopoverTrigger asChild>
        {variant === "link" ? (
          <button type="button" title={title} {...stop} className="font-medium text-primary hover:underline">
            {label} ({lines.length} lines)
          </button>
        ) : (
          <Button size="sm" variant="default" title={title} {...stop}>{label} ({lines.length} lines)</Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" {...stop}>
        <p className="px-3 pt-2.5 pb-1 text-xs font-medium text-ink">Which bank line paid this salary?</p>
        <Lines lines={lines} />
      </PopoverContent>
    </Popover>
  );
}
