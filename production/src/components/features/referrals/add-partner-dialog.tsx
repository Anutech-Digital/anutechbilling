/**
 * AddPartnerDialog — R-472. Add a referral partner straight from the Referrals page.
 *
 * Before, a partner could only be created from a customer's "Add referral" sheet, and the
 * Referrals → Partners tab had no button at all. This saves the partner with their default
 * terms; tag them on a customer's deal later (customer → Add referral).
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useCreatePartner } from "@/lib/queries/referral-partners";
import { panProblem, normalisePan, commissionPercentProblem } from "@/lib/referrals/partner-fields";

export function AddPartnerDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const createPartner = useCreatePartner();
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [pan, setPan] = React.useState("");
  const [percent, setPercent] = React.useState("");
  const [deductTds, setDeductTds] = React.useState(false);
  const [tried, setTried] = React.useState(false);

  React.useEffect(() => {
    if (open) { setName(""); setPhone(""); setPan(""); setPercent(""); setDeductTds(false); setTried(false); }
  }, [open]);

  const nameErr = name.trim() ? null : "Enter the partner's name.";
  const panErr = panProblem(pan);
  const pctErr = commissionPercentProblem(percent);

  async function submit() {
    setTried(true);
    if (nameErr || panErr || pctErr) {
      toast.error("Check the highlighted fields.", { description: nameErr ?? panErr ?? pctErr ?? undefined });
      return;
    }
    try {
      await createPartner.mutateAsync({
        name: name.trim(),
        phone: phone.trim() || null,
        pan: normalisePan(pan) || null,
        default_basis: "percent",
        default_percent: Number(percent),
        deduct_tds: deductTds,
      });
      onOpenChange(false);
    } catch {
      /* toast handled in the hook */
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="!p-5 border-b border-hairline">
          <SheetTitle>Add partner</SheetTitle>
          <SheetDescription>
            Someone who brings you customers. To pay them on a deal, open the customer and press “Add referral”.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <FormField label="Name" required htmlFor="ap_name">
            <Input id="ap_name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rakesh Verma"
                   error={tried ? nameErr ?? undefined : undefined} />
          </FormField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Phone (optional)" htmlFor="ap_phone">
              <Input id="ap_phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" />
            </FormField>
            <FormField label="PAN (for TDS)" htmlFor="ap_pan">
              <Input id="ap_pan" value={pan} onChange={(e) => setPan(e.target.value.toUpperCase())} placeholder="e.g. ABCDE1234F" maxLength={12}
                     error={tried || pan.trim().length >= 10 ? panErr ?? undefined : undefined} />
            </FormField>
          </div>
          <FormField label="Default commission" required htmlFor="ap_pct">
            <Input id="ap_pct" type="text" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value.replace(/[^\d.]/g, ""))}
                   placeholder="10" suffix="% of deal" error={tried ? pctErr ?? undefined : undefined} />
          </FormField>
          <label className="flex items-center gap-2 text-sm text-ink cursor-pointer">
            <input type="checkbox" checked={deductTds} onChange={(e) => setDeductTds(e.target.checked)} className="h-4 w-4 rounded border-hairline text-amber focus:ring-amber/40" />
            Deduct 2% TDS (194H)
          </label>
        </div>
        <SheetFooter className="!p-5 border-t border-hairline">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon="check" loading={createPartner.isPending} onClick={submit}>Save partner</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
