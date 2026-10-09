"use client";

/**
 * R-487 — owner-only "Fill missing costs" for invoices issued before quote lines were
 * copied onto invoices. Preview first: the list below is exactly what will be written
 * (computed by the database, re-computed on confirm — the browser never sends a cost).
 * Only the internal line cost changes; the invoice amount, tax and printed copy do not.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";
import { rupee } from "@/lib/utils";
import {
  applyCostFill, fetchCostFillPreview, summarizeCostFill, type CostFillRow,
} from "@/lib/invoices/cost-backfill";

const SOURCE_LABEL: Record<CostFillRow["source"], string> = {
  quote: "From quote",
  catalog: "From catalogue",
  missing: "Still missing",
};

export function FillCostsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ["invoice-cost-fill-preview"],
    queryFn: () => fetchCostFillPreview(createClient()),
    enabled: open,
    staleTime: 0,
  });
  const rows = React.useMemo(() => preview.data ?? [], [preview.data]);
  const summary = React.useMemo(() => summarizeCostFill(rows), [rows]);

  const apply = useMutation({
    mutationFn: () => applyCostFill(createClient(), summary.invoiceIds),
    onSuccess: (r) => {
      toast.success(`Costs filled on ${r.invoices_updated} invoice${r.invoices_updated === 1 ? "" : "s"}`, {
        description: r.skipped_locked > 0 ? `${r.skipped_locked} skipped — books are locked for their date.` : undefined,
      });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice-cost-fill-preview"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error("Costs not filled", { description: e.message }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">Fill missing costs</DialogTitle>
          <DialogDescription>
            Older invoices were saved without their quote lines, so margin could not be worked out.
            Check the list, then confirm. Invoice amounts and tax do not change.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending ? (
          <p className="text-[13px] text-ink-3">Working out what can be filled…</p>
        ) : preview.isError ? (
          <p className="text-[13px] text-danger">{(preview.error as Error).message}</p>
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-ink-2">Every invoice line already has a cost.</p>
        ) : (
          <>
            <ul className="space-y-1.5 text-[13px]">
              <li className="flex gap-2"><Icon name="check" size={14} className="text-emerald mt-0.5 shrink-0" />
                <span>{summary.fillable} line{summary.fillable === 1 ? "" : "s"} will get a cost ({summary.fromQuote} from the quote, {summary.fromCatalog} from the catalogue).</span></li>
              {summary.stillMissing > 0 && (
                <li className="flex gap-2"><Icon name="alert" size={14} className="text-amber mt-0.5 shrink-0" />
                  <span>{summary.stillMissing} line{summary.stillMissing === 1 ? "" : "s"} stay missing — no cost on the quote and no matching catalogue item. Add the item to the catalogue to fill them.</span></li>
              )}
              {summary.locked > 0 && (
                <li className="flex gap-2"><Icon name="info" size={14} className="text-ink-3 mt-0.5 shrink-0" />
                  <span>{summary.locked} line{summary.locked === 1 ? "" : "s"} skipped — books are locked for those dates.</span></li>
              )}
            </ul>
            <div className="max-h-72 overflow-auto border border-hairline rounded-md">
              <table className="w-full text-[12px]">
                <thead className="sticky top-0 bg-paper text-ink-3 text-left">
                  <tr>
                    <th scope="col" className="px-2 py-1.5 font-semibold">Invoice</th>
                    <th scope="col" className="px-2 py-1.5 font-semibold">Line</th>
                    <th scope="col" className="px-2 py-1.5 font-semibold text-right">Qty × rate</th>
                    <th scope="col" className="px-2 py-1.5 font-semibold text-right">Cost / unit</th>
                    <th scope="col" className="px-2 py-1.5 font-semibold">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.invoice_id}-${r.line_index}`} className="border-t border-hairline">
                      <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{r.invoice_id}</td>
                      <td className="px-2 py-1.5">{r.line_name ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{r.qty ?? 1} × {rupee(r.rate)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.cost_new == null ? "—" : rupee(r.cost_new)}</td>
                      <td className={`px-2 py-1.5 whitespace-nowrap ${r.source === "missing" || r.blocked ? "text-ink-3" : "text-ink-2"}`}>
                        {r.blocked ? "Books locked" : SOURCE_LABEL[r.source]}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <DialogFooter className="mt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={apply.isPending}>Cancel</Button>
          <Button
            variant="primary"
            loading={apply.isPending}
            disabled={apply.isPending || preview.isPending || summary.fillable === 0}
            onClick={() => apply.mutate()}
          >
            {summary.fillable > 0 ? `Fill ${summary.fillable} line${summary.fillable === 1 ? "" : "s"}` : "Nothing to fill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
