/**
 * IssueCreditNoteDialog — issue a GST credit OR debit note (CGST §34) against
 * an invoice. Same document family, opposite direction:
 *   • credit note → REDUCES the invoice (discount / overbill / seats down / return)
 *   • debit note  → RAISES the invoice (undercharge / additional charge)
 *
 * The GST split is derived server-side from the invoice (mirrors its head + rate;
 * an export invoice yields a zero-rated note). The original invoice is never
 * edited — the note is a separate offsetting document.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import { useIssueCreditNote } from "@/lib/queries/credit-notes";
import { useIssueDebitNote } from "@/lib/queries/debit-notes";
import type { CreditNoteReasonCode, DebitNoteReasonCode } from "@/lib/supabase/database.types";

const CREDIT_REASONS: { value: CreditNoteReasonCode; label: string }[] = [
  { value: "seats_reduced", label: "Seats / quantity reduced" },
  { value: "overbilling",   label: "Over-billed (wrong amount)" },
  { value: "discount",      label: "Post-sale discount / rebate" },
  { value: "cancellation",  label: "Cancellation" },
  { value: "return",        label: "Return" },
  { value: "other",         label: "Other" },
];
const DEBIT_REASONS: { value: DebitNoteReasonCode; label: string }[] = [
  { value: "undercharge",       label: "Under-charged (billed too little)" },
  { value: "additional_charge", label: "Additional charge" },
  { value: "price_escalation",  label: "Price escalation" },
  { value: "other",             label: "Other" },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  customerName: string | null;
  /** Amount still owed on the invoice. */
  netPayable: number;
  taxRate: number | null;
  interState: boolean | null;
  isExport?: boolean;
  /** 'credit' reduces the invoice, 'debit' raises it. Defaults to 'credit'. */
  mode?: "credit" | "debit";
}

export function IssueCreditNoteDialog({
  open, onOpenChange, invoiceId, customerName, netPayable, taxRate, interState, isExport, mode = "credit",
}: Props) {
  const isDebit = mode === "debit";
  const issueCredit = useIssueCreditNote();
  const issueDebit = useIssueDebitNote();
  const busy = isDebit ? issueDebit.isPending : issueCredit.isPending;

  const [amount, setAmount] = React.useState<string>("");
  const [reasonCode, setReasonCode] = React.useState<string>(isDebit ? "undercharge" : "seats_reduced");
  const [reason, setReason] = React.useState("");

  React.useEffect(() => {
    if (open) {
      // Credit defaults to the amount owed; a debit is a fresh add, so start blank.
      setAmount(isDebit ? "" : String(Math.max(0, netPayable)));
      setReasonCode(isDebit ? "undercharge" : "seats_reduced");
      setReason("");
    }
  }, [open, netPayable, isDebit]);

  const gross = Math.round(Number(amount) || 0);
  const rate = isExport ? 0 : (taxRate ?? 18);
  const taxable = rate === 0 ? gross : Math.round((gross * 100) / (100 + rate));
  const tax = gross - taxable;

  const noun = isDebit ? "debit note" : "credit note";
  const verb = isDebit ? "raises" : "reduces";

  async function submit() {
    if (gross <= 0) { toast.error(`Enter a ${noun} amount greater than zero.`); return; }
    try {
      if (isDebit) {
        await issueDebit.mutateAsync({ invoiceId, grossAmount: gross, reasonCode: reasonCode as DebitNoteReasonCode, reason: reason.trim() || null });
      } else {
        await issueCredit.mutateAsync({ invoiceId, grossAmount: gross, reasonCode: reasonCode as CreditNoteReasonCode, reason: reason.trim() || null });
      }
      onOpenChange(false);
    } catch {
      /* toast handled in the hook */
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="!p-5 border-b border-hairline">
          <SheetTitle>Issue {noun}</SheetTitle>
          <SheetDescription>
            {isDebit ? "Raise" : "Reduce"} invoice <b className="font-mono">{invoiceId}</b>
            {customerName ? <> for <b>{customerName}</b></> : null}. A GST {noun} (CGST §34) is
            created — the invoice itself is not edited.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="rounded-md bg-paper-2/50 border border-hairline px-3 py-2 text-[11px] text-ink-3">
            Amount still owed on this invoice: <b className="text-ink">{rupee(netPayable)}</b>
          </div>

          <FormField label={`${isDebit ? "Debit" : "Credit"} amount (₹, incl GST)`} htmlFor="note_amount">
            <Input
              id="note_amount"
              type="text"
              inputMode="numeric"
              prefix="₹"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="0"
            />
            <p className="mt-1 text-[11px] text-ink-3">
              {isExport
                ? "Export (zero-rated) — no GST on the note."
                : `Splits as ${interState ? "IGST" : "CGST + SGST"} @ ${rate}%: taxable ${rupee(taxable)} + tax ${rupee(tax)}.`}
            </p>
          </FormField>

          <FormField label="Reason" htmlFor="note_reason_code">
            <select
              id="note_reason_code"
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              {(isDebit ? DEBIT_REASONS : CREDIT_REASONS).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </FormField>

          <FormField label="Note (optional)" htmlFor="note_reason">
            <textarea
              id="note_reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={isDebit ? "e.g. Billed 8 seats, actual usage 10 — adding 2" : "e.g. Reduced from 10 to 6 seats effective this month"}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
            />
          </FormField>

          <div className="rounded-md bg-amber-soft/40 border border-amber/30 px-3 py-2 text-[11px] text-amber-ink leading-relaxed">
            A {noun} is permanent + GST-reported (GSTR-1). It {verb} your output GST and the
            customer&apos;s ITC — issue it only for a genuine {isDebit ? "additional charge" : "reduction"}.
          </div>
        </div>

        <SheetFooter className="!p-5 border-t border-hairline">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon="receipt" loading={busy} onClick={submit}>
            Issue {noun} · {rupee(gross)}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
