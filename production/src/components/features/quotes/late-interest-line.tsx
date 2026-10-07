/**
 * R-368 — "Late interest so far ₹X" on a credit quote, with the one way to charge it.
 *
 * 18% p.a. simple from the due date, per day, whole rupees (lib/credit/late-interest.ts).
 * Shown to everyone who can see the quote; charged ONLY by an owner/billing click, as a
 * debit note on the late invoice (interest + GST at the invoice's rate). Never automatic.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/providers/confirm-provider";
import { rupee } from "@/lib/utils";
import { toIstDate } from "@/lib/dates/ist";
import { formatIstDate } from "@/lib/trials/start-from-quote";
import {
  LATE_INTEREST_RATE_PCT, lateInterestView, mayAddLateInterest, interestDebitNoteGross,
} from "@/lib/credit/late-interest";
import { useLateInterestFacts, useAddLateInterest } from "@/lib/credit/queries";

interface Props {
  quoteId: string;
  invoiceId: string | null;
  role: string | null | undefined;
}

export function LateInterestLine({ quoteId, invoiceId, role }: Props) {
  const confirm = useConfirm();
  const { data: facts } = useLateInterestFacts(quoteId, invoiceId, true);
  const add = useAddLateInterest();
  const today = toIstDate(new Date());
  const view = facts ? lateInterestView({ invoice: facts.invoice, payments: facts.payments, notes: facts.notes, today }) : null;
  if (!facts || !view) return null;

  const canAdd = mayAddLateInterest(role) && view.toAdd > 0;
  const gross = interestDebitNoteGross(view.toAdd, facts.invoice.tax_rate);

  const onAdd = async () => {
    const ok = await confirm({
      title: `Add ${rupee(view.toAdd)} late interest?`,
      body: `A debit note on ${facts.invoice.id} for ${rupee(gross)} (${rupee(view.toAdd)} interest + GST). `
        + `${LATE_INTEREST_RATE_PCT}% p.a. simple from ${formatIstDate(view.dueDate)} to ${formatIstDate(today)}.\n`
        + "Nothing is sent to the customer.",
      confirmLabel: "Add debit note",
      icon: "receipt",
    });
    if (!ok) return;
    try {
      const res = await add.mutateAsync({
        invoiceId: facts.invoice.id, interest: view.toAdd, taxRate: facts.invoice.tax_rate,
        dueDate: view.dueDate, asOf: today,
      });
      toast.success(`Debit note ${res.debit_note_id} added`, { description: `${rupee(gross)} added to ${facts.invoice.id}.` });
    } catch (err) {
      toastError(err, { fallback: "Could not add the late interest.", description: "Nothing was added. Try again." });
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-2">
      <span>
        Late interest so far <b className="font-mono">{rupee(view.soFar)}</b>
        {" "}({LATE_INTEREST_RATE_PCT}% p.a. from {formatIstDate(view.dueDate)}, {view.daysLate} {view.daysLate === 1 ? "day" : "days"})
        {view.charged > 0 && <> · {rupee(view.charged)} already added</>}
      </span>
      {canAdd && (
        <Button size="sm" variant="default" icon="plus" onClick={onAdd} loading={add.isPending}>
          Add {rupee(view.toAdd)} + GST
        </Button>
      )}
    </div>
  );
}
