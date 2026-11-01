/**
 * R-2322 — Banking → Reconcile → a money-out line → "Customer refund".
 *
 * Pick the customer → pick what is refunded (the open credit-note credit on an invoice, or an
 * unused advance — only ones with a refundable balance, from customer_refundable_items) → the
 * reason (printed on the Refund Voucher) → Save. The bank line is the amount; the server books it
 * through the existing refund (refund_credit_note_credit / refund_payment) and matches the line
 * once (reconcile_bank_debit_as_customer_refund). Undo = Un-reconcile.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee } from "@/lib/utils";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { customerOptions } from "@/lib/banking/credit-pay-for";
import {
  defaultRefundReason, guessRefundCustomer, pickDefaultRefundItem, refundItemLabel, refundItemProblem, refundReasonProblem,
} from "@/lib/banking/customer-refund";
import { useBookCustomerRefund, useCustomerRefundables } from "@/lib/banking/customer-refund-query";
import { useFooterSaveReport, type FooterSave } from "./reconcile-who-tiles";

const selectCls =
  "w-full rounded-md border border-hairline bg-paper px-2.5 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/50";

export function CustomerRefundSection({ transaction, customers, onDone, onFooterSave }: {
  transaction: BankTransactionRow;
  customers: ReadonlyArray<{ id: string; name: string }>;
  onDone: () => void;
  /** R-2348: the Reconcile sheet draws the Save in its sticky footer. Given → no inline button;
   *  the footer gets the same label, disabled rule and save. */
  onFooterSave?: (save: FooterSave | null) => void;
}) {
  const amount = transaction.debit ?? 0;
  const guess = React.useMemo(() => guessRefundCustomer(transaction.description, customers), [transaction.description, customers]);
  const [customerId, setCustomerId] = React.useState<string>("");
  const [paymentId, setPaymentId] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  React.useEffect(() => { setCustomerId(guess ?? ""); setPaymentId(null); setReason(""); }, [transaction.id, guess]);

  /* R-2336: ask for this line's date — money that came in after it is shown disabled with the reason. */
  const itemsQ = useCustomerRefundables(customerId || null, transaction.txn_date ?? null);
  const items = React.useMemo(() => itemsQ.data ?? [], [itemsQ.data]);
  React.useEffect(() => { setPaymentId(pickDefaultRefundItem(items, amount)); }, [items, amount]);
  const book = useBookCustomerRefund();

  const choices = React.useMemo(() => customerOptions(customers), [customers]);
  const picked = items.find((i) => i.payment_id === paymentId) ?? null;
  /* The reason starts as what is refunded; the operator may edit it. */
  React.useEffect(() => { setReason(picked ? defaultRefundReason(picked) : ""); }, [picked]);
  const blocked = !customerId ? "Pick the customer the money went to."
    : !picked ? "Pick what this refund pays back."
    : refundItemProblem(picked, amount) ?? refundReasonProblem(reason);

  async function save() {
    if (!picked || blocked) return;
    try {
      await book.mutateAsync({ transactionId: transaction.id, paymentId: picked.payment_id, reason });
      onDone();
    } catch { /* the hook shows the error */ }
  }

  /* R-2348: same label, same rule (blocked), same save() — in the footer when the sheet asks. */
  const saveLabel = `Book ${rupee(amount)} as customer refund`;
  useFooterSaveReport(onFooterSave, { label: saveLabel, onSave: () => { void save(); }, disabled: Boolean(blocked), loading: book.isPending });

  return (
    <div className="rounded-md border border-hairline p-3 space-y-3" data-testid="customer-refund-section">
      <p className="text-xs text-ink-3 leading-relaxed">
        Money paid back to a customer. It lowers what you hold for them (their credit-note credit or unused advance)
        by {rupee(amount)} and issues a Refund Voucher. Undo with Un-reconcile.
      </p>

      <select
        value={customerId}
        onChange={(e) => { setCustomerId(e.target.value); setPaymentId(null); }}
        aria-label="Customer refunded"
        className={selectCls}
      >
        <option value="" disabled>Which customer got the money? Select…</option>
        {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
      {guess && customerId === guess && <p className="text-xs text-ink-3">Guessed from the bank narration — change it if wrong.</p>}

      {customerId && (itemsQ.isLoading ? <Skeleton className="h-10 w-full" /> : items.length === 0 ? (
        <p className="text-xs text-ink-3">
          This customer has no credit-note credit or unused advance to refund. Issue the credit note first
          (Invoices → the invoice → Credit note), then come back to this line.
        </p>
      ) : (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-semibold text-ink-2 mb-1">What does this refund pay back?</legend>
          {items.map((i) => {
            const problem = refundItemProblem(i, amount);
            return (
              <label key={i.payment_id}
                className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm ${paymentId === i.payment_id ? "border-amber bg-amber-soft/40" : "border-hairline"} ${problem ? "opacity-60" : "cursor-pointer"}`}>
                <input type="radio" name={`refund-item-${transaction.id}`} className="mt-1"
                  checked={paymentId === i.payment_id} disabled={Boolean(problem)}
                  onChange={() => setPaymentId(i.payment_id)} />
                <span className="min-w-0">
                  <span className="block text-ink">{refundItemLabel(i)}</span>
                  {problem && <span className="block text-xs text-ink-3">{problem}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}

      {picked && (
        <Input aria-label="Refund reason" placeholder="Why the money went back — printed on the refund voucher"
          value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      )}

      {blocked && customerId && items.length > 0 && <p className="text-xs text-ink-3">{blocked}</p>}
      {!onFooterSave && (
        <Button size="sm" variant="primary" icon="check" loading={book.isPending} disabled={Boolean(blocked)} onClick={save}>
          {saveLabel}
        </Button>
      )}
    </div>
  );
}
