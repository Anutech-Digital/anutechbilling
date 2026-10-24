/**
 * /customers/[id] — the standalone customer profile.
 *
 * A thin wrapper on purpose. The whole profile lives in CustomerProfile so the page and
 * the master-detail pane on /customers render THE SAME component; when this was two
 * implementations the panel showed a summary and the page showed the truth, and the two
 * were free to drift. Everything except the id and the page/panel variant belongs there.
 *
 * R-1525: plus one entry point — "Record payment — multiple invoices" (money roles only),
 * mounted here so the shared profile component stays untouched.
 * R-1527: and "Combine quotes into one" (same roles as Generate invoice) — several accepted,
 * un-invoiced quotes become one quote, so ONE tax invoice can be issued for them.
 */
"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { CustomerProfile } from "@/components/features/customers/customer-profile";
import { MultiInvoicePaymentDialog } from "@/components/features/payments/multi-invoice-payment-dialog";
import { CombineQuotesDialog } from "@/components/features/quotes/combine-quotes-dialog";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useCustomer } from "@/lib/queries/customers";
import { canRecordMoney } from "@/lib/auth/roles";

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const { data: me } = useCurrentUser();
  const { data: customer } = useCustomer(params.id);
  const [multiPayOpen, setMultiPayOpen] = React.useState(false);
  const [combineOpen, setCombineOpen] = React.useState(false);
  const canPay = canRecordMoney(me?.role) && !!customer;

  return (
    <>
      {canPay && (
        <div className="flex flex-wrap justify-end gap-2 mb-3">
          <Button size="sm" icon="layers" onClick={() => setCombineOpen(true)}>
            Combine quotes into one
          </Button>
          <Button size="sm" icon="rupee" onClick={() => setMultiPayOpen(true)}>
            Record payment — multiple invoices
          </Button>
        </div>
      )}
      <CustomerProfile customerId={params.id} variant="page" />
      {canPay && (
        <>
          <MultiInvoicePaymentDialog
            open={multiPayOpen}
            onOpenChange={setMultiPayOpen}
            customerId={params.id}
            customerName={customer?.name ?? null}
          />
          <CombineQuotesDialog
            open={combineOpen}
            onOpenChange={setCombineOpen}
            customerId={params.id}
            customerName={customer?.name ?? null}
          />
        </>
      )}
    </>
  );
}
