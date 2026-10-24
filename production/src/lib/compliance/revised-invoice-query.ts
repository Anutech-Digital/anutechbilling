/**
 * R-1531 — loader for the Section 31(3)(a) revised-invoice reminder (maths: revised-invoice.ts).
 *
 * Reads the GST registration (useGstRegistration — same cache as Settings) and, only when a
 * window exists (Registered with an effective date), the unregistered Bills of Supply dated in
 * it. Paged past the gateway's 1000-row cap (fetchAllRows, ordered by id). A failed read
 * throws, so the screen says "could not check" instead of showing nothing (§17c).
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { istToday } from "@/lib/dates/ist";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { createClient } from "@/lib/supabase/client";

import { useGstRegistration } from "./gst-registration-query";
import {
  revisedInvoiceReminder, revisedInvoiceWindow,
  type RevisedInvoiceBill, type RevisedInvoiceReminder,
} from "./revised-invoice";

export async function loadRevisedInvoiceBills(
  supabase: ReturnType<typeof createClient>,
  span: { from: string; to: string },
): Promise<RevisedInvoiceBill[]> {
  return fetchAllRows((from, to) => supabase.from("invoices")
    .select("id, invoice_date, amount, taxable_value, status, customer_name, document_kind, supplier_gst_status")
    .eq("document_kind", "bill_of_supply")
    .eq("supplier_gst_status", "unregistered")
    .in("status", ["pending", "paid", "overdue"])
    .gte("invoice_date", span.from).lte("invoice_date", span.to)
    .order("id", { ascending: true }).range(from, to));
}

export interface RevisedInvoiceReminderQuery {
  reminder: RevisedInvoiceReminder | null;
  isLoading: boolean;
  error: Error | null;
  /** False while tenants.gst_rc_date is not in this database yet (the reminder then has no deadline). */
  rcDateColumn: boolean;
  refetch: () => void;
}

export function useRevisedInvoiceReminder(): RevisedInvoiceReminderQuery {
  const reg = useGstRegistration();
  const today = istToday();
  const span = reg.data && !reg.data.columnMissing
    ? revisedInvoiceWindow({ saved: reg.data.saved, registeredFrom: reg.data.registeredFrom, rcDate: reg.data.rcDate }, today)
    : null;
  const bills = useQuery({
    queryKey: ["revised_invoice_bills", span?.from ?? null, span?.to ?? null],
    enabled: Boolean(span),
    queryFn: () => loadRevisedInvoiceBills(createClient(), span as { from: string; to: string }),
  });
  const hasSpan = Boolean(span);
  const reminder = React.useMemo(
    () => (reg.data && hasSpan && bills.data
      ? revisedInvoiceReminder({
          settings: { saved: reg.data.saved, registeredFrom: reg.data.registeredFrom, rcDate: reg.data.rcDate },
          bills: bills.data,
          today,
        })
      : null),
    [reg.data, hasSpan, bills.data, today],
  );
  return {
    reminder,
    isLoading: reg.isLoading || (Boolean(span) && bills.isLoading),
    error: (reg.error as Error | null) ?? (span ? (bills.error as Error | null) : null),
    rcDateColumn: reg.data?.rcDateColumn ?? true,
    refetch: () => { void reg.refetch(); if (span) void bills.refetch(); },
  };
}
