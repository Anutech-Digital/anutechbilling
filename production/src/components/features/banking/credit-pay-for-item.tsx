/**
 * R-1838 / R-2466 — one row of "An open quote / invoice" (Banking → Reconcile → This money is for) and,
 * under the picked row, what paying it does when it is not a plain ₹ payment (lib/banking/item-fx-pay):
 * an export receipt on a foreign invoice (R-2427 forex / Bank Charges), or why Save is locked.
 * Moved out of credit-pay-for-section.tsx (R-2466) so that file stays within max-lines.
 */
"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import { formatForeign } from "@/lib/currency";
import { itemDetail, kindLabel, type OpenItem } from "@/lib/banking/credit-pay-for";
import { itemFxText, type ItemPayPlan } from "@/lib/banking/item-fx-pay";
import { NEEDS_APPROVAL_LABEL } from "@/lib/quotes/payment-approval";

/** R-2466: "$2,000 @ ₹84" after the ₹ due of a foreign invoice; "" for ₹. */
function foreignDue(item: OpenItem): string {
  const cur = (item.currency ?? "").toUpperCase();
  const rate = Number(item.fx_rate) || 0;
  if (!cur || cur === "INR" || !(rate > 0)) return "";
  const f = Math.round((item.amount_due / rate) * 100) / 100;
  return ` (${formatForeign(f, cur, Number.isInteger(f) ? 0 : 2)} @ ₹${rate})`;
}

export function OpenItemRow({ item, credit, selected, onPick }: { item: OpenItem; credit: number; selected: boolean; onPick: () => void }) {
  const exact = item.amount_due === credit;
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onPick}
        className={`w-full text-left rounded-md border p-2.5 flex items-start gap-2 ${selected ? "border-amber bg-amber/10" : "border-hairline bg-paper hover:border-hairline-strong"}`}
      >
        <span aria-hidden className={`mt-1 h-3 w-3 shrink-0 rounded-full border ${selected ? "border-amber bg-amber" : "border-hairline-strong"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge kind={item.kind === "renewal" ? "info" : item.kind === "add_seats" ? "warning" : item.kind === "new" ? "success" : "muted"} size="sm">
              {kindLabel(item.kind)}
            </Badge>
            {exact && <Badge kind="success" size="sm">Exact amount</Badge>}
            {item.approval_block && <Badge kind="warning" size="sm">{NEEDS_APPROVAL_LABEL}</Badge>}
          </span>
          <span className="block text-sm text-ink break-words mt-0.5">{itemDetail(item)}</span>
          <span className="block text-xs text-ink-3">Due {rupee(item.amount_due)}{foreignDue(item)} · {formatDate(item.doc_date)}</span>
        </span>
      </button>
    </li>
  );
}

/** R-2466: the export receipt it books, or why Save is locked. Nothing for a plain ₹ item. */
export function ItemPlanNote({ plan, item }: { plan: ItemPayPlan | null; item: OpenItem | null }) {
  if (!plan) return null;
  if (plan.problem) return <p role="alert" className="text-xs text-amber-ink break-words">{plan.problem}</p>;
  if (!plan.fx || !item?.invoice_id) return null;
  return (
    <p className="text-xs text-ink-2 bg-paper rounded-md border border-hairline px-2.5 py-2 break-words">
      {itemFxText(item.invoice_id, plan.fx, item.amount_due)}
    </p>
  );
}
