/**
 * R-377 — "Pay now ₹X" on the ACCEPTED confirmation of the public quote page.
 *
 * Flow test 7 Oct 2026: after accepting, the customer only read "{reseller} will
 * reach out with payment instructions" — no way to pay there and then, so the
 * money arrived days later. The page already has both pay paths (Razorpay via
 * /api/public/quote/[id]/pay and the UPI QR, R-234); this decides whether the
 * accepted screen offers them, and for how much.
 *
 * It computes NO amount. R-1613: the figure is `quoteDueNow` (lib/payments/quote-due-now.ts)
 * — the same function the pay route charges from — so a part-paid ₹708 quote with ₹400
 * received offers ₹308 here, exactly what Razorpay will take.
 *
 * Null (= keep today's "will reach out" text) when:
 *  - the tenant has no payment method (no Razorpay keys AND no UPI QR) — the same
 *    `payOnline` / `upiQr` the review screen's pay buttons are gated on;
 *  - nothing is due now in ₹ (paid, invoiced, a split quote's first instalment paid,
 *    or a foreign quote — Razorpay and UPI both settle rupees).
 * The pay route re-checks every one of these; this only decides what is shown.
 */
import type { BillingCycle } from "@/lib/supabase/database.types";
import type { QuoteDueNow } from "@/lib/payments/quote-due-now";

export interface AcceptedPay {
  /** ₹ collected today — instalment 1 on a split quote, else what is still due. */
  amount: number;
  /** Split-billed: "instalment 1 of N". Null for a single payment. */
  instalment: { count: number; cycle: BillingCycle } | null;
  /** ₹ already received on the quote (0 when nothing yet) — shown beside the figure. */
  alreadyPaid?: number;
}

export function acceptedPayNow(input: {
  due: QuoteDueNow;
  /** Razorpay wired + ₹ quote (page.tsx `payOnline`). */
  payOnline: boolean;
  /** A UPI QR could be built (tenant has a valid VPA). */
  hasUpi: boolean;
}): AcceptedPay | null {
  const { due, payOnline, hasUpi } = input;
  if (!payOnline && !hasUpi) return null;
  if (due.state !== "due" || !due.inr || !(due.amount > 0)) return null;
  return {
    amount: due.amount,
    instalment: due.instalment ? { count: due.instalment.count, cycle: due.instalment.cycle } : null,
    alreadyPaid: due.alreadyPaid,
  };
}
