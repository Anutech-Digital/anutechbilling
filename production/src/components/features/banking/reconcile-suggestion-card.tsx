/**
 * R-2007 — the Suggestion card at the top of the Reconcile sheet.
 *
 * `useReconcileSuggestion` reads what the matching section reads (the same queries, so nothing is
 * fetched twice), asks lib/banking/reconcile-suggestion.ts for ONE confident answer, and books it
 * through the SAME save path that section uses — no new RPC:
 *   project instalments → useAllocateProjectReceipt (allocate_project_receipt[_with_tds]),
 *                         payload from projectReceiptPayload, as ProjectPaymentSection;
 *   open quote/invoice  → usePayItemFromBankCredit (reconcile_bank_credit_to_item), as CreditPayForSection;
 *   vendor bill         → usePayVendorFromBankDebit (reconcile_bank_debit_to_vendor), as DebitPayForSection.
 * Nothing is booked until the owner presses "Looks right — reconcile".
 *
 * Accept / Change counts go to the activity log (log_activity — the existing fire-and-forget
 * writer; owners and managers read it on /activity): action "reconcile_suggestion_accept" /
 * "reconcile_suggestion_change", entity "bank_transaction".
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useOpenProjects, useAllocateProjectReceipt } from "@/lib/queries/project-receipts";
import { useBankCreditOpenItems, usePayItemFromBankCredit } from "@/lib/queries/bank-credit-pay-for";
import { useVendorOpenItems, usePayVendorFromBankDebit, useVendorNarrationAliases } from "@/lib/queries/bank-debit-pay-for";
import { useVendors } from "@/lib/queries/vendors";
import { useTxnCategoryRules } from "@/lib/queries/txn-category-rules";
import { matchCreditToInvoices, type OpenInvoice } from "@/lib/banking/invoice-credit-match";
import { amountCheck, guessCustomer, tdsRateToRecord, type CustomerLite } from "@/lib/banking/credit-pay-for";
import { guessVendor, type VendorLite } from "@/lib/banking/debit-pay-for";
import { projectReceiptPayload } from "@/lib/banking/project-receipt-allocation";
import { suggestMoneyIn, suggestMoneyOut, type Suggestion } from "@/lib/banking/reconcile-suggestion";

export type { Suggestion } from "@/lib/banking/reconcile-suggestion";

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }> };

/** Accept / Change count — never throws, never blocks the booking. */
export function logSuggestion(outcome: "accept" | "change", txnId: string, s: Suggestion): void {
  try {
    void (createClient() as unknown as RpcClient)
      .rpc("log_activity", {
        p_action: `reconcile_suggestion_${outcome}`,
        p_entity: "bank_transaction",
        p_entity_id: txnId,
        p_label: s.title.slice(0, 120),
      })
      .then(undefined, () => undefined);
  } catch { /* the count is a nice-to-have */ }
}

export function useReconcileSuggestion(input: {
  transaction: BankTransactionRow | null;
  customers: readonly CustomerLite[];
  openInvoices: readonly OpenInvoice[] | undefined;
}) {
  const { transaction: txn, customers, openInvoices } = input;
  const credit = txn?.credit ?? 0;
  const debit = txn?.debit ?? 0;

  /* Money in: the customer guessCustomer names (as CreditPayForSection does). */
  const customerGuess = React.useMemo(() => {
    if (!txn || credit <= 0) return null;
    const ms = matchCreditToInvoices(
      { amount: credit, txnDate: txn.txn_date, description: txn.description, reference: txn.reference },
      openInvoices ?? [],
    );
    return guessCustomer(txn, customers, ms);
  }, [txn, credit, customers, openInvoices]);
  const { data: projects } = useOpenProjects(Boolean(customerGuess));
  const { data: creditItems } = useBankCreditOpenItems(customerGuess?.customerId ?? null);

  /* Money out: the vendor guessVendor names (as DebitPayForSection does). */
  const { data: vendorRows } = useVendors();
  const { data: rules } = useTxnCategoryRules();
  const { data: aliases } = useVendorNarrationAliases();
  const vendors = React.useMemo(() => (vendorRows ?? []) as unknown as VendorLite[], [vendorRows]);
  const vendorGuess = React.useMemo(
    () => (txn && debit > 0 ? guessVendor(txn, vendors, { rules: rules ?? [], aliases: aliases ?? [] }) : null),
    [txn, debit, vendors, rules, aliases],
  );
  const { data: vendorItems } = useVendorOpenItems(vendorGuess?.vendorId ?? null);

  const suggestion = React.useMemo((): Suggestion | null => {
    if (!txn) return null;
    if (credit > 0) {
      const c = customerGuess ? customers.find((x) => x.id === customerGuess.customerId) ?? null : null;
      return suggestMoneyIn({
        bank: credit, customer: c, guessReason: customerGuess?.reason ?? "",
        projects: projects ?? null, items: creditItems ?? null,
      });
    }
    const v = vendorGuess ? vendors.find((x) => x.id === vendorGuess.vendorId) ?? null : null;
    return suggestMoneyOut({ debit, vendor: v, guessReason: vendorGuess?.reason ?? "", items: vendorItems ?? null });
  }, [txn, credit, debit, customerGuess, customers, projects, creditItems, vendorGuess, vendors, vendorItems]);

  const allocate = useAllocateProjectReceipt();
  const payItem = usePayItemFromBankCredit();
  const payVendor = usePayVendorFromBankDebit();
  const accepting = allocate.isPending || payItem.isPending || payVendor.isPending;

  /** Books the suggestion through its section's own save. Resolves true when saved. */
  const accept = React.useCallback(async (): Promise<boolean> => {
    if (!txn || !suggestion) return false;
    const s = suggestion;
    try {
      if (s.kind === "project") {
        await allocate.mutateAsync(projectReceiptPayload({
          bankTxnId: txn.id,
          projectId: s.projectId,
          rows: s.rows,
          tds: s.tds ? { section: s.tds.section, ratePct: s.tds.ratePct, amount: s.tds.amount } : null,
          receivedAt: txn.txn_date,
          reference: txn.reference ?? null,
        }));
      } else if (s.kind === "item") {
        await payItem.mutateAsync({
          transactionId: txn.id, quoteId: s.item.quote_id, invoiceId: s.item.invoice_id,
          /* the rate CreditPayForSection stores: the one that explains the gap, else gap ÷ taxable */
          tdsAmount: s.tds?.amount ?? 0,
          tdsRatePct: s.tds ? tdsRateToRecord(amountCheck(credit, s.item.amount_due, s.item.taxable_value), s.item.taxable_value) : null,
          createSubscription: null, subStart: null, subRenewal: null,
        });
        toast.success(`${s.customerName}: payment recorded & reconciled`);
      } else {
        await payVendor.mutateAsync({
          transactionId: txn.id, vendorId: s.vendorId, newVendor: null,
          items: [{ item: s.item, cash: s.cash, tds: s.tds, section: s.tdsSection }],
          newBill: null, advance: 0, advanceCategory: null, bankCharge: 0, note: null,
        });
        toast.success(`${s.vendorName}: ${s.part ? "part payment" : "payment"} recorded & reconciled`);
      }
    } catch {
      return false;   // each hook toasts its own error, in the server's words
    }
    logSuggestion("accept", txn.id, s);
    return true;
  }, [txn, credit, suggestion, allocate, payItem, payVendor]);

  return { suggestion, accept, accepting };
}

/** The card: who · what for, the amount check, "Why: …", and the two buttons. */
export function SuggestionCard({ suggestion, accepting, onAccept, onChange }: {
  suggestion: Suggestion;
  accepting: boolean;
  onAccept: () => void;
  onChange: () => void;
}) {
  return (
    <section aria-labelledby="suggestion-h" className="rounded-md border border-amber/60 bg-amber-soft/30 p-3 space-y-2">
      <p id="suggestion-h" className="text-3xs uppercase tracking-wider font-semibold text-amber-ink inline-flex items-center gap-1">
        <Icon name="sparkles" size={11} /> Suggestion
      </p>
      <p className="text-sm font-medium text-ink break-words">{suggestion.title}</p>
      <p className="text-xs tabular-nums text-ink-2">{suggestion.amountLine}</p>
      <p className="text-xs text-ink-3 break-words"><span className="font-semibold text-ink-2">Why:</span> {suggestion.why}</p>
      <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
        <Button type="button" size="sm" variant="default" onClick={onChange} disabled={accepting}>Change</Button>
        <Button type="button" size="sm" variant="primary" icon="check" loading={accepting} disabled={accepting} onClick={onAccept}>
          Looks right — reconcile
        </Button>
      </div>
    </section>
  );
}
