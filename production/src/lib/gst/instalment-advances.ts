/**
 * R-1611 (18 Oct 2026): GSTR-1 11A / 11B for a split-billed (instalment) subscription.
 *
 * A quarterly / monthly subscription's quote never gets an invoice of its own:
 * raise_subscription_billing leaves invoices.quote_id NULL and links each instalment invoice
 * through subscription_billings.invoice_id. Every payment on it is recorded on that quote
 * (record_instalment_payment, R-1564) and applied to the instalments' paid_amount. The GST
 * report took an advance's "adjusted on" date only from quotes.invoice_id — NULL here — so
 * money paid on an already-raised instalment invoice stayed an unadjusted advance in 11A,
 * taxed again on top of the invoice's own output tax.
 *
 * The link between one payment and the instalment(s) it paid is not stored; only the totals
 * are (Σ quote payments = received, Σ instalment paid_amount = applied — the same two sums
 * raise_subscription_billing and record_instalment_payment use). So the payments are matched
 * to the instalments oldest-first: the quote's received payments (by received_at) fill its
 * raised instalment invoices' paid_amount (term order). The part of a payment an instalment
 * took is adjusted on that invoice's date (not an advance if the invoice came first; 11A then
 * 11B if the invoice came later); whatever no instalment took is still an advance.
 *
 * Amounts: a payment's settled amount (payments.amount) is what fills paid_amount; the GST
 * gross of each part is its share of the CASH (amount − credit_applied, R-1565), so advance
 * credit inside a payment is never taxed twice.
 */
import { cashReceived } from "@/lib/payments/cash-received";
import type { Advance } from "./gstr1";
import type { AdvanceContext, AdvancePayment } from "./advance-cash";

/** A raised instalment invoice of the quote, with what has been applied to it (paid_amount). */
export interface InstalmentInvoice { id: string; invoiceDate: string; applied: number }

/** Part of one payment: its cash gross, and the invoice (date) that adjusted it, if any. */
export interface AdvancePortion { gross: number; adjustedOn: string | null; invoiceId: string | null }

/**
 * Payments and instalments of ONE quote → each payment's parts. `instalments` must be in term
 * order (oldest first); payments are sorted by received_at here. Only payments with a part
 * come back; a quote with no raised instalment gives an empty map (all advance as before).
 */
export function allocateInstalmentPayments<P extends AdvancePayment>(
  pays: readonly P[],
  instalments: readonly InstalmentInvoice[],
): Map<string, AdvancePortion[]> {
  const out = new Map<string, AdvancePortion[]>();
  if (!instalments.length) return out;
  const room = instalments.map((i) => Math.max(0, i.applied ?? 0));
  let k = 0;
  const ordered = [...pays].sort((a, b) => a.received_at.localeCompare(b.received_at) || a.id.localeCompare(b.id));
  for (const p of ordered) {
    const amount = Math.max(0, p.amount ?? 0);
    const cash = cashReceived(p);
    const parts: { settled: number; adjustedOn: string | null; invoiceId: string | null }[] = [];
    let left = amount;
    while (left > 0 && k < instalments.length) {
      if (room[k] <= 0) { k++; continue; }
      const take = Math.min(left, room[k]);
      parts.push({ settled: take, adjustedOn: instalments[k].invoiceDate, invoiceId: instalments[k].id });
      room[k] -= take;
      left -= take;
    }
    if (left > 0) parts.push({ settled: left, adjustedOn: null, invoiceId: null });
    if (!parts.length) continue;
    // Cash share of each part; the last part takes the rounding remainder so they sum to cash.
    let given = 0;
    out.set(p.id, parts.map((x, idx) => {
      const gross = idx === parts.length - 1 ? cash - given : (amount > 0 ? Math.round((cash * x.settled) / amount) : 0);
      given += gross;
      return { gross, adjustedOn: x.adjustedOn, invoiceId: x.invoiceId };
    }));
  }
  return out;
}

/**
 * 11A side, like paymentAdvances (advance-cash.ts), but a payment with parts gives one Advance
 * per part, each with its own adjusted date. Without parts: one Advance at the cash received.
 */
export function splitPaymentAdvances<P extends AdvancePayment>(
  pays: readonly P[],
  toIstDate: (at: string) => string,
  contextOf: (p: P) => AdvanceContext,
  portionsOf: (p: P) => readonly AdvancePortion[] | undefined,
): Advance[] {
  return pays.flatMap((p) => {
    const base = { paymentId: p.id, voucherNo: p.receipt_voucher_no ?? null, receivedDate: toIstDate(p.received_at) };
    const ctx = contextOf(p);
    const parts = portionsOf(p);
    if (!parts?.length) return [{ ...base, gross: cashReceived(p), ...ctx }];
    return parts.map((x) => ({ ...base, ...ctx, gross: x.gross, adjustedOn: x.adjustedOn }));
  });
}
