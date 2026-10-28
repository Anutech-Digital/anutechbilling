/**
 * R-2046 — "Commitment due" on the Quotes list: the unpaid part payment requests (R-2044).
 *
 * Not a status tab: every quote already sits in exactly one tab (R-469) and these requests are
 * counted under Sent / Awaiting payment. So, like the approvals strip, it is a strip above the
 * tabs that opens its own section with the columns this work needs — customer, period, amount,
 * days overdue — and the two next steps, which open the SAME dialogs as the quote page
 * (Record payment → RecordPaymentDialog; Customer stopped → CustomerStoppedDialog). The page
 * owns the dialogs; this component only says which quote's row was pressed (its own id).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn, rupee, formatDate } from "@/lib/utils";
import type { CommitmentDueRow } from "./commitment-due";

export interface CommitmentDueStripProps {
  count: number;
  /** ₹ still due across the requests. */
  total: number;
  onShow: () => void;
}

/** The strip above the tabs. Silent at zero. */
export function CommitmentDueStrip({ count, total, onShow }: CommitmentDueStripProps) {
  if (count <= 0) return null;
  const one = count === 1;
  return (
    <div
      role="status"
      className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-hairline-strong bg-paper-2 px-3.5 py-2.5"
    >
      <Icon name="clock" size={16} className="shrink-0 text-amber-ink" />
      <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink-2">
        <b className="text-ink">
          {count} part payment request{one ? "" : "s"} unpaid · {rupee(total)} due.
        </b>{" "}
        Committed under an annual plan, not yet invoiced — so not in receivables.
      </p>
      <Button size="sm" variant="primary" icon="filter" onClick={onShow}>
        Commitment due
      </Button>
    </div>
  );
}

export interface CommitmentDueSectionProps {
  rows: readonly CommitmentDueRow[];
  /** ₹ still due across `rows`. */
  total: number;
  /** canRecordMoney(role) — without it the money buttons are not offered. */
  mayRecordMoney: boolean;
  onRecordPayment: (quoteId: string) => void;
  onCustomerStopped: (quoteId: string) => void;
  /** Back to the ordinary quotes list. */
  onClose: () => void;
}

const dueTone: Record<CommitmentDueRow["due"]["tone"], string> = {
  overdue: "text-rose-ink font-semibold",
  today: "text-amber-ink font-semibold",
  upcoming: "text-ink-2",
  unknown: "text-ink-3",
};

function CustomerCell({ r }: { r: CommitmentDueRow }) {
  return r.customerId ? (
    <Link href={`/customers/${r.customerId}` as never} className="font-medium text-ink hover:text-amber-ink hover:underline">
      {r.customerName}
    </Link>
  ) : (
    <span className="font-medium text-ink">{r.customerName}</span>
  );
}

function AmountCell({ r }: { r: CommitmentDueRow }) {
  return (
    <>
      <span className="font-mono tabular-nums text-ink">{rupee(r.amount)}</span>
      {r.partPaid && (
        <span className="block text-2xs text-amber-ink tabular-nums">{rupee(r.stillDue)} still due</span>
      )}
    </>
  );
}

function Actions({ r, props }: { r: CommitmentDueRow; props: CommitmentDueSectionProps }) {
  if (!props.mayRecordMoney) return null;
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button size="sm" variant="primary" icon="rupee" onClick={() => props.onRecordPayment(r.quoteId)}>
        Record payment
      </Button>
      {/* Same rule as the quote page (showCustomerStopped): only while nothing was received. */}
      {!r.partPaid && (
        <Button size="sm" variant="ghost" icon="x" onClick={() => props.onCustomerStopped(r.quoteId)}>
          Customer stopped
        </Button>
      )}
    </div>
  );
}

export function CommitmentDueSection(props: CommitmentDueSectionProps) {
  const { rows, total, onClose } = props;
  const one = rows.length === 1;

  return (
    <Card flush className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Commitment due</h2>
          <p className="text-2xs text-ink-3 mt-0.5">
            Part payment requests of subscriptions billed in parts. The tax invoice is raised when each is paid.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-right">
            <span className="block text-3xs uppercase tracking-wider font-semibold text-ink-3">
              Total due · {rows.length} payment request{one ? "" : "s"}
            </span>
            <span data-testid="commitment-total" className="font-serif text-lg font-bold tabular-nums text-ink">
              {rupee(total)}
            </span>
          </p>
          <Button size="sm" icon="x" onClick={onClose}>Show all quotes</Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-ink-3">
          No part payment requests are due. A request leaves this list when it is paid or marked Customer stopped.
        </p>
      ) : (
        <>
          {/* Phones: one card per request. */}
          <ul className="md:hidden divide-y divide-hairline">
            {rows.map((r) => (
              <li key={r.quoteId} className="px-4 py-3 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CustomerCell r={r} />
                    <p className="text-2xs text-ink-2">{r.period}</p>
                  </div>
                  <div className="text-right shrink-0"><AmountCell r={r} /></div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className={cn("text-xs", dueTone[r.due.tone])}>{r.due.text}</span>
                  <Link href={`/quotes/${r.quoteId}` as never} className="font-mono text-2xs text-ink-3 hover:underline">{r.quoteId}</Link>
                </div>
                <Actions r={r} props={props} />
              </li>
            ))}
          </ul>

          {/* Tablet and up — fits 1280px with the Action column visible (no min-width). */}
          <table className="hidden md:table w-full text-sm">
            <thead className="bg-paper-2 border-b border-hairline text-2xs uppercase tracking-wider text-ink-3">
              <tr>
                <th scope="col" className="text-left px-3 py-2 font-semibold">Customer</th>
                <th scope="col" className="text-left px-3 py-2 font-semibold">Period</th>
                <th scope="col" className="text-right px-3 py-2 font-semibold">Amount (incl. GST)</th>
                <th scope="col" className="text-left px-3 py-2 font-semibold">Days overdue</th>
                <th scope="col" className="text-right px-3 py-2 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.quoteId} className="border-b border-hairline last:border-0 align-top">
                  <td className="px-3 py-2.5">
                    <CustomerCell r={r} />
                    <Link href={`/quotes/${r.quoteId}` as never} className="block font-mono text-2xs text-ink-3 hover:underline">{r.quoteId}</Link>
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">{r.period}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap"><AmountCell r={r} /></td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className={cn("text-xs", dueTone[r.due.tone])}>{r.due.text}</span>
                    {r.billOn && <span className="block text-2xs text-ink-3">Due {formatDate(r.billOn)}</span>}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap"><Actions r={r} props={props} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}
