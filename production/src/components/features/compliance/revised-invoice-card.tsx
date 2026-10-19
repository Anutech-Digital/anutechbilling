/**
 * R-1531 — "Revised tax invoices due" on /compliance (Section 31(3)(a)).
 *
 * Shows only when the business is now Registered, its effective date is in the past and it
 * issued Bills of Supply between that date and its registration certificate. Lists those bills
 * (each links to the invoice), their value and the last day — certificate date + 1 month. A
 * reminder only: nothing is converted. A failed read says so with Try again (§17c, §24) — the
 * card never just disappears on an error. Maths: lib/compliance/revised-invoice.ts.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { LoadErrorInline } from "@/components/shared/load-error";
import { formatIstDate } from "@/lib/dates/ist";
import { rupee } from "@/lib/utils";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { billOfSupplyValue } from "@/lib/compliance/composition-return";
import { REVISED_INVOICE_ANCHOR, revisedInvoiceHeadline, type RevisedInvoiceReminder } from "@/lib/compliance/revised-invoice";
import { useRevisedInvoiceReminder } from "@/lib/compliance/revised-invoice-query";

const SETTINGS_HREF = "/settings?tab=company" as Route;

function deadlineText(r: RevisedInvoiceReminder): string {
  if (r.deadline === null || r.daysLeft === null) return "";
  if (r.daysLeft < 0) return `The last day was ${formatIstDate(r.deadline)} (${-r.daysLeft}d ago).`;
  if (r.daysLeft === 0) return `Last day: today, ${formatIstDate(r.deadline)}.`;
  return `Last day: ${formatIstDate(r.deadline)} (${r.daysLeft}d left).`;
}

export function RevisedInvoiceCard() {
  const q = useRevisedInvoiceReminder();

  if (q.error) {
    return (
      <Card className="mb-4 p-0" id={REVISED_INVOICE_ANCHOR}>
        <LoadErrorInline what="Revised-invoice check (Bills of Supply after GST registration)" error={q.error} onRetry={q.refetch} />
      </Card>
    );
  }
  const r = q.reminder;
  if (!r) return null;

  const late = r.state === "overdue";
  return (
    <Card
      id={REVISED_INVOICE_ANCHOR}
      className={`mb-4 p-4 md:p-5 border ${late ? "border-rose/40" : "border-amber/40"}`}
      aria-labelledby="revised-invoices-title"
      data-revised-invoice-card
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 id="revised-invoices-title" className="font-serif text-lg text-ink leading-tight">
          {revisedInvoiceHeadline(r)}
        </h2>
        <Badge kind={late ? "danger" : "warning"} dot>
          {late ? "Deadline passed" : r.state === "no_rc_date" ? "Add certificate date" : `${r.daysLeft}d left`}
        </Badge>
      </div>
      <p className="mt-1.5 text-xs text-ink-2 leading-relaxed max-w-3xl">
        You became GST-registered from {formatIstDate(r.from)}, but issued these Bills of Supply (no GST)
        {r.rcDate ? ` up to your registration certificate of ${formatIstDate(r.rcDate)}` : " after that date"}.
        The law (CGST Section 31(3)(a)) lets you issue a revised tax invoice for each within one month of
        the certificate. Create them yourself — these bills are not changed automatically.
      </p>
      <p className={`mt-2 text-sm font-medium ${late ? "text-rose-ink" : "text-ink"}`}>
        {r.state === "no_rc_date" ? (
          <>
            Add the date your GST registration certificate was issued in{" "}
            <Link href={SETTINGS_HREF} className="text-amber-ink underline underline-offset-2">Settings → Company → GST registration</Link>{" "}
            {q.rcDateColumn ? "to see the last day." : "(needs a database update first) to see the last day."}
          </>
        ) : (
          <>
            {deadlineText(r)}
            {late && " Ask your CA how to correct these bills now."}
          </>
        )}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Bills of Supply that need a revised tax invoice</caption>
          <thead>
            <tr className="text-left text-3xs uppercase tracking-wider text-ink-3">
              <th scope="col" className="py-1.5 pr-3 font-semibold">Bill</th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">Date</th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">Customer</th>
              <th scope="col" className="py-1.5 text-right font-semibold">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {r.bills.map((b) => (
              <tr key={b.id}>
                <td className="py-1.5 pr-3 font-mono text-xs">
                  <Link href={invoiceHref(b.id) as Route} className="text-amber-ink underline underline-offset-2">{b.id}</Link>
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatIstDate(b.invoice_date)}</td>
                <td className="py-1.5 pr-3 max-w-[16rem] truncate" title={b.customer_name ?? ""}>{b.customer_name || "—"}</td>
                <td className="py-1.5 text-right tabular-nums">{rupee(billOfSupplyValue(b))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-hairline font-medium">
              <td className="py-1.5 pr-3" colSpan={3}>{r.count} {r.count === 1 ? "bill" : "bills"}</td>
              <td className="py-1.5 text-right tabular-nums">{rupee(r.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}
