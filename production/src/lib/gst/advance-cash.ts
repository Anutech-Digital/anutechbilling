/**
 * R-1565 (18 Oct 2026): the advance rows GSTR-1 Tables 11A / 11B are built from — only the
 * MONEY a customer paid ahead of an invoice, never their own advance credit spent again.
 *
 * An advance is taxed once, when the money comes in (s.13 CGST Act → 11A), and reversed once,
 * when an invoice adjusts it (11B). When the customer's credit pays a later quote,
 * record_desk_payment writes a payment of amount = cash + credit (`credit_applied` = credit).
 * That credit was already money received — and already in 11A — on the payment that created
 * it. Counting the new payment's full amount made 11A tax the same rupees twice; so both the
 * 11A side (payments) and the 11B side (an invoice's adjusted_advances snapshot, whose amount
 * is the settled amount) use the cash part only. Each payment's cash then goes in once and
 * comes out once.
 */
import { cashReceived } from "@/lib/payments/cash-received";
import type { Advance } from "./gstr1";

/** What a payments row needs for 11A. */
export interface AdvancePayment {
  id: string;
  receipt_voucher_no: string | null;
  amount: number;
  credit_applied?: number | null;
  received_at: string;
}

/** Everything about an advance that is not the payment's own (place of supply, rate, adjusted date). */
export type AdvanceContext = Omit<Advance, "paymentId" | "voucherNo" | "receivedDate" | "gross">;

/** 11A side: one Advance per received payment, at the cash that came in. */
export function paymentAdvances<P extends AdvancePayment>(
  pays: readonly P[],
  toIstDate: (at: string) => string,
  contextOf: (p: P) => AdvanceContext,
): Advance[] {
  return pays.map((p) => ({
    paymentId: p.id,
    voucherNo: p.receipt_voucher_no ?? null,
    receivedDate: toIstDate(p.received_at),
    gross: cashReceived(p),
    ...contextOf(p),
  }));
}

/** One entry of invoices.adjusted_advances (compute_advance_adjustment). */
export interface AdvanceSnapshot {
  payment_id: string;
  voucher_no?: string | null;
  amount?: number | null;
  received_at?: string | null;
}

/** 11B side: the cash part of an advance an invoice adjusted. `creditByPayment` holds
 *  credit_applied of those payments (absent = none). */
export function snapshotAdvanceGross(a: AdvanceSnapshot, creditByPayment: ReadonlyMap<string, number>): number {
  return cashReceived({ amount: a.amount ?? 0, credit_applied: creditByPayment.get(a.payment_id) ?? 0 });
}
