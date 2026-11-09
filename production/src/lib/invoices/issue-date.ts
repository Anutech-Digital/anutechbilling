/**
 * R-2635 — the date "Generate GST Invoice" will really put on the invoice, for the confirm dialog.
 *
 * generate_invoice (R-2095, migration 20261030054246) dates an invoice on the latest RECEIVED
 * payment's IST day, clamped by invoice_date_for_receipt: never after today, never on or before
 * the books lock. The confirm used to say "Dated <today> (today)" — wrong for a quote paid weeks ago
 * (Peak Performance, paid 26 Aug, invoiced in Oct). The hook asks the SAME SQL function, so the
 * dialog follows the server if that rule changes (e.g. R-2631, GST-filed months).
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { istToday, toIstDate } from "@/lib/dates/ist";

export type InvoiceDateWhy = "today" | "receipt" | "books_lock";

/** The IST day of the latest payment with status "received" (what generate_invoice reads), else null. */
export function latestReceiptIstDay(
  payments: readonly { status?: string | null; received_at?: string | null }[] | null | undefined,
): string | null {
  let best: string | null = null;
  for (const p of payments ?? []) {
    if (p.status !== "received" || !p.received_at) continue;
    const day = toIstDate(p.received_at);
    if (!best || day > best) best = day;
  }
  return best;
}

/** Why the server's date is what it is — for the words on the confirm. */
export function invoiceDateWhy(a: { date: string; receiptDay: string | null; today: string }): InvoiceDateWhy {
  if (a.date === a.today) return "today";
  if (a.receiptDay && a.date === a.receiptDay) return "receipt";
  return "books_lock";
}

/**
 * The invoice date generate_invoice will use, from invoice_date_for_receipt. While loading, or if the
 * call fails, `date` is null — the confirm then says nothing about the date rather than guess.
 */
export function useInvoiceIssueDate(args: { tenantId: string | null | undefined; receiptDay: string | null; enabled: boolean }) {
  const today = istToday();
  const q = useQuery({
    queryKey: ["invoice_date_for_receipt", args.tenantId ?? null, args.receiptDay],
    enabled: args.enabled && Boolean(args.tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await (createClient() as unknown as SupabaseClient).rpc("invoice_date_for_receipt", {
        p_tenant_id: args.tenantId, p_date: args.receiptDay,
      });
      if (error) throw new Error(error.message);
      return typeof data === "string" ? data.slice(0, 10) : null;
    },
  });
  const date = q.data ?? null;
  return { date, why: date ? invoiceDateWhy({ date, receiptDay: args.receiptDay, today }) : undefined };
}
