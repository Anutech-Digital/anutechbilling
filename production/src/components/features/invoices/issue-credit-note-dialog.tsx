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
import { useQuery } from "@tanstack/react-query";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { rupee } from "@/lib/utils";
import { useIssueCreditNote } from "@/lib/queries/credit-notes";
import { useIssueDebitNote } from "@/lib/queries/debit-notes";
import { createClient } from "@/lib/supabase/client";
import { istToday } from "@/lib/dates/ist";
import { creditNoteDeadlineWarning } from "@/lib/gst/credit-note-deadline";
import { noteMixedSplitText, noteRefusedText, noteSplit, noteSplitRule, type NoteSplitRule } from "@/lib/gst/line-rates";
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
  /** R-2219: what is still owed — ALWAYS `invoiceAmountDue(invoice)` (lib/payments/amount-due),
   *  the same number the invoice page shows as "Balance due" (net_payable − paid_amount; the note
   *  RPCs keep net_payable = amount − credit notes + debit notes). Never `net_payable` alone: it
   *  ignores receipts, so a part-paid invoice read as wholly unpaid. */
  amountDue: number;
  taxRate: number | null;
  interState: boolean | null;
  isExport?: boolean;
  /** 'credit' reduces the invoice, 'debit' raises it. Defaults to 'credit'. */
  mode?: "credit" | "debit";
  /** Invoice date (YYYY-MM-DD) for the s.34 time-limit warning. Read from the DB when not passed. */
  invoiceDate?: string | null;
  /** R-1711: the reason picked when it opens (the cancel dialog opens it as "cancellation"). */
  defaultReasonCode?: CreditNoteReasonCode;
  /** R-2632: the amount filled in when it opens, instead of the balance still owed (a cancellation credits
   *  the whole invoice, even when part or all of it is paid — the paid part becomes customer credit). */
  defaultAmount?: number;
  /** R-1711: called after the note is issued (the cancel dialog re-reads what is still due). */
  onIssued?: () => void;
}

/** R-335: the invoice's date — fetched only when the caller did not pass it and a credit dialog is open. */
function useInvoiceDate(invoiceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["invoices", "date", invoiceId],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await createClient().from("invoices").select("invoice_date").eq("id", invoiceId).maybeSingle();
      if (error) throw error;
      return data?.invoice_date ?? null;
    },
  });
}

/** R-2717: how a note on this invoice is split — one rate, or (lines at different GST rates)
 *  like the invoice itself. The same rule as SQL invoice_note_gst_split, for the preview only:
 *  the RPC decides again when the note is issued. */
function useNoteSplitRule(invoiceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["invoices", "note-split-rule", invoiceId],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<NoteSplitRule | null> => {
      const { data, error } = await createClient().from("invoices")
        .select("taxable_value, tax_amount, tax_rate, line_items").eq("id", invoiceId).maybeSingle();
      if (error) throw error;
      return data ? noteSplitRule(data) : null;
    },
  });
}

export function IssueCreditNoteDialog({
  open, onOpenChange, invoiceId, customerName, amountDue, taxRate, interState, isExport, mode = "credit", invoiceDate, defaultReasonCode, defaultAmount, onIssued,
}: Props) {
  const isDebit = mode === "debit";
  const splitRuleQ = useNoteSplitRule(invoiceId, open);
  const splitRule = splitRuleQ.data ?? null;
  /* While the invoice's rates are being read, and when a mixed-rate invoice cannot be split,
     there is no true preview to show — Issue waits (the RPC would refuse the second anyway). */
  const splitPending = open && splitRuleQ.isLoading;
  const splitRefused = splitRule?.kind === "refused";
  const { data: fetchedDate } = useInvoiceDate(invoiceId, open && !isDebit && invoiceDate === undefined);
  // GST s.34(2): a CREDIT note is time-limited (a debit note is not). Warn only — never block; the CA confirms.
  const lateWarning = isDebit ? null : creditNoteDeadlineWarning(invoiceDate ?? fetchedDate ?? null, istToday());
  const issueCredit = useIssueCreditNote();
  const issueDebit = useIssueDebitNote();
  const busy = isDebit ? issueDebit.isPending : issueCredit.isPending;

  const [amount, setAmount] = React.useState<string>("");
  const [reasonCode, setReasonCode] = React.useState<string>(isDebit ? "undercharge" : (defaultReasonCode ?? "seats_reduced"));
  const [reason, setReason] = React.useState("");

  React.useEffect(() => {
    if (open) {
      // Credit defaults to the balance still owed (blank when nothing is owed); a debit is a
      // fresh add, so start blank.
      const owed = Math.max(0, Math.round(amountDue));
      if (!isDebit && defaultAmount != null && defaultAmount > 0) setAmount(String(Math.round(defaultAmount)));
      else setAmount(isDebit || owed <= 0 ? "" : String(owed));
      setReasonCode(isDebit ? "undercharge" : (defaultReasonCode ?? "seats_reduced"));
      setReason("");
    }
  }, [open, amountDue, isDebit, defaultReasonCode, defaultAmount]);

  const gross = Math.round(Number(amount) || 0);
  /* R-2717: the rate is the invoice's (when every line carries one same rate of its own, that
     rate); lines at different GST rates → the note is split like the invoice (its own
     taxable : GST proportion), not backed out at one rate. */
  const rate = isExport ? 0 : (splitRule?.kind === "rate" ? splitRule.rate : (taxRate ?? 18));
  const mixedSplit = splitRule?.kind === "mixed" ? noteSplit(gross, splitRule) : null;
  const taxable = mixedSplit ? mixedSplit.taxable : rate === 0 ? gross : Math.round((gross * 100) / (100 + rate));
  const tax = gross - taxable;
  /* R-2219: a credit above the balance is allowed (a refund of money already received), but the
     owner sees what the extra means before issuing it — issue_credit_note_core turns it into
     open customer credit. */
  const owedNow = Math.max(0, Math.round(amountDue));
  const overBalance = !isDebit && gross > owedNow ? gross - owedNow : 0;

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
      onIssued?.();
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
          {lateWarning && (
            <div role="alert" className="rounded-md bg-amber-soft/60 border border-amber/40 px-3 py-2 text-2xs text-amber-ink leading-relaxed">
              <b>Past the GST credit note time limit.</b> {lateWarning}
            </div>
          )}
          <div data-testid="note-amount-owed" className="rounded-md bg-paper-2/50 border border-hairline px-3 py-2 text-2xs text-ink-3">
            Amount still owed on this invoice: <b className="text-ink">{rupee(owedNow)}</b>
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
            <p className="mt-1 text-2xs text-ink-3">
              {splitPending
                ? "Checking the invoice's GST rates…"
                : splitRule?.kind === "refused"
                ? noteRefusedText(splitRule.rates)
                : splitRule?.kind === "mixed"
                ? noteMixedSplitText({ rates: splitRule.rates, interState: !!interState, taxable: rupee(taxable), tax: rupee(tax) })
                : isExport
                ? "Export (zero-rated) — no GST on the note."
                : `Splits as ${interState ? "IGST" : "CGST + SGST"} @ ${rate}%: taxable ${rupee(taxable)} + tax ${rupee(tax)}.`}
            </p>
            {overBalance > 0 && (
              <p data-testid="note-over-balance" role="status" className="mt-2 rounded-md bg-amber-soft/60 border border-amber/40 px-3 py-2 text-2xs text-amber-ink leading-relaxed">
                This is {rupee(overBalance)} more than is still owed ({rupee(owedNow)}). The extra{" "}
                {rupee(overBalance)} is money already received — it becomes customer credit to refund
                or adjust against a later invoice.
              </p>
            )}
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

          <div className="rounded-md bg-amber-soft/40 border border-amber/30 px-3 py-2 text-2xs text-amber-ink leading-relaxed">
            A {noun} is permanent + GST-reported (GSTR-1). It {verb} your output GST and the
            customer&apos;s ITC — issue it only for a genuine {isDebit ? "additional charge" : "reduction"}.
          </div>
        </div>

        <SheetFooter className="!p-5 border-t border-hairline">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon="receipt" loading={busy} disabled={splitPending || splitRefused} onClick={submit}>
            Issue {noun} · {rupee(gross)}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
