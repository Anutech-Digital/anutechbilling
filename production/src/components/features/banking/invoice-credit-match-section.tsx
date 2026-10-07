/**
 * R-109 — "Which invoice did this money pay?" inside the reconcile drawer (credit lines).
 *
 * Ranks the open invoices by the pure matcher (lib/banking/invoice-credit-match.ts) and
 * offers ONE operator click — "Match & record payment" — only where the deposit equals the
 * amount still due and nothing else muddies it. TDS-short, over/under-paid, project and
 * same-amount-twice candidates show why they are not one-click and link to the invoice,
 * where the full Record payment dialog (with TDS) lives. Nothing is ever recorded without
 * the click.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee } from "@/lib/utils";
import {
  useOpenInvoicesForCreditMatch,
  useMatchCreditToInvoice,
  type BankTransactionRow,
} from "@/lib/queries/bank";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { matchCreditToInvoices, type InvoiceMatch } from "@/lib/banking/invoice-credit-match";

const SHOW_MAX = 4;

const CONFIDENCE: Record<InvoiceMatch["confidence"], { label: string; kind: "success" | "info" | "muted" }> = {
  certain:  { label: "Strong match", kind: "success" },
  likely:   { label: "Likely",       kind: "info" },
  possible: { label: "Check",        kind: "muted" },
};

export function InvoiceCreditMatchSection({
  transaction,
  onDone,
}: {
  transaction: BankTransactionRow;
  onDone: () => void;
}) {
  const { data: invoices, isLoading } = useOpenInvoicesForCreditMatch(transaction.credit > 0);
  const matchPay = useMatchCreditToInvoice();
  const [pendingId, setPendingId] = React.useState<string | null>(null);

  const matches = React.useMemo(
    () => matchCreditToInvoices(
      {
        amount: transaction.credit,
        txnDate: transaction.txn_date,
        description: transaction.description,
        reference: transaction.reference,
      },
      invoices ?? [],
    ).slice(0, SHOW_MAX),
    [transaction, invoices],
  );

  if (transaction.credit <= 0) return null;
  if (isLoading) return <Skeleton className="h-16" />;
  if (matches.length === 0) return null;

  const handle = async (m: InvoiceMatch) => {
    if (!m.oneClick || !m.quoteId) return;
    setPendingId(m.invoiceId);
    try {
      await matchPay.mutateAsync({
        transactionId: transaction.id,
        bankAccountId: transaction.bank_account_id,
        quoteId: m.quoteId,
        invoiceId: m.invoiceId,
        amount: transaction.credit,
        reference: transaction.reference,
      });
      onDone();
    } catch { /* hook toasts */ } finally {
      setPendingId(null);
    }
  };

  return (
    <section aria-labelledby="inv-credit-match-h">
      <p id="inv-credit-match-h" className="text-xs font-semibold text-ink-2 mb-2">
        Open invoices this may pay
      </p>
      <ul className="space-y-2">
        {matches.map((m) => {
          const c = CONFIDENCE[m.confidence];
          return (
            <li key={m.invoiceId} className="rounded-md border border-hairline bg-paper p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 mb-0.5">
                    <Badge kind={c.kind} size="sm">{c.label}</Badge>
                    {m.tdsRatePct !== null && <Badge kind="warning" size="sm">TDS {m.tdsRatePct}%</Badge>}
                  </div>
                  <p className="text-sm font-medium text-ink break-words">
                    {m.customerName ?? "Customer"} · <span className="font-mono text-xs">{m.invoiceId}</span>
                  </p>
                  <p className="text-xs text-ink-3">
                    Due {rupee(m.amountDue)} · {m.reasons.join(" · ")}
                  </p>
                  {m.blockedReason && (
                    <p className="text-xs text-ink-2 mt-1">{m.blockedReason}</p>
                  )}
                </div>
                {m.oneClick ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => handle(m)}
                    loading={pendingId === m.invoiceId}
                    disabled={matchPay.isPending}
                  >
                    Match &amp; record payment
                  </Button>
                ) : (
                  <Link
                    href={invoiceHref(m.invoiceId)}
                    className="shrink-0 text-xs font-medium text-indigo hover:underline"
                  >
                    Open invoice
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
