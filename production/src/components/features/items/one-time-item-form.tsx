/**
 * OneTimeItemForm — add / edit a one-time (non-subscription) catalog item.
 *
 * One-time items are products/services sold as a one-off, not per-seat/month:
 * custom software, setup, data migration, AMC, hardware, consulting. They carry
 * a flat sale price + cost and an HSN/SAC code; GST is applied at quote/invoice
 * time (default 18%). Stored in the same `items` table with item_type='one_time'.
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useCreateItem, useUpdateItem } from "@/lib/queries/items";
import type { Item } from "@/lib/supabase/database.types";

const schema = z.object({
  name:      z.string().min(2, "Name required").max(120),
  msrp:      z.coerce.number().int().min(0, "Sale price ≥ 0"),
  wholesale: z.coerce.number().int().min(0).optional(),
  hsn:       z.string().optional(),
});
type FormData = z.infer<typeof schema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item?: Item | null;   // present → edit
}

function newOneTimeId(): string {
  return `OT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 46655).toString(36).toUpperCase()}`;
}

export function OneTimeItemForm({ open, onOpenChange, item }: Props) {
  const create = useCreateItem();
  const update = useUpdateItem();
  const isEdit = Boolean(item);

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { hsn: "998314" },
  });

  React.useEffect(() => {
    if (!open) return;
    reset(item
      ? { name: item.name, msrp: item.msrp, wholesale: item.wholesale, hsn: item.hsn ?? "998314" }
      : { name: "", msrp: 0, wholesale: 0, hsn: "998314" });
  }, [open, item, reset]);

  const onSubmit = async (data: FormData) => {
    const cost = Math.max(0, Math.round(data.wholesale ?? 0));
    const price = Math.max(0, Math.round(data.msrp));
    try {
      if (item) {
        await update.mutateAsync({
          id: item.id,
          patch: { name: data.name.trim(), msrp: price, wholesale: cost, hsn: data.hsn?.trim() || null },
        });
      } else {
        await create.mutateAsync({
          id:         newOneTimeId(),
          name:       data.name.trim(),
          vendor:     "other",
          kind:       "main",
          item_type:  "one_time",
          hsn:        data.hsn?.trim() || null,
          msrp:       price,
          wholesale:  cost,
          prices:     {},
          is_active:  true,
        });
      }
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[460px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>{isEdit ? "Edit item" : "Add one-time item"}</SheetTitle>
          <SheetDescription>
            A one-off product or service (custom software, setup, AMC, hardware…). Sold as a fixed amount, not per-seat/month.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
            <FormField label="Name" required htmlFor="ot_name">
              <Input id="ot_name" autoFocus placeholder="e.g. Custom software development" error={errors.name?.message} {...register("name")} />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField label="Sale price (₹)" required htmlFor="ot_msrp">
                <Input id="ot_msrp" inputMode="numeric" prefix="₹" placeholder="0" error={errors.msrp?.message} {...register("msrp")} />
                <p className="text-[10px] text-ink-3 mt-1">Default price — editable per deal/quote.</p>
              </FormField>
              <FormField label="Your cost (₹)" htmlFor="ot_cost">
                <Input id="ot_cost" inputMode="numeric" prefix="₹" placeholder="0" error={errors.wholesale?.message} {...register("wholesale")} />
                <p className="text-[10px] text-ink-3 mt-1">Optional — for margin.</p>
              </FormField>
            </div>

            <FormField label="HSN / SAC code" htmlFor="ot_hsn">
              <Input id="ot_hsn" className="font-mono" placeholder="e.g. 998314" {...register("hsn")} />
              <p className="text-[10px] text-ink-3 mt-1">
                998314 = IT software design & development. GST 18% applies at quote/invoice time.
              </p>
            </FormField>
          </div>

          <SheetFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={isSubmitting || create.isPending || update.isPending}>
              {isEdit ? "Save changes" : "Add item"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
