/**
 * R-045 slice 2 — Razorpay's fee on a payment, on screen, and the button that books old ones.
 *
 * `FeeNetLine` sits under a payment's amount (Payments list, quote payment history) when the
 * webhook saved a fee: "Fee ₹28 · Net ₹1,152". Net is what reached the bank — the number a
 * bank statement line shows. No fee on record (manual payment, or before R-045) → nothing,
 * never a guessed zero.
 *
 * `BookGatewayFeesButton` books the fee expense for payments captured before the webhook
 * did it by itself. Idempotent on the server; shown only to roles that may book expenses.
 */
"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { rupee, cn } from "@/lib/utils";
import { paymentFeeView, type PaymentFeeFields } from "@/lib/razorpay/fee-expense";

export function FeeNetLine({ payment, className }: { payment: PaymentFeeFields; className?: string }) {
  const v = paymentFeeView(payment);
  if (!v) return null;
  return (
    <div
      className={cn("text-3xs text-ink-3 tabular-nums whitespace-nowrap", className)}
      title={`Razorpay kept ${rupee(v.fee)} (incl. GST ${rupee(v.gst)}); ${rupee(v.net)} reached the bank.`}
    >
      Fee {rupee(v.fee)} · Net <span className="text-ink-2 font-medium">{rupee(v.net)}</span>
    </div>
  );
}

const BOOKING_ROLES = new Set(["owner", "manager", "billing", "accountant"]);

export function BookGatewayFeesButton({
  payments,
  role,
}: {
  payments: readonly PaymentFeeFields[] | undefined;
  role: string | null | undefined;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const hasFees = (payments ?? []).some((p) => (p.gateway_fee ?? 0) > 0);
  if (!hasFees || !role || !BOOKING_ROLES.has(role)) return null;

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/payments/gateway-fees", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; error?: string; booked?: number; failed?: number; remaining?: number;
      };
      if (!res.ok || !body.ok) {
        toast.error("Razorpay fees not booked", { description: body.error ?? "Try again in a minute." });
        return;
      }
      const booked = body.booked ?? 0;
      if (booked === 0 && !body.failed) {
        toast.success("Razorpay fees are already booked", { description: "Every fee is in Expenses under Bank Charges." });
      } else {
        toast.success(`Booked ${booked} Razorpay fee${booked === 1 ? "" : "s"}`, {
          description:
            (body.failed ? `${body.failed} could not be booked — try again. ` : "") +
            (body.remaining ? `${body.remaining} more — press again. ` : "") +
            "See Expenses → Bank Charges.",
        });
      }
      void qc.invalidateQueries({ queryKey: ["expenses"] });
    } catch {
      toast.error("Razorpay fees not booked", { description: "Network error — try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      icon="receipt"
      onClick={run}
      disabled={busy}
      title="Book the fee Razorpay kept on each payment as a Bank Charges expense (GST as input credit). Safe to press again."
    >
      {busy ? "Booking…" : "Book Razorpay fees"}
    </Button>
  );
}
