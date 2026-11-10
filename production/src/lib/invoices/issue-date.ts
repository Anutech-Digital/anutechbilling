/**
 * R-2635 — the date "Generate GST Invoice" will really put on the invoice, for the confirm dialog.
 *
 * generate_invoice (R-2095, migration 20261030054246) dates an invoice on the latest RECEIVED
 * payment's IST day, clamped by invoice_date_for_receipt: never after today, never on or before
 * the books lock. The confirm used to say "Dated <today> (today)" — wrong for a quote paid weeks ago
 * (Peak Performance, paid 26 Aug, invoiced in Oct). The hook asks the SAME SQL function, so the
 * dialog follows the server: since R-2631 that date also skips GST-filed months (the first open day).
 */
"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { istToday, toIstDate } from "@/lib/dates/ist";

/** R-2631: "first_open" = moved past locked books or a GST-filed month (invoice_date_for_receipt). */
export type InvoiceDateWhy = "today" | "receipt" | "first_open";

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
  /* R-2631: "today" only when there is no earlier receipt day it moved from — a first open day that
     happens to be today still says the receipt's month is closed. */
  if (a.date === a.today && (!a.receiptDay || a.receiptDay === a.today)) return "today";
  if (a.receiptDay && a.date === a.receiptDay) return "receipt";
  return "first_open";
}

/** invoice_date_for_receipt — the one SQL function generate_invoice dates with. */
async function fetchInvoiceDate(tenantId: string | null | undefined, receiptDay: string | null): Promise<string | null> {
  const { data, error } = await (createClient() as unknown as SupabaseClient).rpc("invoice_date_for_receipt", {
    p_tenant_id: tenantId, p_date: receiptDay,
  });
  if (error) throw new Error(error.message);
  return typeof data === "string" ? data.slice(0, 10) : null;
}

/**
 * The invoice date generate_invoice will use, from invoice_date_for_receipt. While loading, or if the
 * call fails, `date` is null — the confirm then says nothing about the date rather than guess.
 * R-2651: the one-day case of useInvoiceIssueDates (same query, same words).
 */
export function useInvoiceIssueDate(args: { tenantId: string | null | undefined; receiptDay: string | null; enabled: boolean }) {
  const many = useInvoiceIssueDates({ tenantId: args.tenantId, receiptDays: [args.receiptDay], enabled: args.enabled });
  const d = many.dateFor(args.receiptDay);
  /* R-2647: `loading` — the /invoices confirm holds Issue until the server's date is in (or failed). */
  return { date: d?.date ?? null, why: d?.why, loading: many.loading };
}

/**
 * R-2651 — the server date for SEVERAL receipt days at once (the bulk "Generate N" confirm): one
 * invoice_date_for_receipt call per distinct day (cached per day). `dateFor(day)` is undefined while
 * that day loads or if its call failed — the confirm then says nothing about that date rather than
 * guess. `loading` holds Issue until every day is in (or failed).
 */
export function useInvoiceIssueDates(args: { tenantId: string | null | undefined; receiptDays: readonly (string | null)[]; enabled: boolean }) {
  const today = istToday();
  const days = [...new Set(args.receiptDays)];
  const results = useQueries({
    queries: days.map((day) => ({
      queryKey: ["invoice_date_for_receipt", args.tenantId ?? null, day],
      enabled: args.enabled && Boolean(args.tenantId),
      staleTime: 60_000,
      queryFn: () => fetchInvoiceDate(args.tenantId, day),
    })),
  });
  const loading = results.some((r) => r.isLoading);
  /* Stable while the answers are the same, so a caller's useMemo on dateFor caches between renders. */
  const key = JSON.stringify(days.map((day, i) => [day, results[i]?.data === undefined ? "?" : results[i].data]));
  const dateFor = useMemo(() => {
    const byDay = new Map<string | null, string | null>(
      (JSON.parse(key) as [string | null, string | null | "?"][]).filter(([, v]) => v !== "?") as [string | null, string | null][],
    );
    return (day: string | null): { date: string | null; why?: InvoiceDateWhy } | undefined => {
      const date = byDay.get(day);
      if (date === undefined) return undefined;
      return { date, why: date ? invoiceDateWhy({ date, receiptDay: day, today }) : undefined };
    };
  }, [key, today]);
  return { dateFor, loading };
}
