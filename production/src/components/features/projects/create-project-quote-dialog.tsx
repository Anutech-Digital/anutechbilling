/**
 * CreateProjectQuoteDialog — build an itemised project quotation to send a
 * customer. Line items are picked from the one-time Items Catalog (or typed
 * custom); taxable = Σ line amounts, GST + total computed live. On save it
 * creates a project in 'quoted' status; the customer accepts via the public
 * link, which flips it to an active project.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { toast } from "sonner";

import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useItems } from "@/lib/queries/items";
import { useCustomers, useCreateCustomer } from "@/lib/queries/customers";
import { useCreateProjectQuote, useUpdateProjectQuote, useUpdateProjectFutureMilestones, useCreateProjectDirectInvoice, useProjectSale, type MilestoneInput, type ProjectQuoteLine, type ProjectSaleWithTotals } from "@/lib/queries/projects";
import { rupee } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this project quotation instead of creating. */
  editProject?: ProjectSaleWithTotals | null;
  /** When set (create mode), pre-selects this existing customer. */
  prefillCustomerId?: string | null;
  /** "invoice" → raise a direct project tax invoice on save (no milestones / no accept step). */
  mode?: "quote" | "invoice";
}

type LineRow = { name: string; qty: string; rate: string };
type MsRow   = { label: string; amount: string; due: string };

export function CreateProjectQuoteDialog({ open, onOpenChange, editProject, prefillCustomerId, mode = "quote" }: Props) {
  const router = useRouter();
  const isEdit = Boolean(editProject);
  const isInvoiceMode = mode === "invoice" && !isEdit;   // direct invoice (create only)
  const create = useCreateProjectQuote();
  const directInvoice = useCreateProjectDirectInvoice();
  const update = useUpdateProjectQuote();
  const updateFuture = useUpdateProjectFutureMilestones();
  const createCustomer = useCreateCustomer();
  const { data: editDetail } = useProjectSale(editProject?.id ?? null);
  const { data: allItems } = useItems();
  const { data: customers } = useCustomers();
  const oneTimeItems = React.useMemo(
    () => (allItems ?? []).filter((i) => i.item_type === "one_time" && i.is_active),
    [allItems],
  );

  // Customer: pick an existing one, or create a new one inline (""=new).
  const [customerId, setCustomerId]   = React.useState("");
  const [newName, setNewName]         = React.useState("");
  const [contactName, setContactName] = React.useState("");
  const [email, setEmail]             = React.useState("");
  const [phone, setPhone]             = React.useState("");
  const [gstin, setGstin]             = React.useState("");
  const [stateName, setStateName]     = React.useState("");
  const [title, setTitle]             = React.useState("");
  const [description, setDescription]   = React.useState("");
  const [gstRate, setGstRate]           = React.useState("18");
  const [interState, setInterState]     = React.useState(false);
  const [lines, setLines]               = React.useState<LineRow[]>([{ name: "", qty: "1", rate: "" }]);
  const [rows, setRows]                 = React.useState<MsRow[]>([{ label: "Advance", amount: "", due: "" }]);
  // A milestone due date is the invoice due date once that milestone is billed —
  // it must never fall before today (the invoice date), so the picker floors at today.
  const todayISO = new Date().toISOString().slice(0, 10);

  const prefilledFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!open) {
      prefilledFor.current = null;
      setCustomerId(""); setNewName(""); setContactName(""); setEmail(""); setPhone(""); setGstin(""); setStateName("");
      setTitle(""); setDescription(""); setGstRate("18"); setInterState(false);
      setLines([{ name: "", qty: "1", rate: "" }]); setRows([{ label: "Advance", amount: "", due: "" }]);
      return;
    }
    // Edit mode — prefill once, after the project's milestones have loaded.
    if (editProject && editDetail?.project && prefilledFor.current !== editProject.id) {
      prefilledFor.current = editProject.id;
      const p = editDetail.project;
      setCustomerId(p.customer_id ?? "");
      if (!p.customer_id) setNewName(p.customer_name);
      setTitle(p.title);
      setDescription(p.description ?? "");
      setGstRate(String(p.gst_rate));
      setInterState(p.inter_state);
      const li = (p.line_items ?? []) as ProjectQuoteLine[];
      setLines(li.length
        ? li.map((l) => ({ name: l.name, qty: String(l.qty), rate: String(l.rate) }))
        : [{ name: "", qty: "1", rate: "" }]);
      const ms   = editDetail.milestones ?? [];
      const pays = editDetail.payments ?? [];
      const locked = (m: { id: string; invoice_id: string | null }) =>
        Boolean(m.invoice_id) || pays.some((p) => p.milestone_id === m.id);
      // When some milestones are locked, only the un-locked ones are editable.
      const editable = ms.some(locked) ? ms.filter((m) => !locked(m)) : ms;
      setRows(editable.length
        ? editable.map((m) => ({ label: m.label, amount: String(m.total_amount), due: m.due_date ?? "" }))
        : [{ label: "Milestone", amount: "", due: "" }]);
    }
  }, [open, editProject, editDetail]);

  // Create mode: pre-select the customer we were opened for (e.g. from a
  // customer's page → "Add service" on the Project tab).
  React.useEffect(() => {
    if (open && !editProject && prefillCustomerId) setCustomerId(prefillCustomerId);
  }, [open, editProject, prefillCustomerId]);

  const isNewCustomer = customerId === "";
  const selectedCustomer = customers?.find((c) => c.id === customerId);
  const effectiveName = isNewCustomer ? newName.trim() : (selectedCustomer?.name ?? "");

  const lineAmount = (l: LineRow) => Math.max(0, Math.round(Number(l.qty) || 0)) * Math.max(0, Math.round(Number(l.rate) || 0));
  const taxableNum = lines.reduce((s, l) => s + lineAmount(l), 0);
  const rateNum    = Math.max(0, Math.round(Number(gstRate) || 0));
  const gstNum     = Math.round(taxableNum * rateNum / 100);
  const totalNum   = taxableNum + gstNum;
  const milestonesTotal = rows.reduce((s, r) => s + Math.max(0, Math.round(Number(r.amount) || 0)), 0);

  // A milestone is LOCKED once it's invoiced or paid — a GST document / receipt
  // is tied to it, so its amount can't change. When any milestone is locked the
  // contract total is fixed too (an invoice was issued against it); the operator
  // can only re-plan the *remaining* (un-locked) milestones.
  const detailMs   = editDetail?.milestones ?? [];
  const detailPays = editDetail?.payments ?? [];
  const isLocked   = React.useCallback(
    (m: { id: string; invoice_id: string | null }) =>
      Boolean(m.invoice_id) || detailPays.some((p) => p.milestone_id === m.id),
    [detailPays],
  );
  const lockedMs     = detailMs.filter(isLocked);
  const lockedSum    = lockedMs.reduce((s, m) => s + m.total_amount, 0);
  const partialLock  = isEdit && lockedMs.length > 0;

  // Editable rows must fill the remaining (total − locked) when partially locked.
  const scheduleTarget = partialLock ? Math.max(0, totalNum - lockedSum) : totalNum;
  const mismatch = milestonesTotal !== scheduleTarget;

  const setLine = (i: number, patch: Partial<LineRow>) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { name: "", qty: "1", rate: "" }]);
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, idx) => idx !== i));
  const pickItem = (i: number, itemId: string) => {
    const it = oneTimeItems.find((x) => x.id === itemId);
    if (it) setLine(i, { name: it.name, rate: String(it.msrp) });
  };

  const setRow = (i: number, patch: Partial<MsRow>) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  // New milestone auto-fills with the leftover (total − scheduled so far), so the
  // schedule balances to the total without manual maths.
  const addRow = () => setRows((rs) => {
    const sum = rs.reduce((s, r) => s + Math.max(0, Math.round(Number(r.amount) || 0)), 0);
    const remaining = Math.max(0, totalNum - sum);
    return [...rs, { label: `Milestone ${rs.length + 1}`, amount: remaining > 0 ? String(remaining) : "", due: "" }];
  });
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, idx) => idx !== i));

  const canSubmit =
    effectiveName.length >= 2 && title.trim().length >= 2 &&
    lines.some((l) => l.name.trim() && lineAmount(l) > 0) &&
    // A direct invoice has no milestone schedule (single full invoice).
    (isInvoiceMode || rows.some((r) => Math.round(Number(r.amount) || 0) > 0)) &&
    // In partial-lock mode the remaining schedule must balance exactly.
    (isInvoiceMode || !partialLock || !mismatch) &&
    !create.isPending && !createCustomer.isPending && !update.isPending && !updateFuture.isPending && !directInvoice.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    // Guard: a milestone's due date can't precede today (its invoice date).
    // Prevents invoices like "Invoice 23 Jul · Due 8 Jul".
    const badDue = rows.find((r) => r.due && r.due < todayISO && Math.round(Number(r.amount) || 0) > 0);
    if (badDue) {
      toast.error(`Due date for "${badDue.label || "milestone"}" can't be before today.`);
      return;
    }
    const lineItems: ProjectQuoteLine[] = lines
      .filter((l) => l.name.trim() && lineAmount(l) > 0)
      .map((l) => ({
        name:   l.name.trim(),
        qty:    Math.max(1, Math.round(Number(l.qty) || 1)),
        rate:   Math.max(0, Math.round(Number(l.rate) || 0)),
        amount: lineAmount(l),
      }));
    const milestones: MilestoneInput[] = rows
      .filter((r) => Math.round(Number(r.amount) || 0) > 0)
      .map((r) => ({ label: r.label.trim() || "Milestone", total_amount: Math.round(Number(r.amount) || 0), due_date: r.due || null }));
    try {
      // ── Edit existing quotation ──
      if (editProject) {
        if (partialLock) {
          // Contract is fixed — only the remaining (un-locked) milestones change.
          await updateFuture.mutateAsync({ projectId: editProject.id, milestones });
        } else {
          await update.mutateAsync({
            projectId: editProject.id, customerName: effectiveName, title: title.trim(),
            description: description.trim() || null, lineItems, gstRate: rateNum, interState, milestones,
          });
        }
        onOpenChange(false);
        return;
      }
      // ── Create new — a new customer is created first if needed ──
      let cid: string | null = customerId || null;
      let cname = effectiveName;
      if (isNewCustomer) {
        const cust = await createCustomer.mutateAsync({
          name:          newName.trim(),
          contact_name:  contactName.trim() || null,
          contact_email: email.trim() || null,
          contact_phone: phone.trim() || null,
          gstin:         gstin.trim() || null,
          state:         stateName.trim() || null,
        });
        cid = cust.id; cname = cust.name;
      }
      // Direct invoice: raise a one-shot tax invoice (create + accept + raise) —
      // no milestone schedule, no separate accept step.
      if (isInvoiceMode) {
        await directInvoice.mutateAsync({
          customerId: cid, customerName: cname, title: title.trim(),
          description: description.trim() || null, lineItems, gstRate: rateNum, interState,
        });
        onOpenChange(false);
        router.push("/invoices" as Route);
        return;
      }
      const id = await create.mutateAsync({
        customerId: cid, customerName: cname, title: title.trim(),
        description: description.trim() || null, lineItems, gstRate: rateNum, interState, milestones,
      });
      onOpenChange(false);
      router.push(`/projects/${id}` as Route);
    } catch { /* hook toasts */ }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-[600px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>{isEdit ? "Edit project quotation" : isInvoiceMode ? "New project invoice" : "New project quotation"}</SheetTitle>
          <SheetDescription>
            {isInvoiceMode
              ? "Itemised GST tax invoice for a one-time project — raised straight away (project becomes active, 30-din due)."
              : "Itemised quote for a one-time project. Send the customer the link — when they accept, it becomes an active project."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {partialLock && (
            <div className="rounded-md border border-amber/40 bg-amber-soft/40 p-3 text-sm space-y-1">
              <p className="font-semibold text-amber-ink flex items-center gap-1.5">
                <Icon name="lock" size={14} /> Contract is fixed — re-plan remaining only
              </p>
              <p className="text-ink-2">
                {rupee(lockedSum)} is already invoiced/paid, so the customer, items and total
                can&apos;t change. You can still re-plan the remaining {rupee(scheduleTarget)} across
                the milestones below.
              </p>
            </div>
          )}
          <FormField label="Customer" required htmlFor="q_customer">
            <select
              id="q_customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}
              disabled={partialLock}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <option value="">➕ New customer…</option>
              {(customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </FormField>

          {isNewCustomer && !isEdit && (
            <div className="rounded-md border border-hairline bg-paper-2/30 p-3 space-y-2">
              <p className="text-[11px] text-ink-3 font-semibold uppercase tracking-wider">New customer details</p>
              <Input placeholder="Company name *" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="Contact person" value={contactName} onChange={(e) => setContactName(e.target.value)} />
                <Input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="GSTIN" className="font-mono" value={gstin} onChange={(e) => setGstin(e.target.value)} />
                <Input placeholder="State (e.g. Maharashtra)" value={stateName} onChange={(e) => setStateName(e.target.value)} />
              </div>
              <p className="text-[10px] text-ink-3">GSTIN + state make the tax invoice GST-correct (CGST/SGST vs IGST + the customer&apos;s ITC).</p>
            </div>
          )}

          <FormField label="Project title" required htmlFor="q_title">
            <Input id="q_title" placeholder="e.g. Custom accounting software" value={title} onChange={(e) => setTitle(e.target.value)} disabled={partialLock} />
          </FormField>
          <FormField label="Description" htmlFor="q_desc">
            <textarea id="q_desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Scope / notes (optional)" disabled={partialLock}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y disabled:opacity-60 disabled:cursor-not-allowed" />
          </FormField>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink-2">Line items (taxable ₹)</p>
              {!partialLock && (
                <button type="button" onClick={addLine} className="text-[11px] text-amber-ink hover:underline inline-flex items-center gap-0.5">
                  <Icon name="plus" size={12} /> Add line
                </button>
              )}
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="space-y-1.5 rounded-md border border-hairline p-2">
                  <div className="flex items-center gap-2">
                    {oneTimeItems.length > 0 && !partialLock && (
                      <select
                        value="" onChange={(e) => pickItem(i, e.target.value)}
                        className="w-28 shrink-0 rounded-md border border-hairline bg-paper px-2 py-2 text-xs text-ink-2 focus:outline-none focus:ring-2 focus:ring-amber/40"
                        title="Quick-fill from catalog"
                      >
                        <option value="">Catalog…</option>
                        {oneTimeItems.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                      </select>
                    )}
                    <Input className="flex-1" placeholder="Item / service" value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} disabled={partialLock} />
                    {!partialLock && (
                      <button type="button" aria-label="Remove" onClick={() => removeLine(i)} className="text-ink-3 hover:text-rose"><Icon name="x" size={16} /></button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-ink-3">Qty</label>
                    <Input className="w-16" inputMode="numeric" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} disabled={partialLock} />
                    <label className="text-[11px] text-ink-3">Rate</label>
                    <Input className="w-28" inputMode="numeric" prefix="₹" placeholder="0" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} disabled={partialLock} />
                    <span className="ml-auto text-sm font-mono text-ink">{rupee(lineAmount(l))}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="GST rate %" htmlFor="q_gst">
              <Input id="q_gst" inputMode="numeric" value={gstRate} onChange={(e) => setGstRate(e.target.value)} disabled={partialLock} />
            </FormField>
            <label className="flex items-center gap-2 text-sm text-ink-2 mt-6">
              <input type="checkbox" checked={interState} onChange={(e) => setInterState(e.target.checked)} disabled={partialLock} className="rounded border-hairline disabled:opacity-60" />
              Inter-state (IGST)
            </label>
          </div>

          {/* Totals */}
          <div className="rounded-md border border-hairline bg-paper-2/40 p-3 text-sm space-y-1">
            <Line label="Taxable value" value={rupee(taxableNum)} />
            <Line label={`GST @ ${rateNum}%`} value={rupee(gstNum)} />
            <div className="border-t border-hairline pt-1 mt-1"><Line label="Total" value={rupee(totalNum)} strong /></div>
          </div>

          {/* Milestones — a direct invoice is one full invoice, so the schedule is hidden. */}
          {!isInvoiceMode && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink-2">Payment schedule (GST-inclusive)</p>
              <button type="button" onClick={addRow} className="text-[11px] text-amber-ink hover:underline inline-flex items-center gap-0.5">
                <Icon name="plus" size={12} /> Add
              </button>
            </div>

            {/* Locked milestones — invoiced/paid, can't change */}
            {partialLock && lockedMs.map((m) => (
              <div key={m.id} className="flex items-center gap-2 rounded-md border border-hairline bg-paper-2/40 px-3 py-2 text-sm mb-2">
                <Icon name="lock" size={13} className="text-ink-3 shrink-0" />
                <span className="flex-1 text-ink-2 truncate">{m.label}</span>
                <span className="text-[10px] uppercase tracking-wide text-ink-3">{m.invoice_id ? "Invoiced" : "Paid"}</span>
                <span className="font-mono text-ink">{rupee(m.total_amount)}</span>
              </div>
            ))}

            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input className="flex-1" placeholder="Label" value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} />
                  <Input className="w-28" inputMode="numeric" prefix="₹" placeholder="0" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} />
                  <Input className="w-36" type="date" min={todayISO} value={r.due} onChange={(e) => setRow(i, { due: e.target.value })} />
                  <button type="button" aria-label="Remove" onClick={() => removeRow(i)} className="mt-2 text-ink-3 hover:text-rose"><Icon name="x" size={16} /></button>
                </div>
              ))}
            </div>
            <div className={`mt-2 text-[11px] flex items-center gap-2 flex-wrap ${mismatch ? "text-rose" : "text-emerald"}`}>
              <span>
                {partialLock ? "Remaining scheduled " : "Schedule total "}{rupee(milestonesTotal)} · {mismatch
                  ? `should equal ${rupee(scheduleTarget)}`
                  : partialLock ? "balances ✓" : "matches total ✓"}
              </span>
              {mismatch && scheduleTarget > milestonesTotal && rows.length > 0 && (
                <button
                  type="button"
                  className="text-amber-ink underline"
                  onClick={() => {
                    const diff = scheduleTarget - milestonesTotal;
                    setRows((rs) => {
                      // put the leftover into the last EMPTY row, else the last row
                      let idx = rs.findIndex((r) => !(Math.round(Number(r.amount) || 0) > 0));
                      if (idx === -1) idx = rs.length - 1;
                      return rs.map((r, i) => i === idx
                        ? { ...r, amount: String(Math.max(0, Math.round(Number(r.amount) || 0)) + diff) }
                        : r);
                    });
                  }}
                >
                  Fill remaining {rupee(totalNum - milestonesTotal)} →
                </button>
              )}
            </div>
          </div>
          )}
        </div>

        <SheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon={isInvoiceMode ? "receipt" : undefined} loading={create.isPending || update.isPending || updateFuture.isPending || directInvoice.isPending} disabled={!canSubmit} onClick={handleSubmit}>
            {isEdit ? "Save changes" : isInvoiceMode ? "Create invoice" : "Create quotation"}
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
