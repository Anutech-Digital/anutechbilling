"use client";

/**
 * R-1715 — when this quote's GST invoice was really raised, for the quote's workflow history.
 *
 * The history used quote.updated_at for "Customer accepted" and "Invoice generated", so the
 * time moved every time anything on the quote was saved (Q-0030: a reload after an edit showed
 * a new time). The invoice row's own created_at does not move.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export function useInvoiceCreatedAt(invoiceId: string | null | undefined) {
  return useQuery({
    queryKey: ["invoices", "created-at", invoiceId],
    enabled: !!invoiceId,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await createClient()
        .from("invoices")
        .select("created_at")
        .eq("id", invoiceId!)
        .maybeSingle();
      if (error) throw error;
      return (data as { created_at: string | null } | null)?.created_at ?? null;
    },
  });
}
