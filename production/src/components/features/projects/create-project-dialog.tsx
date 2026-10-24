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
import { CustomerCombobox } from "@/components/features/customers/customer-combobox";
import { AddCustomerForm } from "@/components/features/customers/add-customer-form";
import { useCustomers } from "@/lib/queries/customers";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isInterStateSupply } from "@/lib/gst/place-of-supply";
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

  /* R-002 (Pardeep, 25 Sep 2026). This was a free-text `customerName`, saved with
     `customerId: null`. Three things followed: the sale never appeared in that
     customer's Ledger or Aging, "Demo Co" quietly became a different party from
     "Demo Co", and the tax head came from a checkbox instead of from the
     customer's state. The id is the record now; the name is read off it. */
  const [customerId, setCustomerId]     = React.useState("");
  const [addCustomerOpen, setAddCustomerOpen] = React.useState(false);
  /* Set once the operator ticks the box themselves. Until then the checkbox follows
     the customer, so choosing a Karnataka customer while you are in Delhi flips it to
     IGST without anybody having to know the rule — and an explicit tick is never
     overwritten afterwards. */
  const [interStateTouched, setInterStateTouched] = React.useState(false);
  const [title, setTitle]               = React.useState("");
  const [description, setDescription]   = React.useState("");
  const [taxable, setTaxable]           = React.useState("");
  const [gstRate, setGstRate]           = React.useState("18");
  const [interState, setInterState]     = React.useState(false);
  const [rows, setRows]                 = React.useState<Row[]>(BLANK_ROWS);

  React.useEffect(() => {
    if (!open) {
      setCustomerId(""); setTitle(""); setDescription("");
      setTaxable(""); setGstRate("18"); setInterState(false); setRows(BLANK_ROWS);
      setInterStateTouched(false);
    }
  }, [open]);

  const { data: customers } = useCustomers();
  const { data: me } = useCurrentUser();
  const selectedCustomer = customers?.find((c) => c.id === customerId);
  const customerName = selectedCustomer?.name ?? "";

  /* Follow the customer until the operator overrides. Both GSTINs are passed because
     36 of 41 customers holding a GSTIN have no state_code, and the first two characters
     of a GSTIN are the state — see lib/gst/place-of-supply.ts. */
  React.useEffect(() => {
    if (interStateTouched || !selectedCustomer) return;
    setInterState(isInterStateSupply(
      selectedCustomer.state_code,
      me?.tenantStateCode,
      { customerGstin: selectedCustomer.gstin, sellerGstin: me?.tenantGstin, treatment: selectedCustomer.gst_treatment },
    ));
  }, [selectedCustomer, me?.tenantStateCode, me?.tenantGstin, interStateTouched]);

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
    customerId !== "" &&
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
        // R-002: the real record, so the sale reaches the Ledger and Aging.
        customerId,
        customerName,
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
            <CustomerCombobox
              id="p_customer"
              value={customerId}
              onChange={setCustomerId}
              onCreateNew={() => setAddCustomerOpen(true)}
              placeholder="Search customers…"
            />
            <p className="text-3xs text-ink-3 mt-1">
              The sale is filed against this customer — it shows in their Ledger and Aging, and
              the tax head follows their state.
            </p>
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
            <input
              type="checkbox"
              checked={interState}
              onChange={(e) => { setInterStateTouched(true); setInterState(e.target.checked); }}
              className="rounded border-hairline"
            />
            Inter-state supply (IGST instead of CGST + SGST)
          </label>
          {/* Say where the tick came from. An unexplained tax head on a money document
              is one the operator has to verify by hand, which costs more than the
              pre-set saved — the same reasoning as the quote builder's match note. */}
          {selectedCustomer && !interStateTouched && (
            <p className="text-3xs text-ink-3 -mt-2">
              {me?.tenantStateCode
                ? <>Set from {selectedCustomer.name}&apos;s state{selectedCustomer.state ? ` (${selectedCustomer.state})` : ""} against yours. Change it if that is wrong.</>
                : <>Your company&apos;s state is not set, so this defaults to intra-state. Set it in Settings → GST profile to have it decided for you.</>}
            </p>
          )}

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
              <button type="button" onClick={addRow} className="text-2xs text-amber-ink hover:underline inline-flex items-center gap-0.5">
                <Icon name="plus" size={12} /> Add
              </button>
            </div>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input className="flex-1" aria-label={`Milestone ${i + 1} label`} placeholder="Label" value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
                  <Input className="w-28" aria-label={`Milestone ${i + 1} amount`} inputMode="numeric" prefix="₹" placeholder="0" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} />
                  <Input className="w-36" aria-label={`Milestone ${i + 1} due date`} type="date" value={r.due} onChange={(e) => setRow(i, { due: e.target.value })} />
                  <button type="button" aria-label="Remove" onClick={() => removeRow(i)} className="mt-2 text-ink-3 hover:text-rose">
                    <Icon name="x" size={16} />
                  </button>
                </div>
              ))}
            </div>
            <div className={`mt-2 text-2xs ${mismatch ? "text-rose" : "text-emerald"}`}>
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

      {/* "＋ New customer" from the picker. Same form the Customers page uses, so a
          customer created here gets its mandatory contact person like any other — and
          comes back selected rather than as a typed name. */}
      <AddCustomerForm
        open={addCustomerOpen}
        onOpenChange={setAddCustomerOpen}
        onCreated={(newId) => setCustomerId(newId)}
      />
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
