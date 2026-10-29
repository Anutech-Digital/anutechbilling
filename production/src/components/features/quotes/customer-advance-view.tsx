"use client";

/**
 * R-2023: the page of an R-1863 CUSTOMER ADVANCE (/quotes/<holder>). Not a sale: no stepper, no
 * "Generate GST Invoice", no "Raise the GST invoice" — the money is kept as the customer's
 * credit (Balance Sheet → Advances from customers) and used later through Record payment →
 * "Use advance" on the quote or invoice for what is sold (customer-advance.ts).
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import type { Payment } from "@/lib/supabase/database.types";
import { useCustomerCreditRows } from "@/lib/queries/customer-advances";
import { advanceAvailable, customerAdvanceStatus, CUSTOMER_ADVANCE_LABEL } from "@/lib/quotes/customer-advance";

export interface CustomerAdvanceViewProps {
  quote: { id: string; customer_id: string | null; customer_name: string | null; payment_amount?: number | null };
  payments: readonly Payment[];
  onOpenReceipt?: (p: Payment) => void;
  children?: React.ReactNode;
}

export function CustomerAdvanceView({ quote, payments, onOpenReceipt, children }: CustomerAdvanceViewProps) {
  const router = useRouter();
  const { data: creditRows, isLoading } = useCustomerCreditRows(quote.customer_id);
  const received = payments.filter((p) => p.status === "received");
  const receivedTotal = received.reduce((s, p) => s + (p.amount ?? 0), 0) || (quote.payment_amount ?? 0);
  const payIds = new Set(received.map((p) => p.id));
  const mine = (creditRows ?? []).filter((r) => r.source_payment_id && payIds.has(r.source_payment_id));
  const available = advanceAvailable(mine);
  const used = Math.max(0, receivedTotal - available);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-start gap-3 min-w-0">
        <IconButton icon="arrow_left" aria-label="Back" onClick={() => router.push("/payments" as never)} />
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue · {CUSTOMER_ADVANCE_LABEL}</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">{rupee(receivedTotal)} advance</h1>
          <p className="text-sm text-ink-3 mt-1 flex items-center gap-2 flex-wrap">
            <span>
              From{" "}
              {quote.customer_id ? (
                <Link href={`/customers/${quote.customer_id}` as never} className="font-semibold text-ink hover:text-amber-ink hover:underline">
                  {quote.customer_name}
                </Link>
              ) : (
                <b className="text-ink">{quote.customer_name}</b>
              )}
            </span>
            <span>·</span>
            <span className="font-mono text-xs">{quote.id}</span>
            <span>·</span>
            <Badge kind="info" dot data-testid="advance-status">
              {isLoading ? CUSTOMER_ADVANCE_LABEL : customerAdvanceStatus(available)}
            </Badge>
          </p>
        </div>
      </div>

      <Card>
        <p className="text-sm text-ink-2">
          Money this customer paid before anything was sold. It is kept as their credit
          (Balance Sheet → Advances from customers) — there is <b>nothing to invoice</b> here.
          When you bill them, open the quote or invoice, press <b>Record payment</b> and tick
          <b> Use advance</b>: the bill is paid from it and the advance goes down.
        </p>
        <dl className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
          <div className="rounded-md bg-paper-2/60 px-3 py-2">
            <dt className="text-2xs uppercase tracking-wider text-ink-3">Received</dt>
            <dd className="font-serif text-lg tabular-nums">{rupee(receivedTotal)}</dd>
          </div>
          <div className="rounded-md bg-paper-2/60 px-3 py-2">
            <dt className="text-2xs uppercase tracking-wider text-ink-3">Used / refunded</dt>
            <dd className="font-serif text-lg tabular-nums">{isLoading ? "…" : rupee(used)}</dd>
          </div>
          <div className="rounded-md bg-emerald-soft/40 px-3 py-2">
            <dt className="text-2xs uppercase tracking-wider text-ink-3">Available</dt>
            <dd className="font-serif text-lg tabular-nums text-emerald" data-testid="advance-available">{isLoading ? "…" : rupee(available)}</dd>
          </div>
        </dl>

        {received.length > 0 && (
          <ul className="mt-4 divide-y divide-hairline border-t border-hairline text-sm">
            {received.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-ink-2">
                  {formatDate(p.received_at)} · {rupee(p.amount)}{p.reference ? <> · <span className="font-mono text-xs">{p.reference}</span></> : null}
                </span>
                {p.receipt_voucher_no && (
                  onOpenReceipt ? (
                    <button type="button" onClick={() => onOpenReceipt(p)} className="font-mono text-xs text-amber-ink hover:underline" title="Open receipt voucher">
                      {p.receipt_voucher_no}
                    </button>
                  ) : (
                    <span className="font-mono text-xs text-ink-3">{p.receipt_voucher_no}</span>
                  )
                )}
              </li>
            ))}
          </ul>
        )}

        {quote.customer_id && (
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="primary" icon="file">
              <Link href={`/quotes/new?customer=${quote.customer_id}` as never}>New quote for this customer</Link>
            </Button>
            <Button asChild icon="user">
              <Link href={`/customers/${quote.customer_id}` as never}>Open customer</Link>
            </Button>
          </div>
        )}
      </Card>
      {children}
    </div>
  );
}
