/**
 * CreateProjectDialog — set up a one-time / project sale with milestones.
 *
 * The operator enters the taxable contract value + GST rate; GST and total are
 * computed live. Milestones are GST-inclusive installment amounts (what the
 * customer actually pays each time) — their sum should equal the project total,
 * and the dialog nudges if it doesn't.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";

import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCreateProjectSale, type MilestoneInput } from "@/lib/queries/projects";
import { rupee } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Row = { label: string; amount: string; due: string };

const BLANK_ROWS: Row[] = [
  { label: "Advance", amount: "", due: "" },
  { label: "On delivery", amount: "", due: "" },
];

export function CreateProjectDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const create = useCreateProjectSale();

  const [customerName, setCustomerName] = React.useState("");
  const [title, setTitle]               = React.useState("");
  const [description, setDescription]   = React.useState("");
  const [taxable, setTaxable]           = React.useState("");
  const [gstRate, setGstRate]           = React.useState("18");
  const [interState, setInterState]     = React.useState(false);
  const [rows, setRows]                 = React.useState<Row[]>(BLANK_ROWS);

  React.useEffect(() => {
    if (!open) {
      setCustomerName(""); setTitle(""); setDescription("");
      setTaxable(""); setGstRate("18"); setInterState(false); setRows(BLANK_ROWS);
    }
  }, [open]);

  const taxableNum = Math.max(0, Math.round(Number(taxable) || 0));
  const rateNum    = Math.max(0, Math.round(Number(gstRate) || 0));
  const gstNum     = Math.round(taxableNum * rateNum / 100);
  const totalNum   = taxableNum + gstNum;

  const milestonesTotal = rows.reduce((s, r) => s + Math.max(0, Math.round(Number(r.amount) || 0)), 0);
  const mismatch = milestonesTotal !== totalNum;

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((rs) => {
    const sum = rs.reduce((s, r) => s + Math.max(0, Math.round(Number(r.amount) || 0)), 0);
    const remaining = Math.max(0, totalNum - sum);
    return [...rs, { label: `Milestone ${rs.length + 1}`, amount: remaining > 0 ? String(remaining) : "", due: "" }];
  });
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));

  const canSubmit =
    customerName.trim().length >= 2 &&
    title.trim().length >= 2 &&
    taxableNum > 0 &&
    rows.some((r) => Math.round(Number(r.amount) || 0) > 0) &&
    !create.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    const milestones: MilestoneInput[] = rows
      .filter((r) => Math.round(Number(r.amount) || 0) > 0)
      .map((r) => ({
        label:        r.label.trim() || "Milestone",
        total_amount: Math.round(Number(r.amount) || 0),
        due_date:     r.due || null,
      }));
    try {
      const id = await create.mutateAsync({
        customerId:   null,
        customerName: customerName.trim(),
        title:        title.trim(),
        description:  description.trim() || null,
        taxable:      taxableNum,
        gstRate:      rateNum,
        interState,
        milestones,
      });
      onOpenChange(false);
      router.push(`/projects/${id}` as Route);
    } catch { /* hook toasts */ }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[560px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>New project sale</SheetTitle>
          <SheetDescription>
            A one-time sale (e.g. custom software) billed in milestones. No subscription or renewal is created.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <FormField label="Customer" required htmlFor="p_customer">
            <Input id="p_customer" autoFocus placeholder="e.g. Excel Technologies" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
          </FormField>

          <FormField label="Project title" required htmlFor="p_title">
            <Input id="p_title" placeholder="e.g. Custom accounting software" value={title} onChange={(e) => setTitle(e.target.value)} />
          </FormField>

          <FormField label="Description" htmlFor="p_desc">
            <textarea
              id="p_desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Scope / notes (optional)"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
            />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Contract value (taxable ₹)" required htmlFor="p_taxable">
              <Input id="p_taxable" inputMode="numeric" prefix="₹" placeholder="e.g. 2200000" value={taxable} onChange={(e) => setTaxable(e.target.value)} />
            </FormField>
            <FormField label="GST rate %" htmlFor="p_gst">
              <Input id="p_gst" inputMode="numeric" placeholder="18" value={gstRate} onChange={(e) => setGstRate(e.target.value)} />
            </FormField>
          </div>

          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={interState} onChange={(e) => setInterState(e.target.checked)} className="rounded border-hairline" />
            Inter-state supply (IGST instead of CGST + SGST)
          </label>

          {/* GST summary */}
          <div className="rounded-md border border-hairline bg-paper-2/40 p-3 text-sm space-y-1">
            <Line label="Taxable value" value={rupee(taxableNum)} />
            <Line label={`GST @ ${rateNum}% (SAC 998314)`} value={rupee(gstNum)} />
            <div className="border-t border-hairline pt-1 mt-1">
              <Line label="Total invoice value" value={rupee(totalNum)} strong />
            </div>
          </div>

          {/* Milestone editor */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink-2">Milestones (GST-inclusive amounts)</p>
              <button type="button" onClick={addRow} className="text-[11px] text-amber-ink hover:underline inline-flex items-center gap-0.5">
                <Icon name="plus" size={12} /> Add
              </button>
            </div>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input className="flex-1" placeholder="Label" value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
                  <Input className="w-28" inputMode="numeric" prefix="₹" placeholder="0" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} />
                  <Input className="w-36" type="date" value={r.due} onChange={(e) => setRow(i, { due: e.target.value })} />
                  <button type="button" aria-label="Remove" onClick={() => removeRow(i)} className="mt-2 text-ink-3 hover:text-rose">
                    <Icon name="x" size={16} />
                  </button>
                </div>
              ))}
            </div>
            <div className={`mt-2 text-[11px] ${mismatch ? "text-rose" : "text-emerald"}`}>
              Milestones total {rupee(milestonesTotal)} · {mismatch
                ? `should equal ${rupee(totalNum)} (off by ${rupee(Math.abs(totalNum - milestonesTotal))})`
                : "matches the total invoice value ✓"}
            </div>
          </div>
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" loading={create.isPending} disabled={!canSubmit} onClick={handleSubmit}>
            Create project
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? "text-ink font-semibold" : "text-ink-3"}>{label}</span>
      <span className={`font-mono ${strong ? "text-ink font-semibold" : "text-ink-2"}`}>{value}</span>
    </div>
  );
}
