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
 */
"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { CustomerProfile } from "@/components/features/customers/customer-profile";
import { MultiInvoicePaymentDialog } from "@/components/features/payments/multi-invoice-payment-dialog";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useCustomer } from "@/lib/queries/customers";
import { canRecordMoney } from "@/lib/auth/roles";

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const { data: me } = useCurrentUser();
  const { data: customer } = useCustomer(params.id);
  const [multiPayOpen, setMultiPayOpen] = React.useState(false);
  const canPay = canRecordMoney(me?.role) && !!customer;

  return (
    <>
      {canPay && (
        <div className="flex justify-end mb-3">
          <Button size="sm" icon="rupee" onClick={() => setMultiPayOpen(true)}>
            Record payment — multiple invoices
          </Button>
        </div>
      )}
      <CustomerProfile customerId={params.id} variant="page" />
      {canPay && (
        <MultiInvoicePaymentDialog
          open={multiPayOpen}
          onOpenChange={setMultiPayOpen}
          customerId={params.id}
          customerName={customer?.name ?? null}
        />
      )}
    </>
  );
}
