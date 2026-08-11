/**
 * CreateBillFromPODialog — pre-filled vendor bill form launched from a PO.
 *
 * Logic:
 *   • Bill is a REAL document received from the vendor (Google etc.). We
 *     pre-fill from PO ONLY to save typing — Pardeep MUST verify and edit
 *     amounts/dates/bill-numbers to match the actual vendor invoice.
 *
 *   • Suggested amount = PO.total_cost / PO.term_months (single month default
 *     for typical monthly billing). Operator overrides as needed.
 *
 *   • On save: vendor bill insert → THEN auto-allocate to this PO with the
 *     entered total amount. Single user action, two DB writes.
 *
 *   • GST: 18% standard split (CGST 9% + SGST 9% intra-state). One-click
 *     buttons compute the splits from subtotal.
 */

"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCreateVendorBill } from "@/lib/queries/vendor-bills";
import { useAllocateBillToPO } from "@/lib/queries/purchase-orders";
import { rupee } from "@/lib/utils";
import type { PurchaseOrderRow } from "@/lib/supabase/database.types";

const schema = z.object({
  vendor_name:  z.string().min(2, "Vendor name required"),
  vendor_gstin: z.string().optional(),
  bill_no:      z.string().min(1, "Vendor's bill # required (so audit trail matches Google's records)"),
  bill_date:    z.string().min(10, "Bill date required"),
  due_date:     z.string().optional(),
  category:     z.string().min(2),
  subtotal:     z.coerce.number().min(0),
  cgst:         z.coerce.number().min(0).default(0),
  sgst:         z.coerce.number().min(0).default(0),
  igst:         z.coerce.number().min(0).default(0),
  total:        z.coerce.number().min(1, "Total must be > 0"),
  notes:        z.string().optional(),
});
type FormData = z.infer<typeof schema>;

const VENDOR_TO_PRESET: Record<string, { name: string; category: string; gstin: string }> = {
  google:    { name: "Google Cloud / Workspace",     category: "COGS-Workspace", gstin: "" },
  microsoft: { name: "Microsoft Partner Center",     category: "COGS-M365",      gstin: "" },
  zoho:      { name: "Zoho Corporation",             category: "COGS-Zoho",      gstin: "" },
  other:     { name: "",                             category: "COGS-Other",     gstin: "" },
};

interface Props {
  po:    PurchaseOrderRow;
  open:  boolean;
  onOpenChange: (v: boolean) => void;
}

export default function CreateBillFromPODialog({ po, open, onOpenChange }: Props) {
  const createBill = useCreateVendorBill();
  const allocate   = useAllocateBillToPO();
  const today      = new Date().toISOString().slice(0, 10);

  // Suggested monthly amount = total / term_months (most resellers bill monthly)
  const suggestedMonthly = Math.round(po.total_cost / Math.max(1, po.term_months));
  const preset           = VENDOR_TO_PRESET[po.vendor] ?? VENDOR_TO_PRESET.other;

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      vendor_name:  preset.name,
      vendor_gstin: preset.gstin,
      bill_no:      "",
      bill_date:    today,
      due_date:     "",
      category:     preset.category,
      subtotal:     suggestedMonthly,
      cgst:         0,
      sgst:         0,
      igst:         0,
      total:        suggestedMonthly,
      notes:        `From PO ${po.id} (${po.customer_name} · ${po.plan})`,
    },
  });

  // Re-seed defaults whenever the PO changes (dialog reused across rows)
  React.useEffect(() => {
    const monthly = Math.round(po.total_cost / Math.max(1, po.term_months));
    const p = VENDOR_TO_PRESET[po.vendor] ?? VENDOR_TO_PRESET.other;
    reset({
      vendor_name:  p.name,
      vendor_gstin: p.gstin,
      bill_no:      "",
      bill_date:    today,
      due_date:     "",
      category:     p.category,
      subtotal:     monthly,
      cgst:         0,
      sgst:         0,
      igst:         0,
      total:        monthly,
      notes:        `From PO ${po.id} (${po.customer_name} · ${po.plan})`,
    });
  }, [po.id, po.total_cost, po.term_months, po.vendor, po.customer_name, po.plan, reset, today]);

  const subtotal = Number(watch("subtotal") || 0);
  const cgst     = Number(watch("cgst")     || 0);
  const sgst     = Number(watch("sgst")     || 0);
  const igst     = Number(watch("igst")     || 0);
  const total    = Number(watch("total")    || 0);

  const computedTotal = subtotal + cgst + sgst + igst;
  const totalMismatch = Math.abs(total - computedTotal) > 1 && total > 0;

  // Derived line item — what's actually being billed in this invoice
  // For a 12-month PO, monthly bill is 1/12 of total. We figure out the
  // implicit period from the subtotal: months = subtotal / (unit_cost × seats).
  const lineSeats   = po.seats;
  const monthsBilled = po.unit_cost_pm > 0 && lineSeats > 0
    ? +(subtotal / (po.unit_cost_pm * lineSeats)).toFixed(2)
    : 1;
  const lineRate    = lineSeats > 0 ? Math.round(subtotal / lineSeats) : 0;
  const monthsLabel = monthsBilled === 1
    ? "1 month portion"
    : monthsBilled > 0 && monthsBilled < 1
      ? `${Math.round(monthsBilled * 30)}-day portion`
      : `${monthsBilled} month portion`;

  function applyGST18Intra() {
    const half = Math.round(subtotal * 0.09);
    setValue("cgst", half);
    setValue("sgst", half);
    setValue("igst", 0);
    setValue("total", subtotal + half * 2);
  }
  function applyGST18Inter() {
    const igstAmt = Math.round(subtotal * 0.18);
    setValue("cgst", 0);
    setValue("sgst", 0);
    setValue("igst", igstAmt);
    setValue("total", subtotal + igstAmt);
  }

  async function onSubmit(values: FormData) {
    try {
      // Step 1 — create vendor bill
      const bill = await createBill.mutateAsync({
        vendor_name:  values.vendor_name,
        vendor_gstin: values.vendor_gstin || null,
        bill_no:      values.bill_no,
        bill_date:    values.bill_date,
        due_date:     values.due_date || null,
        category:     values.category,
        subtotal:     Math.round(values.subtotal),
        cgst:         Math.round(values.cgst),
        sgst:         Math.round(values.sgst),
        igst:         Math.round(values.igst),
        total:        Math.round(values.total),
        notes:        values.notes || null,
        status:       "unpaid",
        line_items:   [{
          name:   `${po.plan} · ${monthsLabel}${po.domain ? ` · ${po.domain}` : ""}`,
          qty:    lineSeats,
          rate:   lineRate,                     // ₹ per seat for this billing period
          amount: Math.round(values.subtotal),  // pre-GST line amount
        }],
      });

      // Step 2 — auto-allocate the full bill amount to this PO
      await allocate.mutateAsync({
        purchase_order_id: po.id,
        vendor_bill_id:    bill.id,
        allocated_amount:  Math.round(values.total),
        notes:             `Auto-allocated from CreateBillFromPO wizard`,
      });

      toast.success(`Bill ${bill.bill_no ?? bill.id} created + matched to ${po.id}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create vendor bill from PO</DialogTitle>
          <DialogDescription>
            Pre-filled from <span className="font-mono">{po.id}</span>. Verify amounts against the actual{" "}
            {po.vendor === "google" ? "Google CSP" : po.vendor} invoice before saving. The bill will be auto-matched to this PO.
          </DialogDescription>
        </DialogHeader>

        {/* Context strip — PO summary for reference */}
        <div className="bg-paper-2 rounded-md p-3 grid grid-cols-3 gap-3 text-xs mb-2">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">PO expected</p>
            <p className="font-medium text-ink tabular-nums">{rupee(po.total_cost)}</p>
            <p className="text-[10px] text-ink-3">{po.term_months} months × {po.seats} seats</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Monthly suggest</p>
            <p className="font-medium text-ink tabular-nums">{rupee(suggestedMonthly)}</p>
            <p className="text-[10px] text-ink-3">total ÷ {po.term_months}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Customer</p>
            <p className="font-medium text-ink truncate">{po.customer_name}</p>
            {po.domain && <p className="text-[10px] text-ink-3 font-mono truncate">{po.domain}</p>}
          </div>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Vendor name" required htmlFor="vendor_name">
              <Input id="vendor_name" error={errors.vendor_name?.message} {...register("vendor_name")} />
            </FormField>
            <FormField label="Vendor GSTIN" htmlFor="vendor_gstin">
              <Input id="vendor_gstin" placeholder="e.g. 27ABCDE1234F1Z5" {...register("vendor_gstin")} />
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="Bill # (vendor's)" required htmlFor="bill_no">
              <Input id="bill_no" placeholder="e.g. GW-INV-12345" error={errors.bill_no?.message} {...register("bill_no")} />
            </FormField>
            <FormField label="Bill date" required htmlFor="bill_date">
              <Input id="bill_date" type="date" error={errors.bill_date?.message} {...register("bill_date")} />
            </FormField>
            <FormField label="Due date" htmlFor="due_date">
              <Input id="due_date" type="date" {...register("due_date")} />
            </FormField>
          </div>

          <FormField label="Category" required htmlFor="category">
            <Input id="category" {...register("category")} />
          </FormField>

          {/* Items billed — derived from PO + form subtotal */}
          <div className="rounded-lg border border-hairline overflow-hidden">
            <div className="bg-paper-2/60 px-3 py-2 flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
                Items billed
              </p>
              <p className="text-[10px] text-ink-3">
                Auto-derived from PO + subtotal · adjust subtotal to change billing period
              </p>
            </div>
            <table className="w-full text-xs">
              <thead className="bg-paper-2/30 text-ink-3">
                <tr>
                  <th className="text-left px-3 py-1.5 font-semibold uppercase tracking-wider">Item</th>
                  <th className="text-right px-3 py-1.5 font-semibold uppercase tracking-wider">Qty (seats)</th>
                  <th className="text-right px-3 py-1.5 font-semibold uppercase tracking-wider">Rate / seat</th>
                  <th className="text-right px-3 py-1.5 font-semibold uppercase tracking-wider">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-hairline">
                  <td className="px-3 py-2 text-ink">
                    <div className="font-medium">{po.plan}</div>
                    <div className="text-[10px] text-ink-3 mt-0.5">
                      {monthsLabel}
                      {po.domain && <> · {po.domain}</>}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{lineSeats}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{rupee(lineRate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{rupee(subtotal)}</td>
                </tr>
              </tbody>
              <tfoot className="bg-paper-2/30">
                <tr className="border-t border-hairline">
                  <td colSpan={3} className="px-3 py-1.5 text-right text-ink-3">
                    Pre-GST line total
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium text-ink">
                    {rupee(subtotal)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Amounts */}
          <div className="p-3 rounded-lg border border-hairline bg-paper-2/30 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Amounts (₹)</p>
              <div className="flex gap-1.5">
                <button type="button" onClick={applyGST18Intra} className="text-[10px] px-2 py-0.5 rounded border border-hairline text-ink-3 hover:text-ink">
                  + GST 18% (intra)
                </button>
                <button type="button" onClick={applyGST18Inter} className="text-[10px] px-2 py-0.5 rounded border border-hairline text-ink-3 hover:text-ink">
                  + GST 18% (inter)
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <FormField label="Subtotal" required htmlFor="subtotal">
                <Input id="subtotal" type="number" min={0} step={1} error={errors.subtotal?.message} {...register("subtotal")} className="font-mono" />
              </FormField>
              <FormField label="CGST" htmlFor="cgst">
                <Input id="cgst" type="number" min={0} step={1} {...register("cgst")} className="font-mono" />
              </FormField>
              <FormField label="SGST" htmlFor="sgst">
                <Input id="sgst" type="number" min={0} step={1} {...register("sgst")} className="font-mono" />
              </FormField>
              <FormField label="IGST" htmlFor="igst">
                <Input id="igst" type="number" min={0} step={1} {...register("igst")} className="font-mono" />
              </FormField>
            </div>
            <FormField label="Total (must match vendor bill)" required htmlFor="total">
              <Input id="total" type="number" min={0} step={1} error={errors.total?.message} {...register("total")} className="font-mono" />
            </FormField>
            {totalMismatch && (
              <p className="text-[11px] text-amber-ink flex items-center gap-1.5">
                ⚠️ Total ({rupee(total)}) doesn't match computed ({rupee(computedTotal)}). Check your numbers.
              </p>
            )}
          </div>

          <FormField label="Notes" htmlFor="notes">
            <Textarea id="notes" rows={2} {...register("notes")} />
          </FormField>

          {/* Allocation preview */}
          <div className="bg-emerald/5 border border-emerald/20 rounded-md p-3 text-xs flex items-center justify-between gap-3">
            <div>
              <p className="font-medium text-ink">Will auto-allocate {rupee(total)} to {po.id}</p>
              <p className="text-[10px] text-ink-3 mt-0.5">
                After save, no manual "Match bill" step needed. Variance updates immediately.
              </p>
            </div>
            <Badge kind="success" size="sm" dot>1-click</Badge>
          </div>

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" icon="check" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save bill + match to PO"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
