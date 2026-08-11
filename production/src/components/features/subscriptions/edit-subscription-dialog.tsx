/**
 * EditSubscriptionDialog — correct a subscription's details (data-entry fix).
 *
 * For fixing a mis-typed plan / vendor / seats / price / dates / status on a
 * subscription. It only updates the subscription record — it does NOT re-bill
 * or touch the linked payment / quote / invoice. To remove a whole subscription
 * that was created by mistake, use Delete (which is blocked when it came from a
 * paid quote — fix that at the source by deleting the payment).
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useUpdateSubscription } from "@/lib/queries/subscriptions";
import type { Subscription } from "@/lib/supabase/database.types";

const VENDORS: Subscription["vendor"][] = ["google", "microsoft", "zoho", "other"];
const STATUSES: Subscription["status"][] = ["active", "paused", "expired", "cancelled"];

export function EditSubscriptionDialog({
  sub, open, onOpenChange,
}: {
  sub: Subscription;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateSubscription();

  const [plan, setPlan]       = React.useState(sub.plan);
  const [vendor, setVendor]   = React.useState<Subscription["vendor"]>(sub.vendor);
  const [seats, setSeats]     = React.useState(String(sub.seats));
  const [mrr, setMrr]         = React.useState(String(sub.mrr));
  const [startDate, setStart] = React.useState(sub.start_date ?? "");
  const [renewal, setRenewal] = React.useState(sub.renewal_date ?? "");
  const [status, setStatus]   = React.useState<Subscription["status"]>(sub.status);

  // Re-seed when a different subscription is opened.
  React.useEffect(() => {
    setPlan(sub.plan); setVendor(sub.vendor); setSeats(String(sub.seats));
    setMrr(String(sub.mrr)); setStart(sub.start_date ?? ""); setRenewal(sub.renewal_date ?? "");
    setStatus(sub.status);
  }, [sub]);

  const save = async () => {
    try {
      await update.mutateAsync({
        id: sub.id,
        patch: {
          plan: plan.trim() || sub.plan,
          vendor,
          seats: Math.max(0, Math.round(Number(seats) || 0)),
          mrr:   Math.max(0, Math.round(Number(mrr) || 0)),
          start_date:   startDate || null,
          renewal_date: renewal || null,
          status,
        },
      });
      onOpenChange(false);
    } catch { /* hook toasts */ }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Correct subscription</DialogTitle>
          <DialogDescription>
            Fix mis-typed details on {sub.customer_name}&apos;s subscription. This corrects the
            record only — it doesn&apos;t re-bill or change the linked payment / invoice.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Plan" htmlFor="sub_plan">
            <Input id="sub_plan" value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="e.g. Google Workspace Business Starter" />
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Vendor" htmlFor="sub_vendor">
              <Select value={vendor} onValueChange={(v) => setVendor(v as Subscription["vendor"])}>
                <SelectTrigger id="sub_vendor"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {VENDORS.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Status" htmlFor="sub_status">
              <Select value={status} onValueChange={(v) => setStatus(v as Subscription["status"])}>
                <SelectTrigger id="sub_status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Seats" htmlFor="sub_seats">
              <Input id="sub_seats" type="number" min={0} step={1} value={seats} onChange={(e) => setSeats(e.target.value)} />
            </FormField>
            <FormField label="MRR (₹ / month)" htmlFor="sub_mrr">
              <Input id="sub_mrr" type="number" min={0} step={1} value={mrr} onChange={(e) => setMrr(e.target.value)} />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Start date" htmlFor="sub_start">
              <Input id="sub_start" type="date" value={startDate} onChange={(e) => setStart(e.target.value)} />
            </FormField>
            <FormField label="Renewal date" htmlFor="sub_renewal">
              <Input id="sub_renewal" type="date" value={renewal} onChange={(e) => setRenewal(e.target.value)} />
            </FormField>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="default" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" loading={update.isPending} onClick={save}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
