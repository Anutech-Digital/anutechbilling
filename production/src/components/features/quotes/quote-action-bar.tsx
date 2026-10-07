/**
 * QuoteActionBar — the money-lifecycle actions for a quote, usable anywhere a
 * quote is surfaced (quote hub, lead drawer, pipeline). It mirrors the quote
 * page's status-aware action bar so a rep never has to leave the drawer to move
 * a quote forward — "khali record payment se kaam nahi chalega".
 *
 *   sent / viewed (unpaid)   → Record payment · Mark accepted · Mark rejected
 *   accepted + awaiting pay  → Record payment
 *   partial / received / …   → a single button that opens the full quote hub
 *                              (where payment history / invoice / resend live)
 *
 * MONEY-SAFETY:
 *  - The inline "Record payment" path derives `alreadyReceived` from
 *    quote.payment_amount, and the total from the same frozen formula the quote
 *    hub uses (quotes/[id]/page.tsx). Anything with a partial/received history
 *    routes to the hub, which loads the authoritative payment_history.
 *  - "Mark accepted" / "Mark rejected" never touch money math — accept only
 *    converts the lead → customer (via the mark-accepted API) so the record
 *    exists before money lands; the subscription is still created later by
 *    record_payment when the payment is recorded.
 */
"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import type { Quote } from "@/lib/supabase/database.types";
import { acceptedToast } from "@/lib/quotes/accepted-toast";

interface QuoteActionBarProps {
  quote: Quote;
  /** Open the full quote hub. Parent decides how (e.g. close drawer + router.push). */
  onOpenFullQuote: () => void;
  /** Called after accept/reject so the parent can refetch its own lists if needed. */
  onChanged?: () => void;
  className?: string;
}

export function QuoteActionBar({ quote, onOpenFullQuote, onChanged, className }: QuoteActionBarProps) {
  const qc = useQueryClient();
  const [paymentOpen, setPaymentOpen] = React.useState(false);

  // Total — identical formula to the quote hub. `amount` is the frozen stored
  // total; fall back to a recompute only for older rows that predate it.
  const subtotal = quote.subtotal ?? 0;
  const discount = Math.round(subtotal * ((quote.discount_pct ?? 0) / 100));
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * ((quote.tax_rate ?? 0) / 100));
  const total = quote.amount ?? taxable + tax;

  const alreadyReceived = quote.payment_amount ?? 0;
  const isProspect = !!quote.lead_id && !quote.customer_id;

  /** Mark accepted (no payment yet) — converts the lead → customer immediately. */
  const markAccepted = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/quotes/${quote.id}/mark-accepted`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not mark as accepted");
      return json as { customerId: string; convertedNow: boolean; matchedExisting?: boolean; customerName?: string | null };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success(acceptedToast(data));
      onChanged?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const markRejected = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const { error } = await supabase.from("quotes").update({ status: "rejected" }).eq("id", quote.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast("Quote marked as rejected");
      onChanged?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const ps = quote.payment_status;
  const st = quote.status;
  // "Nothing received yet" — the app defaults payment_status to "none" (not
  // null) on a fresh quote; "awaiting" is set once accepted. Either way no money
  // has landed, so the inline Record-payment path is safe (alreadyReceived = 0).
  // partial / received / invoiced deliberately fall through to the hub, which
  // loads the authoritative payment history.
  const nothingReceivedYet = !ps || ps === "none" || ps === "awaiting";
  const unpaidSent = (st === "sent" || st === "viewed") && nothingReceivedYet;
  const acceptedAwaiting = st === "accepted" && nothingReceivedYet;

  // Non-inline states → a single button into the hub, labelled by state.
  const hub = (() => {
    if (ps === "received") return { label: "Issue GST invoice", icon: "receipt" };
    /* Labelled for where it GOES, not for what happened. This said "View invoice" while
       opening the quote hub — and the hub is the right destination here for the reason
       stated above (it loads the authoritative payment history), so the label is what was
       wrong, not the route. The hub's own banner now deep-links to the invoice itself, so
       nothing is lost by naming this honestly. */
    if (ps === "invoiced") return { label: "Open quote · invoiced", icon: "receipt" };
    if (ps === "partial") return { label: "Record remaining payment", icon: "rupee" };
    if (st === "draft") return { label: "Send draft quote", icon: "send" };
    if (st === "rejected") return { label: "Open quote · duplicate & re-send", icon: "file" };
    return { label: "Open full quote", icon: "file" };
  })();

  return (
    <div className={cn("space-y-2", className)}>
      {unpaidSent || acceptedAwaiting ? (
        <>
          <Button
            variant="primary"
            icon="rupee"
            className="w-full justify-center"
            onClick={() => setPaymentOpen(true)}
          >
            Record payment now
          </Button>

          {unpaidSent && (
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="primary"
                icon="check_circle"
                className="justify-center"
                loading={markAccepted.isPending}
                onClick={() => markAccepted.mutate()}
                title="Convert the lead into a customer now — payment can be recorded later"
              >
                Mark accepted
              </Button>
              <Button
                variant="default"
                className="justify-center"
                loading={markRejected.isPending}
                onClick={() => markRejected.mutate()}
              >
                Mark rejected
              </Button>
            </div>
          )}

          <button
            type="button"
            onClick={onOpenFullQuote}
            className="w-full inline-flex items-center justify-center gap-1 text-2xs font-medium text-ink-3 hover:text-ink transition-colors"
          >
            Open full quote — preview, resend, PDF, invoice
            <Icon name="arrow_right" size={11} />
          </button>
        </>
      ) : (
        <Button
          variant="primary"
          icon={hub.icon}
          className="w-full justify-center"
          onClick={onOpenFullQuote}
        >
          {hub.label}
        </Button>
      )}

      <RecordPaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        quoteId={quote.id}
        customerName={quote.customer_name}
        expectedAmount={total}
        alreadyReceived={alreadyReceived}
        isProspect={isProspect}
        invoiceId={quote.invoice_id}
        customerId={quote.customer_id}
      />
    </div>
  );
}
