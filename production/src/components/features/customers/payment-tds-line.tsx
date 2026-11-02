/**
 * R-2365 — the customer's Transactions tab says what a payment with TDS settled.
 *
 * The row's amount is the gross the payment settles (₹7,753); the bank got less because the
 * customer deducted TDS. The Statement tab and the Overview already say it (R-523); this is
 * the same split under the Transactions amount: "Received ₹7,687 + TDS ₹66 · 194C".
 * Nothing at all when no TDS was deducted. Data: tds_receivable rows (useTdsReceivables).
 */
import * as React from "react";
import { receiptSplit } from "@/lib/accounting/tds-receipt";
import { rupee } from "@/lib/utils";

export interface PaymentTds {
  /** Sum of TDS deducted on this payment (whole rupees). */
  tds: number;
  /** The TDS section(s), e.g. "194C" — "" when the rows carry none. */
  section: string;
}

/** TDS + section per payment id. One payment may carry more than one TDS row. */
export function tdsInfoByPayment(
  rows: readonly { payment_id: string | null; tds_amount: number | null; section?: string | null }[],
): Record<string, PaymentTds> {
  const out: Record<string, PaymentTds> = {};
  const sections: Record<string, string[]> = {};
  for (const r of rows) {
    if (!r.payment_id) continue;
    const cur = (out[r.payment_id] ??= { tds: 0, section: "" });
    cur.tds += Math.max(0, Math.round(r.tds_amount ?? 0));
    const s = (r.section ?? "").trim();
    const list = (sections[r.payment_id] ??= []);
    if (s && !list.includes(s)) list.push(s);
    cur.section = list.join(", ");
  }
  return out;
}

/** "Received ₹7,687 + TDS ₹66"; null when no TDS was deducted. */
export function paymentTdsText(gross: number, tds: PaymentTds | null | undefined): string | null {
  const s = receiptSplit(gross, tds?.tds);
  if (s.tds <= 0) return null;
  return `Received ${rupee(s.received)} + TDS ${rupee(s.tds)}`;
}

/** The small line under a payment row's amount; renders nothing without TDS. */
export function PaymentTdsLine({ amount, tds }: { amount: number; tds: PaymentTds | null | undefined }) {
  const text = paymentTdsText(amount, tds);
  if (!text) return null;
  return (
    <span className="text-3xs text-ink-3 tabular-nums whitespace-nowrap" data-testid="payment-tds-line">
      {text}
      {tds?.section ? <span className="font-mono">{` · ${tds.section}`}</span> : null}
    </span>
  );
}
