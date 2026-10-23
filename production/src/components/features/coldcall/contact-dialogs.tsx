"use client";
/**
 * Cold Calling (R-1663, Abhishek 21 Oct 2026): add one number by hand, and edit a number's
 * details — the same checks as a file import (no repeats, not someone already in Sales) apply
 * to the one you add.
 */
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  ColdCallError, useImportList, useUpdateContact, type ColdContact,
} from "@/lib/queries/cold-calling";

interface Fields { phone: string; name: string; company: string; city: string; dnd: boolean }

function failToast(err: unknown, fallback: string) {
  if (err instanceof ColdCallError) toast.error(err.message, { description: err.detail ?? "Try again in a moment." });
  else toast.error(fallback, { description: "Check your internet connection and try again." });
}

/** A CSV cell, quoted when it holds a comma or a quote. */
function cell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function ContactFields({ value, onChange, idPrefix }: {
  value: Fields; onChange: (f: Fields) => void; idPrefix: string;
}) {
  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <label htmlFor={`${idPrefix}-phone`} className="block text-sm font-medium text-ink mb-1.5">Phone *</label>
        <Input id={`${idPrefix}-phone`} value={value.phone} onChange={set("phone")} placeholder="98765 43210" inputMode="tel" autoFocus />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-name`} className="block text-sm font-medium text-ink mb-1.5">Name</label>
        <Input id={`${idPrefix}-name`} value={value.name} onChange={set("name")} placeholder="Rahul Sharma" />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-company`} className="block text-sm font-medium text-ink mb-1.5">Company</label>
        <Input id={`${idPrefix}-company`} value={value.company} onChange={set("company")} placeholder="Sharma Traders" />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-city`} className="block text-sm font-medium text-ink mb-1.5">City</label>
        <Input id={`${idPrefix}-city`} value={value.city} onChange={set("city")} placeholder="Delhi" />
      </div>
      <label htmlFor={`${idPrefix}-dnd`} className="flex items-center gap-2 text-sm text-ink self-end pb-2">
        <Checkbox id={`${idPrefix}-dnd`} checked={value.dnd} onCheckedChange={(v) => onChange({ ...value, dnd: v === true })} />
        DND — never call this number
      </label>
    </div>
  );
}

const EMPTY: Fields = { phone: "", name: "", company: "", city: "", dnd: false };

export function AddContactDialog({ open, campaignId, onClose }: { open: boolean; campaignId: string; onClose: () => void }) {
  const importList = useImportList();
  const [f, setF] = React.useState<Fields>(EMPTY);
  React.useEffect(() => { if (open) setF(EMPTY); }, [open]);

  const add = async (force: boolean) => {
    if (!f.phone.trim()) { toast.error("Enter a phone number.", { description: "A 10-digit mobile or a +91 number." }); return; }
    const csv = "Phone,Name,Company,City,DND\n" + [f.phone, f.name, f.company, f.city, f.dnd ? "Yes" : ""].map((v) => cell(v.trim())).join(",");
    try {
      const r = await importList.mutateAsync({ id: campaignId, csv, force: force ? [f.phone.trim()] : undefined });
      if (r.added === 1) {
        toast.success("Number added", { description: f.dnd ? "Marked DND — it will not be called." : "It will be called with the rest of the list." });
        onClose();
        return;
      }
      const skipped = r.alreadyCalled[0] ?? r.alreadyInSales[0];
      if (r.alreadyOnList) {
        toast.error("This number is already on this list.", { description: "Look for it in the list below." });
      } else if (skipped) {
        toast.error("Not added — this person was reached before.", {
          description: skipped.reason,
          action: { label: "Add anyway", onClick: () => { void add(true); } },
        });
      } else {
        toast.error("That phone number could not be read.", { description: "Use a 10-digit mobile or a +91 number." });
      }
    } catch (err) { failToast(err, "Could not add the number."); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add one number</DialogTitle>
          <DialogDescription>Only the phone is needed. The agent calls it with the rest of the list.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void add(false); }} className="space-y-4">
          <ContactFields value={f} onChange={setF} idPrefix="cc-add" />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" icon="plus" loading={importList.isPending}>Add number</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditContactDialog({ open, contact: c, onClose }: { open: boolean; contact: ColdContact; onClose: () => void }) {
  const update = useUpdateContact();
  const initial = React.useMemo<Fields>(() => ({
    phone: c.phone, name: c.name ?? "", company: c.company ?? "", city: c.city ?? "", dnd: c.status === "skipped_dnd",
  }), [c]);
  const [f, setF] = React.useState<Fields>(initial);
  React.useEffect(() => { if (open) setF(initial); }, [open, initial]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.phone.trim()) { toast.error("Enter a phone number.", { description: "A 10-digit mobile or a +91 number." }); return; }
    try {
      await update.mutateAsync({
        id: c.id,
        ...(f.phone.trim() !== c.phone ? { phone: f.phone.trim() } : {}),
        name: f.name, company: f.company, city: f.city, dnd: f.dnd,
      });
      toast.success("Saved", { description: f.dnd ? "Marked DND — it will not be called." : "The agent uses the new details on the next call." });
      onClose();
    } catch (err) { failToast(err, "Could not save the changes."); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit number</DialogTitle>
          <DialogDescription>Fix the name, company, city or phone, or mark it DND.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <ContactFields value={f} onChange={setF} idPrefix={`cc-edit-${c.id}`} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={update.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
