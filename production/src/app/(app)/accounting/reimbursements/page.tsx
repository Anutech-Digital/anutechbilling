/**
 * Reimbursements — company expenses paid from a person's own card / cash.
 *
 * Record it here → the expense hits the P&L AND we track how much the company
 * owes that person. "Settle" marks it repaid (the actual bank transfer to the
 * person is reconciled in Banking — it's not a second expense).
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import { useConfirm } from "@/components/providers/confirm-provider";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { FormField } from "@/components/ui/label";
import {
  useReimbursements, useAddReimbursement, useSettleReimbursement, useDeleteReimbursement,
  uploadReimbursementReceipt, getReimbursementReceiptUrl,
  REIMBURSEMENT_CATEGORIES, type Reimbursement,
} from "@/lib/queries/reimbursements";
import { useEmployees } from "@/lib/queries/payroll";
import { rupee, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { istToday } from "@/lib/dates/ist";

function todayISO() {
  return istToday();
}

export default function ReimbursementsPage() {
  const { data: rows, isLoading } = useReimbursements();
  const [addOpen, setAddOpen] = React.useState(false);
  const [settleFor, setSettleFor] = React.useState<Reimbursement | null>(null);
  const del = useDeleteReimbursement();
  const confirm = useConfirm();

  const pending = (rows ?? []).filter((r) => r.status === "pending");
  const settled = (rows ?? []).filter((r) => r.status === "settled");
  const owed = pending.reduce((s, r) => s + r.amount, 0);

  // "Kisko kitna dena" — total owed per person.
  const byPerson = new Map<string, number>();
  for (const r of pending) byPerson.set(r.person_name, (byPerson.get(r.person_name) ?? 0) + r.amount);
  const owedByPerson = [...byPerson.entries()].sort((a, b) => b[1] - a[1]);

  const confirmDelete = async (r: Reimbursement) => {
    if (await confirm({
      title: `Remove this reimbursement (${rupee(r.amount)} · ${r.person_name})?`,
      body: "The booked expense is removed too (only if it isn't reconciled to a bank line).",
      confirmLabel: "Remove",
      danger: true,
    })) {
      del.mutate(r.id);
    }
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Reimbursements</h1>
          <p className="text-sm text-ink-3 mt-1">
            Someone paid a company expense from their own pocket? Record it here — the expense gets booked and we track how much you owe each person.
          </p>
        </div>
        <Button variant="primary" icon="plus" className="hidden md:inline-flex" onClick={() => setAddOpen(true)}>Add reimbursement</Button>
      </div>

      {/* How it works — one-liner for a layman */}
      <Card className="mb-5 p-3 md:p-4 border-amber/40 bg-amber-soft/25">
        <p className="text-[13px] text-ink-2 leading-relaxed">
          <b className="text-ink">How it works:</b> the expense is recorded once here (it hits the P&amp;L). When you pay that person back, hit <b>Settle</b> — you reconcile that bank transfer in Banking; it&apos;s <i>not</i> a second expense.
        </p>
      </Card>

      {/* Summary: total owed + per person */}
      {!isLoading && (rows ?? []).length > 0 && (
        <Card className="mb-5 p-4">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <div>
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total owed</p>
              <p className="font-serif text-2xl text-rose">{rupee(owed)}</p>
            </div>
            <div className="flex-1 min-w-[200px]">
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Owed per person</p>
              {owedByPerson.length === 0 ? (
                <p className="text-sm text-ink-3">All settled 🎉</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {owedByPerson.map(([name, amt]) => (
                    <span key={name} className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-paper-2/40 px-2.5 py-1 text-xs">
                      <span className="font-medium text-ink">{name}</span>
                      <span className="font-mono text-rose">{rupee(amt)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : (rows ?? []).length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="rupee"
            title="No reimbursements yet"
            body="When a company expense is paid from someone's personal card or cash, add it here."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add the first one</Button>}
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <ReimbList title={`Pending · owed (${pending.length})`} rows={pending}
              onSettle={setSettleFor} onDelete={confirmDelete} />
          )}
          {settled.length > 0 && (
            <ReimbList title={`Settled (${settled.length})`} rows={settled} settled
              onSettle={setSettleFor} onDelete={confirmDelete} />
          )}
        </div>
      )}

      {addOpen && <AddReimbursementDialog onClose={() => setAddOpen(false)} />}
      {settleFor && <SettleDialog reimb={settleFor} onClose={() => setSettleFor(null)} />}
      <FAB icon="plus" label="Add" onClick={() => setAddOpen(true)} />
    </div>
  );
}

function ReimbList({
  title, rows, settled, onSettle, onDelete,
}: {
  title: string; rows: Reimbursement[]; settled?: boolean;
  onSettle: (r: Reimbursement) => void; onDelete: (r: Reimbursement) => void;
}) {
  return (
    <div>
      <p className="text-xs font-semibold text-ink-2 mb-2">{title}</p>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-hairline">
          {rows.map((r) => (
            <li key={r.id}>
              {/* Desktop / tablet — single row */}
              <div className="hidden md:flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink truncate flex items-center gap-1.5">
                    <span className="truncate">{r.person_name}</span>
                    {r.employee_id && <Badge kind="info" size="sm">Employee</Badge>}
                    <span className="text-ink-3 font-normal truncate">· {r.purpose}</span>
                  </p>
                  <p className="text-xs text-ink-3 truncate">
                    {r.category} · {formatDate(r.incurred_on)}{r.paid_via ? ` · ${r.paid_via}` : ""}
                    {settled && r.settled_on ? ` · settled ${formatDate(r.settled_on)}` : ""}
                  </p>
                </div>
                {r.receipt_path && <ReceiptLink path={r.receipt_path} />}
                <div className="text-right shrink-0">
                  <p className={`font-mono text-sm font-semibold ${settled ? "text-ink-3" : "text-rose"}`}>{rupee(r.amount)}</p>
                </div>
                {settled ? (
                  <Badge kind="success" size="sm" dot>Settled</Badge>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => onSettle(r)}>Settle</Button>
                )}
                <Button
                  size="sm" variant="ghost" icon="trash"
                  className="!text-rose hover:!bg-rose/10"
                  aria-label="Delete"
                  onClick={() => onDelete(r)}
                />
              </div>

              {/* Mobile — stacked card: person + amount on top, purpose + actions below */}
              <div className="md:hidden px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 text-sm font-medium text-ink flex items-center gap-1.5">
                    <span className="truncate">{r.person_name}</span>
                    {r.employee_id && <Badge kind="info" size="sm">Employee</Badge>}
                  </p>
                  <p className={`font-mono text-sm font-semibold shrink-0 ${settled ? "text-ink-3" : "text-rose"}`}>{rupee(r.amount)}</p>
                </div>
                <p className="mt-1 text-[13px] text-ink-2">{r.purpose}</p>
                <p className="mt-0.5 text-xs text-ink-3">
                  {r.category} · {formatDate(r.incurred_on)}{r.paid_via ? ` · ${r.paid_via}` : ""}
                  {settled && r.settled_on ? ` · settled ${formatDate(r.settled_on)}` : ""}
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  {settled ? (
                    <Badge kind="success" size="sm" dot>Settled</Badge>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => onSettle(r)}>Settle</Button>
                  )}
                  {r.receipt_path && <ReceiptLink path={r.receipt_path} />}
                  <Button
                    size="sm" variant="ghost" icon="trash"
                    className="!text-rose hover:!bg-rose/10 ml-auto"
                    aria-label="Delete"
                    onClick={() => onDelete(r)}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function ReceiptLink({ path }: { path: string }) {
  const [loading, setLoading] = React.useState(false);
  async function open() {
    setLoading(true);
    try {
      const url = await getReimbursementReceiptUrl(path);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else toast.error("Couldn't open the receipt");
    } finally { setLoading(false); }
  }
  return (
    <Button size="sm" variant="ghost" icon="eye" loading={loading} onClick={open} className="shrink-0" aria-label="View receipt">
      Receipt
    </Button>
  );
}

function AddReimbursementDialog({ onClose }: { onClose: () => void }) {
  const add = useAddReimbursement();
  const empQ = useEmployees();
  const employees = (empQ.data ?? []).filter((e) => e.is_active);

  const [person, setPerson] = React.useState("");
  const [employeeId, setEmployeeId] = React.useState<string | null>(null);
  const [nameOpen, setNameOpen] = React.useState(false);
  const [purpose, setPurpose] = React.useState("");
  const [category, setCategory] = React.useState("Other");
  const [amount, setAmount] = React.useState("");
  const [gst, setGst] = React.useState("");
  const [date, setDate] = React.useState(todayISO());
  const [paidVia, setPaidVia] = React.useState("");
  const [receipt, setReceipt] = React.useState<File | null>(null);
  const [uploading, setUploading] = React.useState(false);

  const valid = person.trim() && purpose.trim() && Number(amount) > 0;

  const save = async () => {
    if (!valid) return;
    try {
      let receiptPath: string | null = null;
      if (receipt) {
        setUploading(true);
        try { receiptPath = await uploadReimbursementReceipt(receipt); }
        catch (e) { toast.error((e as Error).message || "Receipt upload failed"); setUploading(false); return; }
        setUploading(false);
      }
      await add.mutateAsync({
        person: person.trim(), purpose: purpose.trim(), category,
        amount: Number(amount), gst: Number(gst) || 0, incurredOn: date, paidVia: paidVia.trim() || null,
        employeeId, receiptPath,
      });
      onClose();
    } catch { /* hook toasts */ }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Add reimbursement</DialogTitle>
          <DialogDescription>Someone paid a company expense from their own pocket — record it here.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Who paid — employee picker with free-text fallback for non-staff. */}
            <FormField htmlFor="reimbursements-kisne-pay-kiya" label="Kisne pay kiya" required>
              <div className="relative">
                <Input id="reimbursements-kisne-pay-kiya"
                  value={person}
                  onChange={(e) => { setPerson(e.target.value); setEmployeeId(null); setNameOpen(true); }}
                  onFocus={() => setNameOpen(true)}
                  onBlur={() => setTimeout(() => setNameOpen(false), 130)}
                  placeholder={employees.length ? "Employee chuno ya naam likho" : "e.g. Ramesh"}
                  autoFocus
                />
                {nameOpen && employees.length > 0 && (() => {
                  const q = person.trim().toLowerCase();
                  const matches = q ? employees.filter((e) => e.name.toLowerCase().includes(q)) : employees;
                  if (matches.length === 0) return null;
                  return (
                    <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-md border border-hairline bg-paper shadow-lg">
                      {matches.map((e) => (
                        <button
                          key={e.id}
                          type="button"
                          onMouseDown={(ev) => { ev.preventDefault(); setPerson(e.name); setEmployeeId(e.id); setNameOpen(false); }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-paper-2"
                        >
                          <Icon name="user" size={13} className="text-ink-3 shrink-0" />
                          <span className="text-ink">{e.name}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
              {employeeId
                ? <p className="mt-1 text-xs text-emerald">✓ Employee — iski reimbursement track hogi</p>
                : person.trim() ? <p className="mt-1 text-xs text-ink-3">Non-employee (director / dost ka card) — bhi theek hai</p> : null}
            </FormField>
            <FormField htmlFor="reimbursements-date" label="Date">
              <Input id="reimbursements-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </FormField>
          </div>
          <FormField htmlFor="reimbursements-kis-cheez-ke-liye" label="Kis cheez ke liye" required>
            <Input id="reimbursements-kis-cheez-ke-liye" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Client visit cab, office stationery" />
          </FormField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField htmlFor="reimbursements-category" label="Category">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="reimbursements-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REIMBURSEMENT_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </FormField>
            <FormField htmlFor="reimbursements-paid-via-optional" label="Paid via (optional)">
              <Input id="reimbursements-paid-via-optional" value={paidVia} onChange={(e) => setPaidVia(e.target.value)} placeholder="e.g. cash, own UPI" />
            </FormField>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField htmlFor="reimbursements-amount-incl-gst" label="Amount (₹) incl GST" required>
              <Input id="reimbursements-amount-incl-gst" type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
            <FormField htmlFor="reimbursements-gst-paid-optional" label="GST paid (₹, optional)">
              <Input id="reimbursements-gst-paid-optional" type="number" min={0} value={gst} onChange={(e) => setGst(e.target.value)} />
            </FormField>
          </div>
          {/* Receipt / bill photo — proof of the spend. */}
          <FormField htmlFor="reimbursements-receipt" label="Receipt / bill (optional)">
            <label className="flex items-center gap-2 rounded-md border border-dashed border-hairline px-3 py-2 text-sm text-ink-2 cursor-pointer hover:border-hairline-strong">
              <Icon name="upload" size={14} className="text-ink-3" />
              <span className="truncate">{receipt ? receipt.name : "Attach a photo or PDF"}</span>
              <input
                id="reimbursements-receipt"
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
              />
            </label>
          </FormField>
          <p className="text-xs text-ink-3">On save, this expense is booked to the P&amp;L and shown as owed to {person.trim() || "that person"}.</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={add.isPending || uploading} disabled={!valid} onClick={save}>
            {uploading ? "Uploading…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettleDialog({ reimb, onClose }: { reimb: Reimbursement; onClose: () => void }) {
  const settle = useSettleReimbursement();
  const [date, setDate] = React.useState(todayISO());
  const [notes, setNotes] = React.useState("");

  const save = async () => {
    try {
      await settle.mutateAsync({ id: reimb.id, settledOn: date, notes: notes.trim() || null });
      onClose();
    } catch { /* hook toasts */ }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-sm">
        <DialogHeader>
          <DialogTitle>Settle · {reimb.person_name}</DialogTitle>
          <DialogDescription>
            Paid <b className="text-ink">{rupee(reimb.amount)}</b> back to {reimb.person_name}? This only marks it settled — reconcile the bank transfer in Banking (it won&apos;t create a second expense).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField htmlFor="reimbursements-settled-on" label="Settled on">
            <Input id="reimbursements-settled-on" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField htmlFor="reimbursements-note-optional" label="Note (optional)">
            <Input id="reimbursements-note-optional" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Paid from HDFC current a/c" />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={settle.isPending} onClick={save}>Mark settled</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
