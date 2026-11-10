/**
 * BillDetailDialog — a vendor bill's line items + a reconciliation you can
 * check against the paper bill: items sum → subtotal → + GST → Total, in the
 * bill's OWN currency (₹ shown alongside for foreign bills). Shared by the
 * Vendor Bills list and the vendor detail dialog.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, formatForeignAmount } from "@/lib/utils";
import { useSetBillServicePeriod, useVendorBillServicePeriods, type VendorBill } from "@/lib/queries/vendor-bills";
import { monthsToPeriod } from "@/lib/accounting/bill-service-period";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";

/** R-2623: who may change a bill — the same roles as RLS vendor_bills_update_roles (migration r719). */
const BILL_EDIT_ROLES = new Set(["owner", "manager", "accountant", "billing"]);
import { ServicePeriodField, type ServicePeriodMonths } from "@/app/(app)/accounting/bills/service-period-field";

export function BillDetailDialog({ bill, onClose }: { bill: VendorBill; onClose: () => void }) {
  const foreign = (bill.currency ?? "INR") !== "INR" && (bill.fx_rate ?? 1) > 0;
  const cur  = bill.currency ?? "INR";
  const rate = bill.fx_rate || 1;
  // Everything shown in the bill's OWN currency so it matches the paper bill.
  // Line-item amounts are already native; ₹ columns get divided back by rate.
  const disp  = (inr: number) => (foreign ? inr / rate : inr);
  const money = (v: number) => (foreign ? (formatForeignAmount(cur, v) ?? "") : rupee(v));

  const items    = bill.line_items ?? [];
  const itemsSum = items.reduce((s, li) => s + (li.amount || 0), 0);
  const subDisp  = disp(bill.subtotal ?? 0);
  const gstInr   = (bill.cgst ?? 0) + (bill.sgst ?? 0) + (bill.igst ?? 0);
  const gstDisp  = disp(gstInr);
  const totDisp  = disp(bill.total ?? 0);

  // Reconciliation checks (tolerance covers rounding / ₹↔currency drift).
  const tol = foreign ? 1 : 2;
  const itemsMatch = items.length === 0 ? null : Math.abs(itemsSum - subDisp) <= tol;
  const totalMatch = Math.abs(subDisp + gstDisp - totDisp) <= tol;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {bill.vendor_name}
            {bill.bill_no && <span className="font-mono text-xs text-ink-3">#{bill.bill_no}</span>}
          </DialogTitle>
          <DialogDescription>
            {formatDate(bill.bill_date)} · {bill.category}
            {foreign && <span className="ml-1 text-amber-ink">· {cur} @ ₹{rate}/{cur}</span>}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[62vh] overflow-y-auto -mx-1 px-1">
          <BillServicePeriodSection billId={bill.id} />

          {/* Line items */}
          <div className="rounded-lg border border-hairline overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper-2 text-ink-3 text-2xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Item</th>
                  <th className="text-right px-3 py-2 font-medium">Qty</th>
                  <th className="text-right px-3 py-2 font-medium">Unit price</th>
                  <th className="text-right px-3 py-2 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {items.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-ink-3 text-[13px]">No line items captured for this bill.</td></tr>
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
              <div className={`flex items-center gap-1.5 text-xs ${itemsMatch ? "text-emerald" : "text-amber-ink"}`}>
                <Icon name={itemsMatch ? "check_circle" : "alert"} size={12} />
                {itemsMatch ? "Items add up to the subtotal" : `Items (${money(itemsSum)}) don't match the subtotal (${money(subDisp)}) — check the entry`}
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-ink-3">GST</span>
              <span className="font-mono tabular-nums text-emerald">{gstInr > 0 ? money(gstDisp) : "—"}</span>
            </div>
            <div className="flex items-center justify-between border-t border-hairline pt-1.5 mt-1">
              <span className="font-semibold text-ink">Total</span>
              <span className="text-right">
                <span className="font-mono tabular-nums font-semibold text-ink">{money(totDisp)}</span>
                {foreign && <span className="block text-xs font-normal text-ink-3">= {rupee(bill.total)}</span>}
              </span>
            </div>
            {!totalMatch && (
              <div className="flex items-center gap-1.5 text-xs text-amber-ink">
                <Icon name="alert" size={12} /> Subtotal + GST doesn&apos;t equal Total — re-check the amounts.
              </div>
            )}
          </div>

          <p className="text-xs text-ink-3">
            Amounts shown in {foreign ? `${cur} (the bill's currency), with ₹ for the total` : "₹"}.
            {bill.attachment_url ? " Open the original bill from the ⋯ menu to compare." : ""}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * R-2623 — the month(s) this bill is for (management P&L; GST keeps the bill date). Shows the
 * database's period and why ("auto (…)" / "set on the bill"); Change → month pickers → Save writes
 * only service_from / service_to (allowed on a filed month too — the amounts and GST do not move).
 * "Use auto" (outside the pickers, on a period the owner set) clears it — both columns back to
 * empty. Only the roles that may change a bill (owner, manager, accountant, billing —
 * vendor_bills_update_roles) see Change.
 */
function BillServicePeriodSection({ billId }: { billId: string }) {
  const ids = React.useMemo(() => [billId], [billId]);
  const periodsQ = useVendorBillServicePeriods(ids);
  const { data: me } = useCurrentUser();
  const canEdit = BILL_EDIT_ROLES.has(me?.role ?? "");
  const current = periodsQ.isLoading ? undefined : (periodsQ.data?.get(billId) ?? null);
  const save = useSetBillServicePeriod();
  const [draft, setDraft] = React.useState<ServicePeriodMonths>(null);
  const isSet = current?.basis === "set";
  const check = draft ? monthsToPeriod(draft.from, draft.to) : null;

  function onChange(v: ServicePeriodMonths) {
    if (v) { setDraft(v); return; }
    // "Use auto": the owner's own period goes (the pickers close once it is saved).
    if (isSet) save.mutate({ id: billId, service_from: null, service_to: null }, { onSuccess: () => setDraft(null) });
    else setDraft(null);
  }

  function onSave() {
    if (!check || !check.ok) return;
    save.mutate(
      { id: billId, service_from: check.service_from, service_to: check.service_to },
      { onSuccess: () => setDraft(null) },
    );
  }

  return (
    <div className="rounded-lg border border-hairline bg-paper-2/30 p-3">
      <p className="mb-1.5 text-3xs uppercase tracking-wider text-ink-3 font-semibold">Service period</p>
      {periodsQ.isError ? (
        <p className="text-xs text-rose">The service period did not load — close and open the bill again.</p>
      ) : (
        <ServicePeriodField
          idPrefix={`bill-${billId}-service`}
          current={current}
          auto={isSet ? null : current}
          value={draft}
          onChange={onChange}
          disabled={save.isPending || !canEdit}
          showUseAuto={false}
        />
      )}
      {draft && (
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="default" size="sm" onClick={() => setDraft(null)} disabled={save.isPending}>Cancel</Button>
          <Button type="button" variant="primary" size="sm" onClick={onSave} loading={save.isPending} disabled={!check?.ok}>
            Save period
          </Button>
        </div>
      )}
      {!draft && isSet && canEdit && (
        <div className="mt-2 flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)} loading={save.isPending}>Use auto</Button>
        </div>
      )}
      <p className="mt-1.5 text-xs text-ink-3">The management P&amp;L shows this bill&apos;s cost in these months; GST reports use the bill date.</p>
    </div>
  );
}
