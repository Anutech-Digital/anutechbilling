/**
 * PlaceOrderDialog — operator finalizes a draft PO.
 *
 * Workflow:
 *   - Draft PO auto-created by record_payment
 *   - Operator opens this dialog → confirms wholesale cost, enters vendor's
 *     order ID (Google CSP order ID etc.), and marks PO as `placed`
 *   - Status flow: draft → placed → provisioned → closed
 *
 * Also handles status advance for already-placed POs (mark provisioned /
 * closed) and cancellation.
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { rupee, formatDate } from "@/lib/utils";
import {
  useUpdatePurchaseOrder,
  useUpdatePurchaseOrderCost,
  usePOAllocations,
  useUnallocatedVendorBills,
  useAllocateBillToPO,
  useDeallocate,
} from "@/lib/queries/purchase-orders";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import CreateBillFromPODialog from "./create-bill-from-po-dialog";
import type { PurchaseOrderRow, PurchaseOrderStatus } from "@/lib/supabase/database.types";

interface Props {
  po:   PurchaseOrderRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

const VENDOR_LABEL: Record<string, string> = {
  google:    "Google Workspace (CSP)",
  microsoft: "Microsoft 365 (Partner Center)",
  zoho:      "Zoho Partner Portal",
  other:     "Other",
};

const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft:       "Draft",
  placed:      "Placed",
  provisioned: "Provisioned",
  closed:      "Closed",
  cancelled:   "Cancelled",
};

export default function PlaceOrderDialog({ po, open, onOpenChange }: Props) {
  const updateMut    = useUpdatePurchaseOrder();
  const costMut      = useUpdatePurchaseOrderCost();
  const allocsQ      = usePOAllocations(open ? po.id : undefined);
  const billsQ       = useUnallocatedVendorBills();
  const allocateMut  = useAllocateBillToPO();
  const deallocMut   = useDeallocate();

  const [vendorOrderId, setVendorOrderId] = React.useState(po.vendor_order_id ?? "");
  const [unitCostPm,    setUnitCostPm]    = React.useState(String(po.unit_cost_pm ?? 0));
  const [notes,         setNotes]         = React.useState(po.notes ?? "");

  // Phase 2 — vendor bill matching state
  const [showAllocator,   setShowAllocator]   = React.useState(false);
  const [selectedBillId,  setSelectedBillId]  = React.useState<string>("");
  const [allocAmount,     setAllocAmount]     = React.useState<string>("");
  const [createBillOpen,  setCreateBillOpen]  = React.useState(false);

  // Re-sync local state if PO changes (e.g., a different row opens reusing the dialog mount)
  React.useEffect(() => {
    setVendorOrderId(po.vendor_order_id ?? "");
    setUnitCostPm(String(po.unit_cost_pm ?? 0));
    setNotes(po.notes ?? "");
  }, [po.id, po.vendor_order_id, po.unit_cost_pm, po.notes]);

  const unitCostNum = Math.max(0, Math.round(Number(unitCostPm) || 0));
  const totalCost   = unitCostNum * po.seats * po.term_months;

  const isDraft       = po.status === "draft";
  const isPlaced      = po.status === "placed";
  const isProvisioned = po.status === "provisioned";
  const isTerminal    = po.status === "closed" || po.status === "cancelled";

  const saveCost = async () => {
    if (unitCostNum === po.unit_cost_pm) return; // nothing to save
    await costMut.mutateAsync({
      id: po.id, unit_cost_pm: unitCostNum, seats: po.seats, term_months: po.term_months,
    });
  };

  const advance = async (next: PurchaseOrderStatus) => {
    try {
      // Persist cost first if operator edited it
      if (unitCostNum !== po.unit_cost_pm) await saveCost();

      await updateMut.mutateAsync({
        id:              po.id,
        status:          next,
        vendor_order_id: next === "placed" && vendorOrderId.trim()
                           ? vendorOrderId.trim()
                           : po.vendor_order_id,
        notes:           notes.trim() || null,
      });
      const verb =
        next === "placed"      ? "marked as placed" :
        next === "provisioned" ? "marked as provisioned" :
        next === "closed"      ? "closed" :
        next === "cancelled"   ? "cancelled" : "updated";
      toast.success(`PO ${po.id} ${verb}`);
      onOpenChange(false);
    } catch (err) {
      toastError(err, { fallback: "Could not update the PO.", description: "The PO is unchanged. Refresh and try again." });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <header className="border-b border-hairline pb-3 mb-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">
                Procurement · PO
              </p>
              <h2 className="font-serif text-2xl text-ink">{po.id}</h2>
              <p className="text-xs text-ink-3 mt-0.5">
                For <b className="text-ink-2">{po.customer_name}</b>
                {po.domain && <> · <span className="font-mono">{po.domain}</span></>}
              </p>
            </div>
            <Badge
              kind={
                po.status === "draft"        ? "warning" :
                po.status === "placed"       ? "info" :
                po.status === "provisioned"  ? "success" :
                po.status === "cancelled"    ? "danger" : "muted"
              }
              dot
            >
              {STATUS_LABEL[po.status]}
            </Badge>
          </div>
        </header>

        {/* Order shape — read-only context */}
        <div className="bg-paper-2 rounded-md p-3 mb-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Vendor</p>
            <p className="font-medium text-ink">{VENDOR_LABEL[po.vendor] ?? po.vendor}</p>
          </div>
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Plan</p>
            <p className="font-medium text-ink">{po.plan}</p>
          </div>
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Seats</p>
            <p className="font-medium text-ink tabular-nums">{po.seats}</p>
          </div>
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Term</p>
            <p className="font-medium text-ink tabular-nums">{po.term_months} months</p>
          </div>
        </div>

        {/* Editable: wholesale cost */}
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
          Wholesale cost (₹/seat/month)
        </p>
        <div className="flex items-center gap-2 mb-1">
          <Input aria-label="Wholesale cost per seat per month"
            type="number"
            min={0}
            value={unitCostPm}
            onChange={(e) => setUnitCostPm(e.target.value)}
            disabled={isTerminal}
            className="font-mono"
          />
          <span className="text-xs text-ink-3 whitespace-nowrap">₹/seat/mo</span>
        </div>
        <p className="text-xs text-ink-3 mb-4">
          Total order value: <b className="text-ink-2 tabular-nums">{rupee(totalCost)}</b>
          {" "}({rupee(unitCostNum)} × {po.seats} seats × {po.term_months} months)
        </p>

        {/* Editable: vendor order ID (only relevant on placed+ stages) */}
        {(isDraft || isPlaced) && (
          <>
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
              Vendor order ID
            </p>
            <Input aria-label="Vendor order ID"
              placeholder={po.vendor === "google" ? "e.g. GW-ORD-123456" : "Vendor's order reference"}
              value={vendorOrderId}
              onChange={(e) => setVendorOrderId(e.target.value)}
              disabled={isTerminal}
              className="font-mono mb-4"
            />
          </>
        )}

        {/* Editable: notes */}
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
          Notes
        </p>
        <textarea aria-label="Provisioning instructions, delivery date, contact at vendor, etc."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={isTerminal}
          rows={3}
          className="w-full text-sm bg-paper border border-hairline rounded px-3 py-2 mb-4 resize-none focus:outline-none focus:ring-1 focus:ring-amber"
          placeholder="Provisioning instructions, delivery date, contact at vendor, etc."
        />

        {/* Phase 2 — Linked vendor bills + variance */}
        <div className="border-t border-hairline pt-4 mb-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
                Linked vendor bills
              </p>
              <p className="text-xs text-ink-3 mt-0.5">
                Match Google's monthly invoices to this PO for real cost tracking
              </p>
            </div>
            {!isTerminal && (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  icon="plus"
                  variant="ghost"
                  onClick={() => setShowAllocator((v) => !v)}
                >
                  {showAllocator ? "Cancel" : "Match existing"}
                </Button>
                <Button
                  size="sm"
                  icon="receipt"
                  variant="primary"
                  onClick={() => setCreateBillOpen(true)}
                  title="Create a new vendor bill pre-filled from this PO + auto-match it"
                >
                  Create new bill
                </Button>
              </div>
            )}
          </div>

          {/* Variance summary */}
          {(() => {
            const allocs = allocsQ.data ?? [];
            const allocatedTotal = allocs.reduce((s, a) => s + a.allocated_amount, 0);
            const variance = po.total_cost - allocatedTotal;
            const variancePct = po.total_cost > 0 ? Math.round((variance / po.total_cost) * 100) : 0;
            return (
              <div className="bg-paper-2 rounded-md p-3 mb-2 grid grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Expected</p>
                  <p className="font-medium text-ink tabular-nums">{rupee(po.total_cost)}</p>
                </div>
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Allocated</p>
                  <p className="font-medium text-ink tabular-nums">{rupee(allocatedTotal)}</p>
                </div>
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Variance</p>
                  <p className={cn(
                    "font-medium tabular-nums",
                    Math.abs(variance) < 100 ? "text-emerald" :
                    variance > 0            ? "text-amber-ink" :
                                              "text-rose",
                  )}>
                    {variance === 0
                      ? "✓ matched"
                      : `${variance > 0 ? "+" : ""}${rupee(variance)} (${variancePct}%)`}
                  </p>
                </div>
              </div>
            );
          })()}

          {/* Allocator form */}
          {showAllocator && (
            <div className="border border-hairline rounded-md p-3 mb-2 bg-paper">
              <p className="text-xs font-medium text-ink mb-2">Allocate a vendor bill</p>
              <select aria-label="Vendor bill to allocate"
                value={selectedBillId}
                onChange={(e) => setSelectedBillId(e.target.value)}
                className="w-full text-sm bg-paper border border-hairline rounded px-3 py-2 mb-2 focus:outline-none focus:ring-1 focus:ring-amber"
              >
                <option value="">— Choose a bill —</option>
                {(billsQ.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.vendor_name} · {b.bill_no ?? "no-ref"} · {formatDate(b.bill_date)} · {rupee(b.total)}
                  </option>
                ))}
              </select>
              <Input aria-label="Amount to allocate (₹)"
                type="number"
                placeholder="Amount to allocate (₹)"
                value={allocAmount}
                onChange={(e) => setAllocAmount(e.target.value)}
                className="font-mono mb-2"
              />
              <div className="flex gap-2 justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setShowAllocator(false); setSelectedBillId(""); setAllocAmount(""); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon="check"
                  disabled={!selectedBillId || !allocAmount || allocateMut.isPending}
                  onClick={async () => {
                    try {
                      await allocateMut.mutateAsync({
                        purchase_order_id: po.id,
                        vendor_bill_id:    selectedBillId,
                        allocated_amount:  Number(allocAmount),
                      });
                      toast.success("Bill matched to PO");
                      setShowAllocator(false);
                      setSelectedBillId("");
                      setAllocAmount("");
                    } catch (err) {
                      toastError(err, { fallback: "Could not match the bill.", description: "Nothing was allocated. Check the amount is not more than the bill's balance, then try again." });
                    }
                  }}
                >
                  Allocate
                </Button>
              </div>
            </div>
          )}

          {/* Allocation list */}
          {allocsQ.data && allocsQ.data.length > 0 && (
            <ul className="space-y-1.5">
              {allocsQ.data.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2 text-xs bg-paper border border-hairline rounded px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink truncate">
                      {a.vendor_bill?.vendor_name ?? "—"}
                      {" · "}
                      <span className="font-mono">{a.vendor_bill?.bill_no ?? "(no ref)"}</span>
                    </p>
                    <p className="text-ink-3 text-xs">
                      Bill date: {a.vendor_bill ? formatDate(a.vendor_bill.bill_date) : "—"}
                      {" · "}Total: {a.vendor_bill ? rupee(a.vendor_bill.total) : "—"}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-medium text-ink tabular-nums">{rupee(a.allocated_amount)}</p>
                    <p className="text-xs text-ink-3">allocated</p>
                  </div>
                  {!isTerminal && (
                    <IconButton
                      icon="x"
                      size="sm"
                      aria-label="Remove allocation"
                      onClick={async () => {
                        try {
                          await deallocMut.mutateAsync(a.id);
                          toast.success("Allocation removed");
                        } catch (err) {
                          toastError(err, { fallback: "Could not remove the allocation.", description: "The bill is still matched to this PO. Refresh and try again." });
                        }
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          {allocsQ.data && allocsQ.data.length === 0 && !showAllocator && (
            <p className="text-xs text-ink-3 italic">
              No vendor bills matched yet. When Google sends its monthly invoice, match it here.
            </p>
          )}
        </div>

        {/* Timeline */}
        {(po.placed_at || po.provisioned_at || po.closed_at) && (
          <div className="bg-paper-2 rounded-md p-3 mb-4 text-xs space-y-1">
            {po.placed_at && (
              <div className="flex justify-between">
                <span className="text-ink-3">Placed with vendor</span>
                <span className="tabular-nums text-ink-2">{formatDate(po.placed_at)}</span>
              </div>
            )}
            {po.provisioned_at && (
              <div className="flex justify-between">
                <span className="text-ink-3">Provisioned</span>
                <span className="tabular-nums text-ink-2">{formatDate(po.provisioned_at)}</span>
              </div>
            )}
            {po.closed_at && (
              <div className="flex justify-between">
                <span className="text-ink-3">Closed</span>
                <span className="tabular-nums text-ink-2">{formatDate(po.closed_at)}</span>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>

          {!isTerminal && (
            <Button
              variant="ghost"
              icon="x"
              onClick={() => advance("cancelled")}
              disabled={updateMut.isPending}
            >
              Cancel order
            </Button>
          )}

          {isDraft && (
            <Button
              variant="primary"
              icon="check"
              onClick={() => advance("placed")}
              disabled={updateMut.isPending}
            >
              Mark as placed
            </Button>
          )}

          {isPlaced && (
            <Button
              variant="primary"
              icon="check_circle"
              onClick={() => advance("provisioned")}
              disabled={updateMut.isPending}
            >
              Mark as provisioned
            </Button>
          )}

          {isProvisioned && (
            <Button
              variant="primary"
              icon="check_circle"
              onClick={() => advance("closed")}
              disabled={updateMut.isPending}
            >
              Close PO
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {/* PO → Bill wizard (renders outside the main dialog to avoid nesting issues) */}
      {createBillOpen && (
        <CreateBillFromPODialog
          po={po}
          open={createBillOpen}
          onOpenChange={setCreateBillOpen}
        />
      )}
    </Dialog>
  );
}
