/** Balance Sheet → add / edit a hand-entered line — moved out of page.tsx (lint max-lines), no change. */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel } from "@/components/ui/select";
import { useCreateBalanceSheetItem, useUpdateBalanceSheetItem, type BalanceSheetItem } from "@/lib/queries/balance-sheet";
import type { BalanceSheetSection } from "@/lib/supabase/database.types";
import { equityLineCategories } from "@/lib/accounting/equity-section";
import { entityProfile } from "@/lib/compliance/entity";
import type { BusinessType } from "@/lib/compliance/obligations";

// ── Add manual line dialog ────────────────────────────────────────────────
export const SECTIONS: { value: BalanceSheetSection; label: string; examples: string }[] = [
  { value: "asset",     label: "Asset",     examples: "Fixed assets, deposits, investments" },
  { value: "liability", label: "Liability", examples: "Bank loan, unsecured loan, other dues" },
  { value: "equity",    label: "Equity",    examples: "Capital and reserves" },
];

// Guided categories for the Add-line dialog — a non-CA owner picks what a line
// *is*, and we file it under the correct section automatically. `contra` items
// (drawings, depreciation) reduce their side, so we store them as negative even
// if the owner types a positive number — removing the classic sign mistake.
type BSCategory = {
  value: string; label: string; section: BalanceSheetSection;
  examples: string; contra?: boolean;
};
export const CATEGORIES: BSCategory[] = [
  { value: "fixed_asset",     label: "Fixed asset",        section: "asset",     examples: "Laptop, furniture, vehicle, machinery" },
  { value: "current_asset",   label: "Deposit / advance",  section: "asset",     examples: "Security deposit, advance paid, investment" },
  { value: "depreciation",    label: "Depreciation (–)",   section: "asset",     examples: "Wear-down of a fixed asset — reduces its value", contra: true },
  { value: "long_term_loan",  label: "Long-term loan",     section: "liability", examples: "Bank term loan, vehicle / equipment loan" },
  { value: "short_term_due",  label: "Short-term due",     section: "liability", examples: "Unsecured loan, friend/family loan, other payable" },
];

/** R-1845: the equity choices follow the business type — a company gets Share capital / Securities premium, never Drawings. */
export function categoriesFor(type: BusinessType | null, hideDrawings: boolean): BSCategory[] {
  const equity = equityLineCategories(type)
    .filter((c) => !(hideDrawings && c.value === "drawings"))
    .map((c): BSCategory => ({ ...c, section: "equity" }));
  return [...CATEGORIES, ...equity];
}

export const schema = z.object({
  label:  z.string().min(2, "Name required"),
  amount: z.coerce.number().int(),
  notes:  z.string().optional(),
});
type FormData = z.infer<typeof schema>;

export function EditLineDialog({ item, onClose }: { item: BalanceSheetItem; onClose: () => void }) {
  const update = useUpdateBalanceSheetItem();
  const [label, setLabel] = React.useState(item.label);
  const [amount, setAmount] = React.useState(String(item.amount));

  async function submit() {
    const amt = Math.round(Number(amount));
    if (!label.trim() || !Number.isFinite(amt)) return;
    await update.mutateAsync({ id: item.id, label: label.trim(), amount: amt });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Edit line</DialogTitle>
          <DialogDescription>Update this manual balance-sheet line — e.g. reduce a loan balance after an EMI.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="balance-sheet-label" className="block text-xs font-medium text-ink-2 mb-1">Label</label>
            <Input id="balance-sheet-label" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
          </div>
          <div>
            <label htmlFor="balance-sheet-amount" className="block text-xs font-medium text-ink-2 mb-1">Amount (₹)</label>
            <Input id="balance-sheet-amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <p className="mt-1 text-xs text-ink-3">Negative allowed (e.g. depreciation, drawings).</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>Cancel</Button>
          <Button variant="primary" loading={update.isPending} disabled={!label.trim()} onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddLineDialog({ open, onClose, businessType, hideDrawings, onRecordDrawings }: {
  open: boolean; onClose: () => void; businessType: BusinessType | null;
  /** R-1839: drawings are recorded as dated entries (they move the bank / cash balance), not a lump line. */
  hideDrawings?: boolean; onRecordDrawings?: () => void;
}) {
  const create = useCreateBalanceSheetItem();
  const [categoryValue, setCategoryValue] = React.useState<string>("fixed_asset");
  const categories = categoriesFor(businessType, !!hideDrawings);

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { amount: 0 },
  });

  React.useEffect(() => { if (!open) { reset(); setCategoryValue("fixed_asset"); } }, [open, reset]);

  const category = categories.find((c) => c.value === categoryValue) ?? categories[0];

  const onSubmit = async (data: FormData) => {
    // File under the category's section; contra items (drawings/depreciation)
    // are stored negative so they reduce their side even if typed positive.
    const amt = category.contra ? -Math.abs(data.amount) : data.amount;
    await create.mutateAsync({
      section: category.section,
      label: data.label.trim(),
      amount: amt,
      notes: category.label,          // remember what kind of line this is
    });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Add balance-sheet line</DialogTitle>
          <DialogDescription>
            Add something the app doesn&apos;t track automatically — a fixed asset, a loan,
            capital, etc. Pick what it is and we&apos;ll file it correctly.
          </DialogDescription>
        </DialogHeader>
        {hideDrawings && onRecordDrawings && (
          <p className="text-xs text-ink-3 -mt-1">
            Money taken out for personal use?{" "}
            <button type="button" className="text-indigo underline" onClick={onRecordDrawings}>Record drawings</button>{" "}
            — with its date and account, so the bank or cash balance moves too.
          </p>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField label="What kind of line?" required htmlFor="bs-category">
            <Select value={categoryValue} onValueChange={setCategoryValue}>
              <SelectTrigger id="bs-category"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(["asset", "liability", "equity"] as BalanceSheetSection[]).map((sec) => {
                  const group = categories.filter((c) => c.section === sec);
                  const secLabel = SECTIONS.find((s) => s.value === sec)?.label ?? sec;
                  return (
                    <SelectGroup key={sec}>
                      <SelectLabel>{secLabel}</SelectLabel>
                      {group.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
            <p className="text-xs text-ink-3 mt-1">
              Goes under <b>{SECTIONS.find((s) => s.value === category.section)?.label}</b> · e.g. {category.examples}
            </p>
          </FormField>

          <FormField label="Name" required htmlFor="bs-label">
            <Input id="bs-label" placeholder={`e.g. Office laptop, HDFC term loan, ${entityProfile(businessType).capitalLabel}`} error={errors.label?.message} {...register("label")} />
          </FormField>

          <FormField label="Amount (₹)" required htmlFor="bs-amount">
            <Input id="bs-amount" type="number" prefix="₹" error={errors.amount?.message} {...register("amount")} />
            <p className="text-xs text-ink-3 mt-1">
              {category.contra
                ? "Just type the amount — we'll record it as a reduction automatically."
                : "Enter the current value / outstanding balance."}
            </p>
          </FormField>

          <DialogFooter>
            <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting || create.isPending}>Add line</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
