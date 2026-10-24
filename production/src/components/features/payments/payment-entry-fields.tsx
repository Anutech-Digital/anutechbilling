/**
 * R-1730 — one way to record a payment (owner audit 21 Oct, UI rule 6: "every entry point to a
 * task opens the same dialog with the same defaults").
 *
 * Two sheets record money received, because their money paths differ (merging them was judged
 * too risky a day before live):
 *   · RecordPaymentDialog (components/features/quotes/record-payment-dialog.tsx) — ONE quote /
 *     invoice, record_desk_payment. Opened by: the quote page "Record payment", Payments →
 *     Subscription dues row "Record payment" (payments/record-quote-payment.tsx), the seat-quote
 *     rows and "Action needed" on /payments, invoice pages, Subscriptions.
 *   · MultiInvoicePaymentDialog (./multi-invoice-payment-dialog.tsx) — one transfer spread over a
 *     customer's open invoices, record_multi_invoice_payment. Opened by: Payments "Record
 *     payment — multiple invoices", the "Imported from Zoho" card's row "Record payment"
 *     (invoices/opening-invoice-dues-card.tsx) and the customer page.
 * Both take their field names, the default method, the "Received in" field and its pre-selected
 * account from THIS file, and both open with the amount still due already filled in (editable).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useBankAccounts, useRecentDepositTags } from "@/lib/queries/bank";
import {
  depositAccountLabel,
  depositAccounts,
  usualDepositAccountId,
  type DepositAccount,
  type PaymentMethod,
} from "@/lib/payments/deposit-accounts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** The same words in every Record payment sheet. */
export const PAYMENT_FIELD_LABELS = {
  amount: "Amount received (₹ — whole rupees)",
  method: "Payment method",
  receivedIn: "Received in",
  receivedOn: "Received on",
  notes: "Notes (optional)",
  submit: "Confirm payment",
} as const;

/** The reference field's label for a method. R-1444: optional for every method (Pardeep,
 *  14 Oct) — a blank one is saved as "<Method> <date> <time>" (blankReference). */
export function referenceLabel(method: string): string {
  return method === "upi" ? "UPI Transaction Ref ID (Optional)"
    : method === "razorpay" ? "Razorpay Payment ID (Optional)"
    : method === "bank_transfer" ? "Bank UTR / Transaction Ref No. (Optional)"
    : method === "cheque" ? "Cheque No. & Issuing Bank (Optional)"
    : method === "cash" ? "Cash Voucher / Receipt Ref (Optional)"
    : "Transaction Reference (Optional)";
}

export function referencePlaceholder(method: string): string {
  return method === "upi" ? "e.g. 402312345678 (12-digit UTR)"
    : method === "razorpay" ? "e.g. pay_P1a2B3c4D5e6F7"
    : method === "bank_transfer" ? "e.g. N281241234567890"
    : method === "cheque" ? "e.g. Cheque #004521 - SBI Bank"
    : "e.g. Cash Receipt #CR-102";
}

export function referenceHint(method: string): string {
  return method === "upi" ? "12-digit UTR/UPI reference from GPay, PhonePe, Paytm or your bank QR. Leave blank if you do not have it."
    : method === "razorpay" ? "Unique Razorpay payment ID starting with pay_. Leave blank if you do not have it."
    : method === "bank_transfer" ? "Bank UTR or NEFT/RTGS reference number from bank statement. Leave blank if you do not have it."
    : method === "cheque" ? "6-digit cheque number and the customer's bank name. Leave blank if you do not have it."
    : method === "cash" ? "Optional. Leave blank and it is saved as Cash + date and time."
    : "Optional internal voucher or receipt reference.";
}

/**
 * The company's receiving accounts and the one "Received in" should open on for this method
 * (usualDepositAccountId: the only one, else the usual one, else "" = Not sure yet).
 */
export function useReceivedInDefault(open: boolean, method: PaymentMethod | string) {
  const { data: allBankAccounts, isLoading } = useBankAccounts();
  const { data: recentTags } = useRecentDepositTags(open);
  const accounts = React.useMemo(() => depositAccounts(allBankAccounts), [allBankAccounts]);
  const defaultId = React.useMemo(
    () => usualDepositAccountId(accounts, method, recentTags ?? []),
    [accounts, method, recentTags],
  );
  return { accounts, loading: isLoading, defaultId };
}

/** "Received in" — the same field in every sheet. "" means Not sure yet. */
export function ReceivedInField({
  id,
  accounts,
  loading,
  value,
  onChange,
}: {
  id: string;
  accounts: ReadonlyArray<DepositAccount>;
  loading: boolean;
  value: string;
  onChange: (accountId: string) => void;
}) {
  if (accounts.length === 0) {
    return (
      <p id={id} className="text-xs text-ink-3">
        {loading ? "Loading your accounts…" : (
          <>
            No bank account added yet.{" "}
            <Link href="/accounting/banking" className="underline text-ink">Add a bank account</Link>{" "}
            to tag where money lands. The payment saves without it.
          </>
        )}
      </p>
    );
  }
  return (
    <>
      <Select value={value || "none"} onValueChange={(v) => onChange(v === "none" ? "" : v)}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose the account" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Not sure yet</SelectItem>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>{depositAccountLabel(a)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-2xs text-ink-3 mt-1">
        Your account that got this money. Helps match it with the bank statement.
      </p>
    </>
  );
}
