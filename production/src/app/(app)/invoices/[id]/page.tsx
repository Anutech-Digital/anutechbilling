/**
 * /invoices/[id] — one invoice on its own page (R-086, 6 Oct 2026).
 *
 * A real address: the link survives WhatsApp/email, Refresh re-opens the same invoice and
 * Back returns to the list exactly as it was filtered (the list keeps its tab/focus in the
 * URL). The body is InvoiceDetail — the same component, and so the same figures, that the
 * list's sheet used to show.
 *
 * Read with RLS on the browser client like the list, so another tenant's id reads as "not
 * found" rather than leaking. The query key sits under ["invoices"], so every invoice
 * mutation that invalidates the list (payment, credit note, delete) refreshes this too.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { Invoice } from "@/lib/supabase/database.types";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { InvoiceDetail } from "../invoice-detail";
import { invoiceIdFromParam } from "../invoice-href";

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const invoiceId = invoiceIdFromParam(params.id);

  const { data: invoice, isLoading, error, refetch } = useQuery({
    queryKey: ["invoices", "detail", invoiceId],
    enabled: invoiceId.length > 0,
    queryFn: async (): Promise<Invoice | null> => {
      const supabase = createClient();
      const { data, error: readError } = await supabase
        .from("invoices")
        .select("*")
        .eq("id", invoiceId)
        .maybeSingle();
      if (readError) throw readError;
      return data;
    },
  });

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto p-4 md:p-6 lg:p-8 space-y-4" aria-busy="true">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-16" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <EmptyState
          icon="alert"
          title={error ? "Could not load this invoice" : `Invoice ${invoiceId || ""} not found`.replace("  ", " ")}
          body={
            error
              ? `${error.message}. Check your connection and try again.`
              : "No invoice with this number exists in your company. The link may have a typo, or the draft was deleted. Search for it in the invoice list."
          }
          action={
            error ? (
              <Button variant="primary" icon="refresh" onClick={() => void refetch()}>
                Try again
              </Button>
            ) : (
              <Button asChild variant="primary" icon="file">
                <Link href={`/invoices?q=${encodeURIComponent(invoiceId)}` as never}>Search invoices</Link>
              </Button>
            )
          }
          secondary={
            error ? (
              <Link href={"/invoices" as never} className="text-xs text-ink-3 hover:text-ink underline">
                Back to invoices
              </Link>
            ) : undefined
          }
        />
      </div>
    );
  }

  return <InvoiceDetail invoice={invoice} />;
}
