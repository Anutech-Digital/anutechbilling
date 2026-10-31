"use client";
/**
 * R-2326 — shown instead of the Record payment form on a quote the server would refuse money on
 * (below cost, waiting for the owner). Same words and way forward as Reconcile's block
 * (credit-pay-for-section.tsx, R-2213).
 */
import { Button } from "@/components/ui/button";
import { NEEDS_APPROVAL_LABEL } from "@/lib/quotes/payment-approval";

export function PaymentApprovalNotice({ reason, onOpenApproval }: { reason: string; onOpenApproval: () => void }) {
  return (
    <div role="alert" className="w-full rounded-md border border-amber/60 bg-amber-soft p-2.5 space-y-1.5">
      <p className="text-xs text-amber-ink break-words">
        <b>{NEEDS_APPROVAL_LABEL}.</b> {reason}
      </p>
      <Button size="sm" variant="default" onClick={onOpenApproval}>
        Open approval
      </Button>
    </div>
  );
}
