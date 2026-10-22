"use client";

/**
 * The Refund action of one payment — shared by the Payments table row (≥1280px) and the card
 * list below it, so the action exists at every screen width (R-1682).
 *
 * R-1563: a payment whose quote has a GST invoice goes back only against a credit note.
 * R-1682 (staging T-19, 19 Oct): INV-5F40-27-0079 ₹7,646 paid, cancelled, credit note
 * CN-5F40-27-0001 ₹6,372. The only refund was the WHOLE payment, which needs ₹7,646 of
 * credit note — so the ₹6,372 the company owed could never be paid back. Now, when the open
 * credit-note credit is less than the payment, the flow offers to refund that credit (all or
 * part, never more): refund_credit_note_credit splits the payment and books an RFV for the
 * refunded part (migration 20261019132853).
 *
 * R-1747: a payment on an invoice imported from Zoho Books (payments.quote_id NULL, invoice_id
 * set — R-1739) cannot go through the credit-note route: such an invoice takes no credit note
 * here (its GST was filed in Zoho Books). Its refund is a plain one — refund_payment books the
 * RFV and the invoice's balance opens again by the payment (server rule, fail-closed). The
 * screen says that before booking, and never sends the owner to issue a credit note.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { useConfirm, useAskText } from "@/components/providers/confirm-provider";
import { CancelSubscriptionDialog } from "@/components/features/subscriptions/cancel-subscription-dialog";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { queryKeys } from "@/lib/queries/keys";
import { fetchRefundCredit, useRefundPayment } from "@/lib/queries/payments";
import { cashReceived } from "@/lib/payments/cash-received";
import { partialRefundMax, partialRefundProblem, refundCover } from "@/lib/payments/refund-cover";
import { rupee } from "@/lib/utils";
import type { Payment, Subscription } from "@/lib/supabase/database.types";

export interface CreditRefundResult {
  refund_voucher_no: string;
  amount: number;
  split: boolean;
  kept_amount: number;
  credit_note_credit_left?: number;
  invoice_id?: string | null;
}

type RefundCreditRpc = (
  fn: "refund_credit_note_credit",
  args: { p_payment_id: string; p_amount: number; p_reason: string },
) => PromiseLike<{ data: CreditRefundResult | null; error: { message: string } | null }>;

/** refund_credit_note_credit — part (or all) of the credit-note credit back as cash. */
export function useRefundCreditNoteCredit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: string; amount: number; reason: string }): Promise<CreditRefundResult> => {
      const supabase = createClient();
      /* Newer than the generated types; same narrow cast as set_books_lock. */
      const rpc = supabase.rpc as unknown as RefundCreditRpc;
      const { data, error } = await rpc.call(supabase, "refund_credit_note_credit", {
        p_payment_id: args.id,
        p_amount:     args.amount,
        p_reason:     args.reason,
      });
      if (error) throw new Error(error.message);
      if (!data) throw new Error("The refund was not confirmed — refresh Payments to see whether it was booked.");
      return data;
    },
    onSuccess: (r) => {
      for (const key of [["payments"], ["quotes"], ["subscriptions"], ["invoices"], ["credit-notes"], ["outstanding-receivables"], ["tds_receivable"]]) {
        qc.invalidateQueries({ queryKey: key });
      }
      qc.invalidateQueries({ queryKey: queryKeys.customerCredits() });
      qc.invalidateQueries({ queryKey: queryKeys.aging() });
      toast.success(`Refund booked — voucher ${r.refund_voucher_no}`, {
        description: `${rupee(r.amount)} in the books${r.split ? `; the payment keeps ${rupee(r.kept_amount)} received` : ""}. Send the actual money yourself from Razorpay or the bank.`,
      });
    },
    onError: (err) => toastError(err, { fallback: "Refund not booked — nothing was changed. Try again." }),
  });
}

/**
 * R-1747: the refund of a payment on an imported Zoho invoice — null for every other payment.
 * The payment's own invoice_id decides (not the caller), so the credit-note route is never
 * offered for it.
 */
export function openingInvoiceRefund(
  p: Pick<Payment, "amount" | "quote_id"> & { invoice_id?: string | null },
  invoiceNumber?: string | null,
): { number: string; body: string } | null {
  if (p.quote_id || !p.invoice_id) return null;
  const number = invoiceNumber?.trim() || p.invoice_id;
  return {
    number,
    body:
      `${number} is an opening-balance invoice imported from Zoho Books. No credit note is made here — its GST was filed in Zoho Books.\n\n` +
      `In the books: the payment is marked refunded, an RFV voucher is created, and ${rupee(p.amount)} becomes due again on ${number}. ` +
      "If the customer should no longer owe it, issue the credit note in Zoho Books and ask your accountant to adjust the opening balance.",
  };
}

/** What the screen offers for a refund on an invoiced quote. */
export type RefundRoute =
  | { kind: "full"; cover: number }           // credit notes cover the whole cash
  | { kind: "partial"; max: number; credit: number; gap: number }  // some credit: refund it
  | { kind: "credit_note_first"; need: number; gap: number; credit: number };

export function refundRoute(input: { cash: number; ownOpenCredit: number; creditNoteCredit: number }): RefundRoute {
  const { need, gap } = refundCover(input);
  if (gap <= 0) return { kind: "full", cover: need };
  const max = partialRefundMax({ cash: input.cash, creditNoteCredit: input.creditNoteCredit });
  if (max > 0) return { kind: "partial", max, credit: input.creditNoteCredit, gap };
  return { kind: "credit_note_first", need, gap, credit: input.creditNoteCredit };
}

export function PartialRefundDialog({ open, onOpenChange, payment, invoiceId, max, credit, onDone }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  payment: Pick<Payment, "id" | "amount" | "quote_id">;
  invoiceId: string;
  max: number;
  credit: number;
  onDone?: (reason: string) => void;
}) {
  const refund = useRefundCreditNoteCredit();
  const [amount, setAmount] = React.useState(String(max));
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (!open) return;
    setAmount(String(max));
    setReason("");
  }, [open, max, payment.id]);

  const n = Number(amount);
  const problem = partialRefundProblem(n, max);
  const reasonOk = reason.trim().length >= 5;

  const onConfirm = () => {
    if (problem || !reasonOk) return;
    refund.mutate(
      { id: payment.id, amount: n, reason: reason.trim() },
      { onSuccess: () => { onOpenChange(false); onDone?.(reason.trim()); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="font-serif text-xl text-ink">Refund the credit-note credit</DialogTitle>
        <DialogDescription className="text-sm text-ink-2">
          {rupee(credit)} of credit from credit notes on {invoiceId} is open. Up to {rupee(max)} can go back
          from this {rupee(payment.amount)} payment — the rest of the payment stays received and the invoice stays settled.
        </DialogDescription>
        <div className="mt-4 space-y-3">
          <FormField label={`Amount to refund (up to ${rupee(max)})`} htmlFor="partial-refund-amount" required>
            <Input
              id="partial-refund-amount"
              type="number"
              inputMode="numeric"
              min={1}
              max={max}
              step={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              error={amount !== "" && problem ? problem : undefined}
            />
          </FormField>
          <FormField label="Reason (at least 5 characters, printed on the RFV voucher)" htmlFor="partial-refund-reason" required>
            <Textarea id="partial-refund-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Subscription cancelled — unused part returned" />
          </FormField>
          {!reasonOk && <p className="text-2xs text-ink-3">Write the reason to enable the refund.</p>}
          <p className="text-2xs text-ink-3">
            In the books: an RFV voucher for the amount, the credit-note credit is closed, and the payment is split so the
            refunded part shows as a refund. Send the actual money yourself from Razorpay or the bank.
          </p>
        </div>
        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={refund.isPending}>Not now</Button>
          <Button variant="danger" onClick={onConfirm} disabled={!!problem || !reasonOk} loading={refund.isPending}>
            {problem ? "Book refund" : `Book refund ${rupee(n)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The whole Refund flow for one payment: asks how much credit-note cover there is, then
 * refunds in full, offers the partial credit refund, or says which credit note is missing.
 * Returns the click handler and the dialogs to render next to the button.
 */
export function usePaymentRefundFlow({ payment: p, invoiceId, invoiceNumber, onBlocked }: {
  payment: Payment;
  /** The payment's invoice — lib/payments/payment-customer.ts paymentInvoiceLookup. */
  invoiceId: string | null;
  /** That invoice's number as printed (an imported Zoho invoice's own number). */
  invoiceNumber?: string | null;
  onBlocked?: (message: string) => void;
}): { start: () => Promise<void>; element: React.ReactNode; label: string } {
  const router = useRouter();
  const confirm = useConfirm();
  const askText = useAskText();
  const refund = useRefundPayment({ onBlocked });
  const [partial, setPartial] = React.useState<{ max: number; credit: number } | null>(null);
  /* R-455: after a refund the customer is often leaving — offer to end the subscription. */
  const [cancelAfterRefund, setCancelAfterRefund] = React.useState<{ sub: Subscription; reason: string } | null>(null);

  const offerCancel = async (reason: string) => {
    /* R-1739: a payment on an imported Zoho invoice has no quote, so no subscription. */
    if (!p.quote_id) return;
    const { data } = await createClient()
      .from("subscriptions")
      .select("*")
      .eq("quote_id", p.quote_id)
      .neq("status", "cancelled")
      .limit(1);
    const sub = data?.[0];
    if (!sub) return;
    if (await confirm({
      title: "Is the customer leaving?",
      body: `${sub.customer_name}'s ${sub.plan} subscription is still active — it stays in MRR and renewals` +
        ((sub.outstanding_amount ?? 0) > 0 ? ` and shows ${rupee(sub.outstanding_amount ?? 0)} due` : "") +
        ". Cancel it too?",
      confirmLabel: "Cancel subscription",
      cancelLabel: "Keep it active",
    })) setCancelAfterRefund({ sub, reason });
  };

  /* R-1747: no quote + an invoice = an imported Zoho invoice (the database allows nothing else). */
  const opening = openingInvoiceRefund(p, invoiceNumber);
  const title = `Refund ${rupee(p.amount)} on ${opening ? `invoice ${opening.number}` : p.quote_id}?`;

  const start = async () => {
    let creditNoteCover: number | null = null;
    if (invoiceId && !opening) {
      let have: Awaited<ReturnType<typeof fetchRefundCredit>>;
      try {
        have = await fetchRefundCredit(p.id, invoiceId);
      } catch (e) {
        toastError(e);
        return;
      }
      const route = refundRoute({ cash: cashReceived(p), ...have });
      if (route.kind === "partial") {
        setPartial({ max: route.max, credit: route.credit });
        return;
      }
      if (route.kind === "credit_note_first") {
        if (await confirm({
          title: "Credit note first",
          body:
            `This payment's quote has GST invoice ${invoiceId}. Money on a tax invoice goes back only against a credit note.\n\n` +
            `Refunding ${rupee(cashReceived(p))} needs ${rupee(route.need)} covered by credit notes on ${invoiceId} — none yet.` +
            `\n\nIssue a credit note on it (Invoices → ${invoiceId} → Credit note) for the part the customer should get back, then press Refund here again.`,
          confirmLabel: "Open the invoice",
        })) router.push(`/invoices?q=${encodeURIComponent(invoiceId)}` as never);
        return;
      }
      creditNoteCover = route.cover;
    }
    /* In-app box, not window.prompt — that returned null in the desktop app (R-052). */
    const reason = await askText({
      title,
      body: "The reason is printed on the RFV voucher.",
      label: "Reason (at least 5 characters)",
      confirmLabel: "Next",
    });
    if (reason === null) return;
    if (reason.length < 5) {
      toast.error("Enter a reason of at least 5 characters", { description: "It is printed on the voucher." });
      return;
    }
    if (await confirm({
      title,
      body:
        (opening
          ? opening.body
          : creditNoteCover !== null
          ? `In the books: the payment is marked refunded, an RFV voucher is created, and ${rupee(creditNoteCover)} of the ` +
            `credit made by the credit note on ${invoiceId} is paid out (it can no longer be used on another quote). The invoice stays settled.`
          : "In the books: the payment is marked refunded, an RFV voucher is created, the quote/subscription balance reopens " +
            "and any credit from this payment is closed.") +
        "\n\nYou must send the actual money yourself from Razorpay or the bank — this button does not touch the gateway.",
      confirmLabel: "Book refund",
      danger: true,
    })) refund.mutate({ id: p.id, reason: reason.trim() }, { onSuccess: () => { void offerCancel(reason.trim()); } });
  };

  const element = (
    <>
      {partial && invoiceId && (
        <PartialRefundDialog
          open={!!partial}
          onOpenChange={(v) => { if (!v) setPartial(null); }}
          payment={p}
          invoiceId={invoiceId}
          max={partial.max}
          credit={partial.credit}
          onDone={(reason) => { void offerCancel(reason); }}
        />
      )}
      {cancelAfterRefund && (
        <CancelSubscriptionDialog
          sub={cancelAfterRefund.sub}
          open={!!cancelAfterRefund}
          onOpenChange={(v) => { if (!v) setCancelAfterRefund(null); }}
          clearDueDefault
          defaultReason={cancelAfterRefund.reason}
        />
      )}
    </>
  );

  return { start, element, label: invoiceId && !opening ? "Refund (credit note)" : "Refund payment" };
}

/** The card list's Refund button (below the table breakpoint) — same flow as the table menu. */
export function PaymentRefundButton({ payment, invoiceId, invoiceNumber, className }: {
  payment: Payment;
  invoiceId: string | null;
  invoiceNumber?: string | null;
  className?: string;
}) {
  const flow = usePaymentRefundFlow({ payment, invoiceId, invoiceNumber });
  return (
    <>
      <button type="button" onClick={() => { void flow.start(); }} className={className}>
        {flow.label}
      </button>
      {flow.element}
    </>
  );
}
