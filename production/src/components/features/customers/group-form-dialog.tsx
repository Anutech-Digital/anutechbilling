/**
 * GroupFormDialog — create or edit a Customer Group / Parent Account.
 *
 * A group is the umbrella that links several customer companies routed by one
 * common reseller/coordinator. Reporting layer only — billing stays per-company.
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useCreateCustomerGroup, useUpdateCustomerGroup } from "@/lib/queries/customer-groups";
import type { CustomerGroup } from "@/lib/supabase/database.types";

const schema = z.object({
  name:          z.string().min(1, "Group name is required"),
  contact_name:  z.string().optional(),
  contact_email: z.string().email("Invalid email").optional().or(z.literal("")),
  contact_phone: z.string().optional(),
  is_partner:    z.boolean(),
  notes:         z.string().optional(),
});
type FormData = z.infer<typeof schema>;

export function GroupFormDialog({
  open,
  onOpenChange,
  group,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass to edit an existing group; omit to create a new one. */
  group?: CustomerGroup | null;
  onSaved?: (group: CustomerGroup) => void;
}) {
  const create = useCreateCustomerGroup();
  const update = useUpdateCustomerGroup();
  const isEdit = Boolean(group);

  const { register, handleSubmit, reset, setValue, watch, formState: { errors } } =
    useForm<FormData>({
      resolver: zodResolver(schema),
      defaultValues: { name: "", contact_name: "", contact_email: "", contact_phone: "", is_partner: false, notes: "" },
    });

  // Re-seed the form whenever the dialog opens (new blank vs edit).
  React.useEffect(() => {
    if (!open) return;
    reset({
      name:          group?.name ?? "",
      contact_name:  group?.contact_name ?? "",
      contact_email: group?.contact_email ?? "",
      contact_phone: group?.contact_phone ?? "",
      is_partner:    group?.is_partner ?? false,
      notes:         group?.notes ?? "",
    });
  }, [open, group, reset]);

  const isPartner = watch("is_partner");

  const onSubmit = async (data: FormData) => {
    const payload = {
      name:          data.name.trim(),
      contact_name:  data.contact_name?.trim() || null,
      contact_email: data.contact_email?.trim() || null,
      contact_phone: data.contact_phone?.trim() || null,
      is_partner:    data.is_partner,
      notes:         data.notes?.trim() || null,
    };
    try {
      const saved = isEdit
        ? await update.mutateAsync({ id: group!.id, patch: payload })
        : await create.mutateAsync(payload);
      toast.success(isEdit ? "Group updated" : `Group "${saved.name}" created`);
      onOpenChange(false);
      onSaved?.(saved);
    } catch {
      /* hook toasts the error */
    }
  };

  const saving = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit group" : "New parent account / group"}</DialogTitle>
          <DialogDescription>
            Link companies routed by one common reseller or coordinator. Each company still
            keeps its own GSTIN and gets its own invoices — this is only a relationship view.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField label="Group / reseller name" required htmlFor="grp-name">
            <Input id="grp-name" placeholder="e.g. Rajesh — multi-company reseller" error={errors.name?.message} {...register("name")} />
          </FormField>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Contact person" htmlFor="grp-cname">
              <Input id="grp-cname" placeholder="Common point of contact" {...register("contact_name")} />
            </FormField>
            <FormField label="Contact phone" htmlFor="grp-cphone">
              <Input id="grp-cphone" placeholder="+91 …" {...register("contact_phone")} />
            </FormField>
          </div>

          <FormField label="Contact email" htmlFor="grp-cemail">
            <Input id="grp-cemail" type="email" placeholder="e.g. name@example.com" error={errors.contact_email?.message} {...register("contact_email")} />
          </FormField>

          <div className="flex items-start gap-2.5 rounded-lg border border-hairline p-3">
            <Checkbox
              id="grp-partner"
              checked={isPartner}
              onCheckedChange={(v) => setValue("is_partner", v === true)}
            />
            <div className="space-y-0.5">
              <Label htmlFor="grp-partner">This reseller also earns a commission</Label>
              <p className="text-xs text-ink-3">
                Marks them as a channel partner. Add the actual per-deal commission from
                each company&apos;s Referrals — this flag is just a reminder.
              </p>
            </div>
          </div>

          <FormField label="Notes" htmlFor="grp-notes">
            <Textarea id="grp-notes" rows={2} placeholder="Anything worth remembering about this relationship…" {...register("notes")} />
          </FormField>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={saving} disabled={saving}>
              {isEdit ? "Save changes" : "Create group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
