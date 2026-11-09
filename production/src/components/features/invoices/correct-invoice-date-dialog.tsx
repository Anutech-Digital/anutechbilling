/**
 * R-2173 (9 Nov 2026) — "Correct date" on an issued invoice, while its GST month is not filed yet.
 *
 * Under CGST s.34 an issued invoice is fixed with a credit note — but until the month's GST return is
 * filed, a wrong DATE can still be corrected on the same document (e.g. an invoice raised late and dated
 * the day it was raised instead of the day the money came). The database decides everything through
 * correct_invoice_date() (migration 20261109132649): owner or accountant only; neither the old nor the new
 * month GST-filed (R-2621's one rule: GST returns filed up to / books lock / GSTR-1 marked filed); same
 * financial year (another year needs a new number — R-2632); no IRN, no Zoho-imported sale, no foreign
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
import { istToday } from "@/lib/dates/ist";
import { canDeleteMoney } from "@/lib/auth/roles";
import { toastError } from "@/lib/errors/toast-error";

export type CorrectableInvoice = {
  id: string;
  invoice_date: string | null;
  status: string;
  document_kind?: string | null;
  gst_irn?: string | null;
  zoho_invoice_id?: string | null;
  currency?: string | null;
  fx_rate?: number | null;
};

/** Who sees the button: owner/accountant, on an issued INR sale of ours with no IRN. The server checks it all again. */
export function canCorrectInvoiceDate(invoice: CorrectableInvoice, role: string | null | undefined): boolean {
  if (!role || !canDeleteMoney(role)) return false; // unknown role (still loading) → hidden, unlike canDeleteMoney
  if (!invoice.invoice_date || invoice.status === "draft" || invoice.status === "void") return false;
  if (invoice.document_kind === "opening_invoice") return false;
  if (invoice.gst_irn && invoice.gst_irn.trim()) return false;
  if (invoice.zoho_invoice_id) return false;
  if (invoice.fx_rate != null || (invoice.currency && invoice.currency !== "INR")) return false;
  return true;
}

/** The date picker's range: the invoice's own financial year (1 Apr – 31 Mar), never after today (IST). */
export function correctDateBounds(invoiceDate: string, todayIst: string): { min: string; max: string } {
  const y = Number(invoiceDate.slice(0, 4));
  const m = Number(invoiceDate.slice(5, 7));
  const fyStart = m >= 4 ? y : y - 1;
  const min = `${fyStart}-04-01`;
  const fyEnd = `${fyStart + 1}-03-31`;
  return { min, max: fyEnd < todayIst ? fyEnd : todayIst };
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["activity-log"] });
    },
    onError: (e) => toastError(e, { fallback: "Could not correct the invoice date" }),
  });
}

const fmt = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function CorrectInvoiceDateButton({ invoice, role }: { invoice: CorrectableInvoice; role: string | null | undefined }) {
  const [open, setOpen] = React.useState(false);
  if (!canCorrectInvoiceDate(invoice, role)) return null;
  return (
    <>
      <Button size="sm" variant="outline" icon="calendar" onClick={() => setOpen(true)} data-testid="correct-invoice-date">
        Correct date
      </Button>
      {open && <CorrectInvoiceDateSheet invoice={invoice} open={open} onOpenChange={setOpen} />}
    </>
  );
}

function CorrectInvoiceDateSheet({
  invoice, open, onOpenChange,
}: { invoice: CorrectableInvoice; open: boolean; onOpenChange: (v: boolean) => void }) {
  const current = invoice.invoice_date!.slice(0, 10);
  const bounds = correctDateBounds(current, istToday());
  const [date, setDate] = React.useState(current);
  const [reason, setReason] = React.useState("");
  const save = useCorrectInvoiceDate();
  const ready = !!date && date !== current && date >= bounds.min && date <= bounds.max && reason.trim().length >= 5;

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
              Between {fmt(bounds.min)} and {fmt(bounds.max)}. The due date moves by the same number of days.
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

          <div className="rounded-md bg-amber-soft/40 border border-amber/30 px-3 py-2 text-2xs text-amber-ink leading-relaxed">
            The amount, lines and payments stay as they are; the invoice moves to the new month in GSTR-1 and the P&amp;L.
            Once a month&apos;s GST return is filed, a wrong date is fixed with a credit note instead.
          </div>
        </div>

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
