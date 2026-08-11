/**
 * ExpenseDetailDialog — an expense's line items + a reconciliation you can
 * check against the paper bill: items sum → subtotal (pre-GST) → + GST → Total,
 * in the bill's OWN currency (₹ shown alongside for foreign bills). Mirrors the
 * COGS-bill BillDetailDialog so both purchase docs read the same way.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, formatForeignAmount } from "@/lib/utils";
import { getBillAttachmentUrl } from "@/lib/queries/vendor-bills";
import type { Expense } from "@/lib/queries/expenses";

export function ExpenseDetailDialog({ expense, onEdit, onClose }: {
  expense: Expense;
  onEdit?: () => void;
  onClose: () => void;
}) {
  const foreign = (expense.currency ?? "INR") !== "INR" && (expense.fx_rate ?? 1) > 0;
  const cur  = expense.currency ?? "INR";
  const rate = expense.fx_rate || 1;
  // Everything shown in the bill's OWN currency so it matches the paper bill.
  // ₹ figures (amount/gst) get divided back by the rate; line items are native.
  const disp  = (inr: number) => (foreign ? inr / rate : inr);
  const money = (v: number) => (foreign ? (formatForeignAmount(cur, v) ?? "") : rupee(v));

  const items    = expense.line_items ?? [];
  const itemsSum = items.reduce((s, li) => s + (li.amount || 0), 0);
  const gstInr   = expense.gst_paid ?? 0;
  const totInr   = expense.amount ?? 0;
  const subInr   = Math.max(0, totInr - gstInr);   // expenses store amount incl-GST; subtotal is derived
  const subDisp  = disp(subInr);
  const gstDisp  = disp(gstInr);
  const totDisp  = disp(totInr);

  // Reconciliation checks (tolerance covers rounding / ₹↔currency drift).
  const tol = foreign ? 1 : 2;
  const itemsMatch = items.length === 0 ? null : Math.abs(itemsSum - subDisp) <= tol;

  const [openingBill, setOpeningBill] = React.useState(false);
  async function openAttachment() {
    if (!expense.attachment_url) return;
    setOpeningBill(true);
    try {
      const url = await getBillAttachmentUrl(expense.attachment_url);
      if (url) window.open(url, "_blank", "noopener");
    } finally { setOpeningBill(false); }
  }

  const billTag =
    expense.bill_type === "kaccha" ? { label: "Kaccha bill", cls: "bg-amber-soft text-amber-ink" }
  : expense.bill_type === "none"   ? { label: "No bill", cls: "bg-paper-2 text-ink-3" }
  : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {expense.attachment_url ? (
              <button type="button" onClick={openAttachment} disabled={openingBill}
                title="Open the attached bill"
                className="inline-flex items-center gap-1.5 text-amber-ink hover:underline disabled:opacity-60">
                {expense.vendor_name || expense.category}
                <Icon name="file" size={14} className="shrink-0" />
              </button>
            ) : (
              expense.vendor_name || expense.category
            )}
            {billTag && <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${billTag.cls}`}>{billTag.label}</span>}
          </DialogTitle>
          <DialogDescription>
            {formatDate(expense.expense_date)} · {expense.category}
            {expense.payment_method && <span> · {expense.payment_method.replace(/_/g, " ")}</span>}
            {foreign && <span className="ml-1 text-amber-ink">· {cur} @ ₹{rate}/{cur}</span>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[62vh] overflow-y-auto -mx-1 px-1">
          {/* Line items */}
          <div className="rounded-lg border border-hairline overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper-2 text-ink-3 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Item</th>
                  <th className="text-right px-3 py-2 font-medium">Qty</th>
                  <th className="text-right px-3 py-2 font-medium">Unit price</th>
                  <th className="text-right px-3 py-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {items.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-ink-3 text-[13px]">No line items captured for this expense.</td></tr>
                ) : items.map((li, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 text-ink">{li.name || "—"}</td>
                    <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{li.qty ?? "—"}</td>
                    <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{li.rate != null ? money(li.rate) : "—"}</td>
                    <td className="px-3 py-2 text-right text-ink font-mono tabular-nums">{money(li.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Reconciliation — check the entry adds up against the paper bill */}
          <div className="rounded-lg border border-hairline bg-paper-2/30 p-3 space-y-1.5 text-sm">
            {items.length > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-ink-3">Items total</span>
                <span className="font-mono tabular-nums text-ink-2">{money(itemsSum)}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-ink-3">Subtotal (pre-GST)</span>
              <span className="font-mono tabular-nums text-ink-2">{money(subDisp)}</span>
            </div>
            {itemsMatch !== null && (
              <div className={`flex items-center gap-1.5 text-[11px] ${itemsMatch ? "text-emerald" : "text-amber-ink"}`}>
                <Icon name={itemsMatch ? "check_circle" : "alert"} size={12} />
                {itemsMatch ? "Items add up to the subtotal" : `Items (${money(itemsSum)}) don't match the subtotal (${money(subDisp)}) — check the entry`}
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-ink-3">Input GST</span>
              <span className="font-mono tabular-nums text-emerald">{gstInr > 0 ? money(gstDisp) : "—"}</span>
            </div>
            <div className="flex items-center justify-between border-t border-hairline pt-1.5 mt-1">
              <span className="font-semibold text-ink">Total</span>
              <span className="text-right">
                <span className="font-mono tabular-nums font-semibold text-ink">{money(totDisp)}</span>
                {foreign && <span className="block text-[11px] font-normal text-ink-3">= {rupee(totInr)}</span>}
              </span>
            </div>
          </div>

          {/* Comment / extra detail */}
          {expense.notes && (
            <div className="rounded-lg border border-hairline bg-paper-2/30 p-3">
              <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1">Comment</div>
              <p className="text-[13px] text-ink-2 whitespace-pre-wrap leading-relaxed">{expense.notes}</p>
            </div>
          )}

          {expense.attachment_url && (
            <button type="button" onClick={openAttachment} disabled={openingBill}
              className="flex items-center gap-1.5 text-[12px] text-amber-ink hover:underline disabled:opacity-60">
              <Icon name="file" size={13} /> {openingBill ? "Opening…" : "View attached bill"}
            </button>
          )}

          <p className="text-[11px] text-ink-3">
            Amounts shown in {foreign ? `${cur} (the bill's currency), with ₹ for the total` : "₹"}.
            {expense.attachment_url ? " Open the attached bill to compare." : ""}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Close</Button>
          {onEdit && <Button type="button" variant="primary" icon="edit" onClick={onEdit}>Edit</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
