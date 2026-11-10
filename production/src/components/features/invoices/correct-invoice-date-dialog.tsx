/**
 * R-2173 (9 Nov 2026) — "Correct date" on an issued invoice, while its GST month is not filed yet.
 *
 * Under CGST s.34 an issued invoice is fixed with a credit note — but until the month's GST return is
 * filed, a wrong DATE can still be corrected on the same document (e.g. an invoice raised late and dated
 * the day it was raised instead of the day the money came). The database decides everything through
 * correct_invoice_date() (migration 20261109132649): owner or accountant only; neither the old nor the new
 * month GST-filed (R-2621's one rule: GST returns filed up to / books lock / GSTR-1 marked filed); same
 * financial year (R-2632: another year would need a new number, and an issued number is never changed — the
 * dialog says so and offers "Credit note instead": a credit note on this invoice + a fresh invoice in that year); no IRN, no Zoho-imported sale, no foreign
 * currency, no credit/debit note, not sent on the business network. The due date moves by the same days,
 * and the change is kept in the activity log with the reason. This dialog only collects the date and the
 * reason; every refusal comes back from the server in plain words.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { fyBounds, fyLabel, istToday } from "@/lib/dates/ist";
import { formatDate } from "@/lib/utils";
import { canDeleteMoney } from "@/lib/auth/roles";
import { toastError } from "@/lib/errors/toast-error";

export type CorrectableInvoice = {
  id: string;
  invoice_date: string | null;
  status: string;
  document_kind?: string | null;
  gst_irn?: string | null;
  zoho_invoice_id?: string | null;
  sale_import_batch_id?: string | null;
  currency?: string | null;
  fx_rate?: number | null;
};

/** What else the page knows that makes the server refuse (so the button is not a dead end). */
export type CorrectDateFacts = { hasNotes?: boolean; onNetwork?: boolean };

/** Who sees the button: owner/accountant, on an issued INR sale of ours with no IRN, no credit/debit note and
 *  no network copy. The server checks it all again (and the GST-filed months, which only it knows). */
export function canCorrectInvoiceDate(invoice: CorrectableInvoice, role: string | null | undefined, facts: CorrectDateFacts = {}): boolean {
  if (!role || !canDeleteMoney(role)) return false; // unknown role (still loading) → hidden, unlike canDeleteMoney
  if (!invoice.invoice_date || invoice.status === "draft" || invoice.status === "void") return false;
  if (invoice.document_kind === "opening_invoice") return false;
  if (invoice.gst_irn && invoice.gst_irn.trim()) return false;
  if (invoice.zoho_invoice_id || invoice.sale_import_batch_id) return false;
  if (facts.hasNotes || facts.onNetwork) return false;
  if (invoice.fx_rate != null || (invoice.currency && invoice.currency !== "INR")) return false;
  return true;
}

/** The date picker's range: the invoice's own financial year (1 Apr – 31 Mar), never after today (IST). */
export function correctDateBounds(invoiceDate: string, todayIst: string): { min: string; max: string } {
  const fy = fyBounds(invoiceDate);
  return { min: fy.start, max: fy.end < todayIst ? fy.end : todayIst };
}

/** R-2632: what to do when the right date is in ANOTHER financial year. The invoice number belongs to its FY
 *  (CGST Rule 46) and is never changed, so the date cannot cross the year: a credit note on this invoice
 *  (money already received becomes the customer's credit) and a fresh invoice dated in the right year. */
export function otherYearNote(invoiceDate: string): string {
  return `Right date in another financial year? Invoice numbers belong to their year (this one to FY ${fyLabel(invoiceDate)}) and an issued number never changes. Issue a credit note for this invoice (money already received on it becomes the customer's credit), then raise a fresh invoice dated in the right year.`;
}

/** Why Save is not ready yet (shown under the button) — null when it is. */
export function correctDateHint(current: string, date: string, reason: string, bounds: { min: string; max: string }): string | null {
  if (!date) return "Pick the correct date.";
  if (date === current) return "Pick a date different from the one on the invoice.";
  if (date < bounds.min || date > bounds.max) return `Pick a date between ${formatDate(bounds.min)} and ${formatDate(bounds.max)}.`;
  if (reason.trim().length < 5) return "Write why (at least 5 characters) — it is kept in the activity log.";
  return null;
}

type CorrectRpc = (
  fn: "correct_invoice_date",
  args: { p_invoice_id: string; p_new_date: string; p_reason: string },
) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

function useCorrectInvoiceDate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { invoiceId: string; newDate: string; reason: string }) => {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as CorrectRpc;
      const { error } = await rpc.call(supabase, "correct_invoice_date", {
        p_invoice_id: args.invoiceId, p_new_date: args.newDate, p_reason: args.reason,
      });
      if (error) throw error;
    },
    /* The date moves the invoice between months in every report (P&L, GST, aging, dashboard) — refresh all. */
    onSuccess: () => { qc.invalidateQueries(); },
    onError: (e) => toastError(e, { fallback: "Could not correct the invoice date" }),
  });
}

const fmt = (d: string) => formatDate(d);

export function CorrectInvoiceDateButton({ invoice, role, facts, onCreditNoteInstead }: {
  invoice: CorrectableInvoice; role: string | null | undefined; facts?: CorrectDateFacts;
  /** R-2632: opens the credit note sheet (passed only when this user may issue one). */
  onCreditNoteInstead?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  if (!canCorrectInvoiceDate(invoice, role, facts)) return null;
  return (
    <>
      <Button size="sm" variant="outline" icon="calendar" onClick={() => setOpen(true)} data-testid="correct-invoice-date">
        Correct date
      </Button>
      {open && (
        <CorrectInvoiceDateSheet
          invoice={invoice}
          open={open}
          onOpenChange={setOpen}
          onCreditNoteInstead={onCreditNoteInstead ? () => { setOpen(false); onCreditNoteInstead(); } : undefined}
        />
      )}
    </>
  );
}

function CorrectInvoiceDateSheet({
  invoice, open, onOpenChange, onCreditNoteInstead,
}: { invoice: CorrectableInvoice; open: boolean; onOpenChange: (v: boolean) => void; onCreditNoteInstead?: () => void }) {
  const current = invoice.invoice_date!.slice(0, 10);
  const bounds = correctDateBounds(current, istToday());
  const [date, setDate] = React.useState(current);
  const [reason, setReason] = React.useState("");
  const save = useCorrectInvoiceDate();
  const hint = correctDateHint(current, date, reason, bounds);
  const ready = hint === null;

  async function submit() {
    if (!ready) return;
    try {
      await save.mutateAsync({ invoiceId: invoice.id, newDate: date, reason: reason.trim() });
      toast.success(`Invoice ${invoice.id} is now dated ${fmt(date)}`, {
        description: "The due date moved by the same days. If the customer already has the old copy, send them the corrected PDF.",
      });
      onOpenChange(false);
    } catch {
      /* toast handled in the hook */
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="!p-5 border-b border-hairline">
          <SheetTitle>Correct invoice date</SheetTitle>
          <SheetDescription>
            Invoice <b className="font-mono">{invoice.id}</b> is dated <b>{fmt(current)}</b>. Allowed only while GST for
            both months is not filed, inside the same financial year.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <FormField label="Correct date" htmlFor="correct_invoice_date">
            <Input
              id="correct_invoice_date"
              type="date"
              value={date}
              min={bounds.min}
              max={bounds.max}
              onChange={(e) => setDate(e.target.value)}
            />
            <p className="mt-1 text-2xs text-ink-3">
              Between {fmt(bounds.min)} and {fmt(bounds.max)}.
            </p>
          </FormField>

          <FormField label="Why (kept in the activity log)" htmlFor="correct_invoice_reason">
            <textarea
              id="correct_invoice_reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Money came on 15 Sep — invoice was raised late"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
            />
          </FormField>

          {/* R-2632: the next step when the right date is in another financial year. */}
          <div className="rounded-md border border-hairline px-3 py-2 text-2xs text-ink-2 leading-relaxed space-y-2" data-testid="correct-invoice-date-other-year">
            <p>{otherYearNote(current)}</p>
            {onCreditNoteInstead && (
              <Button type="button" size="sm" variant="outline" icon="receipt" onClick={onCreditNoteInstead}
                data-testid="correct-invoice-date-credit-note">
                Credit note instead
              </Button>
            )}
          </div>

          <div className="rounded-md bg-amber-soft/40 border border-amber/30 px-3 py-2 text-2xs text-amber-ink leading-relaxed">
            The amount, lines and payments stay as they are; the invoice moves to the new month in GSTR-1 and the P&amp;L.
            The due date moves by the same days (an unpaid invoice never gets an earlier due date than it has).
            Once a month&apos;s GST return is filed, a wrong date is fixed with a credit note instead.
          </div>
        </div>

        {hint && (
          <p role="status" data-testid="correct-invoice-date-hint" className="px-5 pt-3 text-2xs text-ink-3">{hint}</p>
        )}
        <SheetFooter className="!p-5 border-t border-hairline">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon="calendar" loading={save.isPending} disabled={!ready} onClick={submit}
            data-testid="correct-invoice-date-save">
            Save date
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
