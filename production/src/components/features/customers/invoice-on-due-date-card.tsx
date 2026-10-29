/**
 * R-2044 — "Invoice on due date" for one customer (default OFF; Pardeep, 28 Oct 2026).
 *
 * OFF: each part of a subscription billed in parts (monthly / quarterly / half-yearly) is first a
 * payment request — "Advance payment for Q2 · …" — and the tax invoice is raised when it is paid.
 * ON: the old way for this customer — the tax invoice on each bill date even if unpaid, so GST is
 * owed on it; chased by the invoice reminders. Read by bill_subscription_instalment
 * (customers.invoice_parts_on_due_date). Owner or manager changes it, like Renewal grace.
 * Before the migration the column is absent and the card renders nothing.
 */
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { isMissingColumn } from "@/lib/renewals/grace-overrides";

export const INVOICE_ON_DUE_DATE_HINT = "Tax invoice is raised on each bill date even if unpaid — GST is owed on it.";

/* invoice_parts_on_due_date is newer than the generated types (database.types.ts is shared). */
type Loose = {
  from: (t: "customers") => {
    select: (c: string) => { eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: { invoice_parts_on_due_date: boolean | null } | null; error: unknown }> } };
    update: (v: { invoice_parts_on_due_date: boolean }) => { eq: (c: string, v: string) => PromiseLike<{ error: unknown }> };
  };
};

export function InvoiceOnDueDateCard({ customerId, canEdit }: { customerId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ["customers", customerId, "invoice-on-due-date"] as const;
  const { data } = useQuery({
    queryKey: key,
    queryFn: async (): Promise<{ ready: boolean; on: boolean }> => {
      const db = createClient() as unknown as Loose;
      const { data: row, error } = await db.from("customers").select("invoice_parts_on_due_date").eq("id", customerId).maybeSingle();
      if (error) {
        if (isMissingColumn(error)) return { ready: false, on: false };
        throw error;
      }
      return { ready: true, on: row?.invoice_parts_on_due_date === true };
    },
  });

  const save = useMutation({
    mutationFn: async (on: boolean) => {
      const db = createClient() as unknown as Loose;
      const { error } = await db.from("customers").update({ invoice_parts_on_due_date: on }).eq("id", customerId);
      if (error) throw error;
    },
    onSuccess: (_v, on) => {
      void qc.invalidateQueries({ queryKey: key });
      toast.success(on ? "Invoice on due date: on" : "Invoice on due date: off — payment request first");
    },
    onError: (err) => toastError(err, { fallback: "Could not save Invoice on due date." }),
  });

  if (!data?.ready) return null;
  const id = `invoice-on-due-${customerId}`;

  return (
    <Card title="Invoice on due date" sub={data.on ? "On" : "Off · payment request first"}>
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-3">
          <Switch
            id={id}
            checked={data.on}
            disabled={!canEdit || save.isPending}
            onCheckedChange={(v) => save.mutate(v)}
            aria-describedby={`${id}-hint`}
          />
          <label htmlFor={id} className="text-ink">Invoice on due date</label>
        </div>
        <p id={`${id}-hint`} className="text-xs text-ink-3">
          {INVOICE_ON_DUE_DATE_HINT}
          {" "}Off: each part of a subscription billed in parts is sent as a payment request first; the tax invoice is raised when it is paid.
          {!canEdit && " Only the owner or a manager can change this."}
        </p>
      </div>
    </Card>
  );
}
