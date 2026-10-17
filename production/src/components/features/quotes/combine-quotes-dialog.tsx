/**
 * R-1527 — "Combine quotes into one" (Pardeep, 17 Oct 2026 — R-1524, option A).
 *
 * A customer wants ONE tax invoice for several accepted quotes. Issued invoices are never
 * merged (R-1524), so the operator ticks the customer's accepted, unpaid, un-invoiced quotes,
 * confirms the list and the total, and `combine_quotes` makes ONE new accepted quote with all
 * their lines (the originals close as "Replaced by" it). The page then opens the new quote,
 * where the normal "Generate GST Invoice" issues one invoice.
 *
 * Invoiced quotes are never listed. Quotes that cannot be combined stay visible with the
 * reason and what to do (§24); the server re-checks everything and is the one that decides.
 */
"use client";

import * as React from "react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import {
  combineBlockReason,
  combineMismatch,
  combinedTotal,
  showInCombineList,
  type CombinableQuote,
} from "@/lib/quotes/combine";
import { rupee, formatDate } from "@/lib/utils";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export interface CombineRow extends CombinableQuote {
  plan: string | null;
  created_date: string | null;
}

const COLUMNS =
  "id, status, invoice_id, superseded_by, payment_status, approval_status, is_renewal, is_extension, " +
  "is_add_seats, credit_activated_at, discount_pct, currency, exchange_rate, tax_rate, billing_cycle, " +
  "is_one_off, payment_terms_days, amount, plan, created_date";

/** The customer's accepted quotes with no invoice and not replaced — oldest first. */
export function useCombinableQuotes(customerId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["quotes", "combine", customerId],
    enabled: enabled && !!customerId,
    queryFn: async (): Promise<CombineRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select(COLUMNS)
        .eq("customer_id", customerId)
        .eq("status", "accepted")
        .is("invoice_id", null)
        .is("superseded_by", null)
        .order("created_date", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as unknown as CombineRow[]).filter(showInCombineList);
    },
  });
}

/** combine_quotes — all or nothing (§17b). Errors are the RPC's own words. */
export function useCombineQuotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (quoteIds: string[]) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("combine_quotes", { p_quote_ids: quoteIds });
      if (error) throw error;
      if (!data?.quote_id) throw new Error("The combined quote was not confirmed — refresh Quotes to see whether it was made.");
      return data;
    },
    onSuccess: () => {
      for (const key of ["quotes", "quote", "customers", "nav-badges"]) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function CombineQuotesDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string | null;
}) {
  const { open, onOpenChange, customerId, customerName } = props;
  const router = useRouter();
  const { data: rows = [], isLoading } = useCombinableQuotes(customerId, open);
  const combine = useCombineQuotes();
  const [picked, setPicked] = React.useState<string[]>([]);
  const [confirming, setConfirming] = React.useState(false);

  React.useEffect(() => {
    if (open) { setPicked([]); setConfirming(false); }
  }, [open]);

  const anchor = rows.find((r) => r.id === picked[0]);
  const chosen = rows.filter((r) => picked.includes(r.id));
  const total = combinedTotal(chosen);
  const reasonFor = (r: CombineRow) => combineBlockReason(r) ?? (picked.includes(r.id) ? null : combineMismatch(anchor, r));

  const toggle = (id: string, on: boolean) =>
    setPicked((cur) => (on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id)));

  const submit = () =>
    combine.mutate(picked, {
      onSuccess: (res) => {
        toast.success(`${res.quote_id} made from ${res.combined.length} quotes — ${rupee(res.amount)}`, {
          description: "Now press “Generate GST Invoice” on it for one tax invoice.",
        });
        onOpenChange(false);
        router.push(`/quotes/${res.quote_id}` as Route);
      },
      onError: (err) => {
        setConfirming(false);
        toastError(err, { description: "Nothing was changed. Fix that quote (or untick it), then combine again." });
      },
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="layers" size={18} className="text-amber" />
            {confirming ? `Make one quote from ${chosen.length} quotes?` : "Combine quotes into one"}
          </DialogTitle>
          <DialogDescription>
            {confirming
              ? "The new quote holds all their lines. The old quotes close as “Replaced by” it. Then issue ONE GST invoice from the new quote."
              : `${customerName ?? "This customer"}'s accepted quotes with no invoice yet. Tick the ones to put on one tax invoice.`}
          </DialogDescription>
        </DialogHeader>

        {!confirming && (
          <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1 space-y-1.5" data-testid="combine-list">
            {isLoading && <p className="text-sm text-ink-3">Loading quotes…</p>}
            {!isLoading && rows.length === 0 && (
              <p className="text-sm text-ink-3">
                No accepted quote without an invoice. Invoiced quotes can&apos;t be combined — an issued GST invoice never changes.{" "}
                <Link className="text-amber underline" href={`/quotes/new?customer=${customerId}` as Route}>New quote</Link>
              </p>
            )}
            {rows.map((r) => {
              const reason = reasonFor(r);
              const on = picked.includes(r.id);
              const boxId = `combine-${r.id}`;
              return (
                <div
                  key={r.id}
                  className={`flex items-start gap-3 rounded-lg border p-2.5 ${on ? "border-amber bg-amber-soft/40" : "border-hairline"}`}
                >
                  <Checkbox
                    id={boxId}
                    checked={on}
                    disabled={!on && !!reason}
                    onCheckedChange={(v) => toggle(r.id, v === true)}
                    aria-describedby={reason ? `${boxId}-why` : undefined}
                    className="mt-0.5"
                  />
                  <label htmlFor={boxId} className="flex-1 min-w-0 cursor-pointer">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-ink">{r.id}</span>
                      <span className="text-sm tabular-nums text-ink">{rupee(r.amount ?? 0)}</span>
                    </div>
                    <div className="text-2xs text-ink-3 truncate">
                      {r.plan ?? "—"}{r.created_date ? ` · ${formatDate(r.created_date)}` : ""}
                    </div>
                    {reason && (
                      <div id={`${boxId}-why`} className="text-2xs text-rose mt-0.5">
                        {reason}{" "}
                        <Link className="underline" href={`/quotes/${r.id}` as Route}>Open quote</Link>
                      </div>
                    )}
                  </label>
                </div>
              );
            })}
          </div>
        )}

        {confirming && (
          <div className="space-y-1.5" data-testid="combine-confirm">
            {chosen.map((r) => (
              <div key={r.id} className="flex justify-between text-sm">
                <span className="text-ink">{r.id} <span className="text-ink-3">· {r.plan ?? "—"}</span></span>
                <span className="tabular-nums">{rupee(r.amount ?? 0)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-hairline pt-1.5 text-sm font-semibold">
              <span>New quote total</span>
              <span className="tabular-nums">{rupee(total)}</span>
            </div>
            <p className="text-2xs text-ink-3">
              GST is worked out once on all the lines together, so the total can differ from the sum by ₹1.
            </p>
          </div>
        )}

        <DialogFooter className="items-center">
          {!confirming && picked.length < 2 && (
            <span className="text-2xs text-ink-3 mr-auto">Tick at least two quotes.</span>
          )}
          {!confirming && picked.length >= 2 && (
            <span className="text-2xs text-ink-3 mr-auto">{picked.length} quotes · {rupee(total)}</span>
          )}
          {confirming ? (
            <>
              <Button onClick={() => setConfirming(false)} disabled={combine.isPending}>Back</Button>
              <Button variant="primary" icon="layers" loading={combine.isPending} onClick={submit}>
                Make one quote
              </Button>
            </>
          ) : (
            <>
              <Button onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button variant="primary" disabled={picked.length < 2} onClick={() => setConfirming(true)}>
                Combine {picked.length >= 2 ? `${picked.length} quotes` : ""}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
