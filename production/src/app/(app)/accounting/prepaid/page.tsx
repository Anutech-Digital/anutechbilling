/**
 * Prepaid / Vendor Advances — money paid to a vendor before the service is used
 * (e.g. a Facebook ad top-up). Held as a prepaid ASSET; "Consume" books the real
 * expense (P&L) as it's used and reduces the balance.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
// (icons come via Button/FAB `icon` props)
import { FAB } from "@/components/ui/fab";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useConfirm } from "@/components/providers/confirm-provider";
import { rupee, formatDate } from "@/lib/utils";
import { useBankAccounts } from "@/lib/queries/bank";
import { useVendors, ensureVendor, } from "@/lib/queries/vendors";
import { uploadBillAttachment, getBillAttachmentUrl } from "@/lib/queries/vendor-bills";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";
import {
  usePrepaidAdvances, useCreatePrepaidAdvance, useConsumePrepaidAdvance, useDeletePrepaidAdvance,
  useAdvanceExpenses,
  type PrepaidAdvance,
} from "@/lib/queries/prepaid-advances";

const CATEGORIES = ["Marketing", "Advertising", "Software / SaaS", "Hosting", "Subscriptions", "Other"];
const METHODS = ["bank_transfer", "upi", "card", "cheque", "cash"];

export default function PrepaidAdvancesPage() {
  const q = usePrepaidAdvances();
  const del = useDeletePrepaidAdvance();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = React.useState(false);
  const [consume, setConsume] = React.useState<PrepaidAdvance | null>(null);

  const rows = q.data ?? [];
  const totalBalance = rows.reduce((s, r) => s + r.balance, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Prepaid / Advances</h1>
          <p className="text-sm text-ink-2 mt-1 max-w-2xl">
            Money paid to a vendor <b>before</b> the service is used — e.g. a Facebook ad top-up. Held as an
            asset; <b>Consume</b> it as the service runs to book the real expense in your P&amp;L.
          </p>
        </div>
        <Button variant="primary" icon="plus" className="hidden md:inline-flex shrink-0" onClick={() => setAddOpen(true)}>Add advance</Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
        <KPI label="Open advances" value={String(rows.filter((r) => r.balance > 0).length)} />
        <KPI label="Prepaid balance" value={rupee(totalBalance)} tone={totalBalance > 0 ? "amber" : undefined} sub="asset — not yet expensed" />
        <KPI label="Consumed (all)" value={rupee(rows.reduce((s, r) => s + r.consumed_amount, 0))} tone="emerald" sub="booked to P&L" />
      </div>

      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="rupee" title="No prepaid advances yet"
            body="Paid a vendor in advance (like Facebook ads)? Record it here so it's tracked as an asset and expensed as you use it."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Add advance</Button>} />
        </Card>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r) => (
            <li key={r.id}>
              <AdvanceCard
                r={r}
                onConsume={() => setConsume(r)}
                onDelete={async () => { if (await confirm({ title: `Delete this advance?`, body: "This removes the advance record. Expenses already booked from it stay.", danger: true, confirmLabel: "Delete" })) del.mutate(r.id); }}
              />
            </li>
          ))}
        </ul>
      )}

      <FAB icon="plus" label="Advance" onClick={() => setAddOpen(true)} ariaLabel="Add advance" />
      {addOpen && <AddAdvanceDialog onClose={() => setAddOpen(false)} />}
      {consume && <ConsumeDialog advance={consume} onClose={() => setConsume(null)} />}
    </div>
  );
}

function AdvanceCard({ r, onConsume, onDelete }: { r: PrepaidAdvance; onConsume: () => void; onDelete: () => void }) {
  const [open, setOpen] = React.useState(false);
  const exp = useAdvanceExpenses(r.id, open);
  const pct = r.total_amount > 0 ? Math.min(100, Math.round((r.consumed_amount / r.total_amount) * 100)) : 0;
  const done = r.balance <= 0;
  const items = exp.data ?? [];

  async function openBill(path: string) {
    try {
      const url = await getBillAttachmentUrl(path);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      else toast.error("Bill link nahi bana — dobara try karo.");
    } catch { toast.error("Bill khol nahi paaye."); }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-ink">{r.vendor_name}</span>
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-indigo/10 text-indigo">{r.category}</span>
            {done && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald/10 text-emerald">Fully used</span>}
          </div>
          <div className="text-[11px] text-ink-3 mt-0.5">
            Paid {formatDate(r.paid_date)}{r.payment_method ? ` · ${r.payment_method.replace(/_/g, " ")}` : ""}
            {r.notes ? ` · ${r.notes}` : ""}
          </div>
        </div>
        <div className="text-right">
          <div className="font-serif text-2xl text-ink leading-none">{rupee(r.balance)}</div>
          <div className="text-[10px] text-ink-3 mt-0.5">balance of {rupee(r.total_amount)}</div>
        </div>
      </div>
      {/* consumed bar */}
      <div className="mt-3 h-1.5 rounded-full bg-paper-2 overflow-hidden">
        <div className="h-full bg-emerald" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-3">
        {/* Click to expand the expenses booked against this advance. */}
        <button type="button" onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 hover:text-ink transition-colors"
          aria-expanded={open}>
          <Icon name={open ? "chevron_up" : "chevron_down"} size={13} />
          <span>{rupee(r.consumed_amount)} used ({pct}%){r.consumed_amount > 0 ? " · view expenses" : ""}</span>
        </button>
        <div className="flex items-center gap-1">
          {!done && (
            <Button variant="primary" className="h-7 px-2.5 text-[11px]" icon="check" onClick={onConsume}>Consume</Button>
          )}
          <Button variant="ghost" className="h-7 px-2 text-[11px]" onClick={onDelete}>Delete</Button>
        </div>
      </div>

      {/* Expanded: the expenses (each "Consume") booked against this advance. */}
      {open && (
        <div className="mt-3 rounded-lg border border-hairline bg-paper-2/40 divide-y divide-hairline">
          {exp.isLoading ? (
            <div className="p-3 space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</div>
          ) : items.length === 0 ? (
            <p className="p-3 text-[12px] text-ink-3">Abhi is advance se koi expense book nahi hua. &ldquo;Consume&rdquo; karke expense banao.</p>
          ) : (
            items.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="text-[12px] text-ink">
                    {formatDate(e.expense_date)}
                    {e.gst_paid > 0 && <span className="text-ink-3"> · GST {rupee(e.gst_paid)}</span>}
                  </div>
                  {(e.notes || e.description) && (
                    <div className="text-[11px] text-ink-3 truncate">{e.notes || e.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {e.attachment_url ? (
                    <button type="button" onClick={() => openBill(e.attachment_url!)}
                      className="inline-flex items-center gap-1 text-[11px] text-amber-ink hover:underline">
                      <Icon name="file" size={12} /> Bill
                    </button>
                  ) : (
                    <span className="text-[10px] text-ink-3">no bill</span>
                  )}
                  <span className="font-medium text-ink text-[12px] tabular-nums">{rupee(e.amount)}</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  );
}

function AddAdvanceDialog({ onClose }: { onClose: () => void }) {
  const create = useCreatePrepaidAdvance();
  const { data: accounts } = useBankAccounts();
  const activeAccounts = (accounts ?? []).filter((a) => a.is_active !== false);
  const { data: vendors } = useVendors();
  const today = new Date().toISOString().slice(0, 10);
  const [vendor, setVendor] = React.useState("");
  const [vendorId, setVendorId] = React.useState<string | null>(null);
  const [vendorOpen, setVendorOpen] = React.useState(false);
  const [category, setCategory] = React.useState("Marketing");
  const [amount, setAmount] = React.useState("");
  const [paidDate, setPaidDate] = React.useState(today);
  const [method, setMethod] = React.useState("bank_transfer");
  const [bankId, setBankId] = React.useState("");
  const [notes, setNotes] = React.useState("");

  // Account list follows the "Paid by" method: cash → petty-cash accounts only,
  // bank/UPI/card/cheque → bank accounts only. Switching method clears the pick.
  const cashAccts = activeAccounts.filter((a) => a.account_type === "cash");
  const bankAccts = activeAccounts.filter((a) => a.account_type !== "cash");
  const accountsForMethod = method === "cash" ? cashAccts : bankAccts;
  const changeMethod = (m: string) => { setMethod(m); setBankId(""); };

  const vName = vendor.trim();
  const vMatch = (vendors ?? []).find((v) => v.name.toLowerCase() === vName.toLowerCase());
  const isNewVendor = vName.length > 0 && !vMatch;

  async function submit() {
    const amt = Math.round(Number(amount) || 0);
    if (!vName) { return; }
    if (amt <= 0) { return; }
    // Link an existing vendor, or create a new one in the master.
    const vId = vendorId ?? vMatch?.id ?? (isNewVendor ? await ensureVendor({ name: vName, defaultCategory: category }) : null);
    await create.mutateAsync({
      vendor_name: vName, vendor_id: vId, category, total_amount: amt, paid_date: paidDate,
      payment_method: method, bank_account_id: bankId || null, notes: notes.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Add prepaid advance</DialogTitle>
          <DialogDescription>Money paid to a vendor before using the service. Held as an asset until consumed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="Vendor" required htmlFor="pa_vendor">
            <div className="relative">
              <Input id="pa_vendor" autoComplete="off" placeholder="e.g. Facebook / Google Ads"
                value={vendor}
                onChange={(e) => { setVendor(e.target.value); setVendorId(null); setVendorOpen(true); }}
                onFocus={() => setVendorOpen(true)}
                onBlur={() => setTimeout(() => setVendorOpen(false), 130)} autoFocus />
              {vendorOpen && (vendors ?? []).length > 0 && (() => {
                const qy = vName.toLowerCase();
                const matches = (vendors ?? []).filter((v) => !qy || v.name.toLowerCase().includes(qy)).slice(0, 8);
                if (matches.length === 0) return null;
                return (
                  <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-md border border-hairline bg-paper shadow-lg">
                    {matches.map((v) => (
                      <button key={v.id} type="button"
                        onMouseDown={(e) => { e.preventDefault(); setVendor(v.name); setVendorId(v.id); setVendorOpen(false); }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-paper-2">
                        <span className="text-ink truncate">{v.name}</span>
                        {v.gstin && <span className="text-[10px] text-ink-3 font-mono shrink-0">{v.gstin}</span>}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            {vendorId || vMatch ? (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-emerald"><Icon name="check_circle" size={12} /> Existing vendor — isi se link hoga.</p>
            ) : isNewVendor ? (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-ink"><Icon name="plus" size={12} /> Naya vendor &ldquo;{vName}&rdquo; — Save par Vendors master me add ho jayega.</p>
            ) : null}
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Will be expensed as" htmlFor="pa_cat">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="pa_cat"><SelectValue /></SelectTrigger>
                <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
            <FormField label="Advance amount (₹)" required htmlFor="pa_amt">
              <Input id="pa_amt" type="number" min={1} prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Paid on" htmlFor="pa_date">
              <Input id="pa_date" type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
            </FormField>
            <FormField label="Paid by" htmlFor="pa_method">
              <Select value={method} onValueChange={changeMethod}>
                <SelectTrigger id="pa_method"><SelectValue /></SelectTrigger>
                <SelectContent>{METHODS.map((m) => <SelectItem key={m} value={m}>{m.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          </div>
          {accountsForMethod.length > 0 && (
            <FormField label={method === "cash" ? "From which petty cash?" : "From which bank account?"} htmlFor="pa_bank">
              <Select value={bankId || "none"} onValueChange={(v) => setBankId(v === "none" ? "" : v)}>
                <SelectTrigger id="pa_bank"><SelectValue placeholder="Select account" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not sure / pick later</SelectItem>
                  {accountsForMethod.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.account_type === "cash" ? "💵 " : ""}{a.name}{a.bank_name ? ` · ${a.bank_name}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-ink-3 mt-1">
                {method === "cash"
                  ? "Cash-in-hand se diya — yahan wo petty-cash account chuno."
                  : "Bank se gaya — Banking me isi account ki debit line se reconcile karo."}
              </p>
            </FormField>
          )}
          <FormField label="Note (optional)" htmlFor="pa_notes">
            <Input id="pa_notes" placeholder="e.g. Jan campaign top-up" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={create.isPending}
            disabled={!vendor.trim() || !(Number(amount) > 0)} onClick={submit}>Save advance</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConsumeDialog({ advance, onClose }: { advance: PrepaidAdvance; onClose: () => void }) {
  const consume = useConsumePrepaidAdvance();
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = React.useState(String(advance.balance));
  const [gst, setGst] = React.useState("");
  const [date, setDate] = React.useState(today);
  const [note, setNote] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [reading, setReading] = React.useState(false);
  const [aiNote, setAiNote] = React.useState("");
  const amt = Math.round(Number(amount) || 0);
  const gstAmt = Math.round(Number(gst) || 0);
  const tooMuch = amt > advance.balance;
  const gstTooMuch = gstAmt > amt;

  // On file pick: attach + let the AI read the invoice and auto-fill amount/GST/date.
  async function onFile(f: File | null) {
    setFile(f);
    setAiNote("");
    if (!f) return;
    setReading(true);
    try {
      const base64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res((r.result as string).split(",")[1] ?? "");
        r.onerror = () => rej(new Error("read failed"));
        r.readAsDataURL(f);
      });
      const resp = await fetch("/api/ai/extract-bill", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileBase64: base64, mimeType: f.type }),
      });
      const json = await resp.json();
      if (!resp.ok) { setAiNote(json.error ?? "Bill padh nahi paaye — fields haath se bhar do."); return; }
      const fx = json.fields as Record<string, string | number | null>;
      if (fx.total != null) setAmount(String(Math.round(Number(fx.total))));
      const g = Number(fx.cgst ?? 0) + Number(fx.sgst ?? 0) + Number(fx.igst ?? 0);
      if (g > 0) setGst(String(Math.round(g)));
      if (fx.bill_date) setDate(String(fx.bill_date));
      setAiNote(`✨ AI ne "${f.name}" se bhar diya — amount/GST/date check karke Book karo.`);
    } catch {
      setAiNote("Read fail — fields haath se bhar do (bill phir bhi attach ho jayega).");
    } finally {
      setReading(false);
    }
  }

  async function submit() {
    if (amt <= 0 || tooMuch || gstTooMuch) return;
    let attachment: string | null = null;
    if (file) {
      setUploading(true);
      try { attachment = await uploadBillAttachment(file); }
      catch { toast.error("Bill upload failed — expense still booked without it."); }
      finally { setUploading(false); }
    }
    await consume.mutateAsync({ advanceId: advance.id, amount: amt, gst: gstAmt, attachment, date, note: note.trim() || null });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Consume — {advance.vendor_name}</DialogTitle>
          <DialogDescription>
            Balance {rupee(advance.balance)}. This books a <b>{advance.category}</b> expense in your P&amp;L and reduces the advance.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Amount used (₹)" required htmlFor="cons_amt">
              <Input id="cons_amt" type="number" min={1} prefix="₹" value={amount} onChange={(e) => setAmount(e.target.value)} error={tooMuch ? "More than balance" : undefined} />
              <button type="button" className="text-[11px] text-amber-ink hover:underline mt-1" onClick={() => setAmount(String(advance.balance))}>Full ({rupee(advance.balance)})</button>
            </FormField>
            <FormField label="of which GST (ITC)" htmlFor="cons_gst">
              <Input id="cons_gst" type="number" min={0} prefix="₹" value={gst} onChange={(e) => setGst(e.target.value)} error={gstTooMuch ? "GST > amount" : undefined} />
              <p className="text-[10px] text-ink-3 mt-1">Bill ka input GST — claimable.</p>
            </FormField>
          </div>
          <FormField label="Date" htmlFor="cons_date">
            <Input id="cons_date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </FormField>
          <FormField label="Attach bill (optional)" htmlFor="cons_bill">
            <input id="cons_bill" type="file" accept="image/*,application/pdf" disabled={reading}
              onChange={(e) => onFile(e.target.files?.[0] ?? null)}
              className="block w-full text-[12px] text-ink-2 file:mr-3 file:rounded-md file:border-0 file:bg-paper-2 file:px-3 file:py-1.5 file:text-ink file:cursor-pointer disabled:opacity-50" />
            {reading ? (
              <p className="text-[11px] text-amber-ink mt-1 inline-flex items-center gap-1"><Icon name="sparkles" size={12} /> AI bill padh raha hai — amount/GST/date bhar dega…</p>
            ) : aiNote ? (
              <p className="text-[11px] text-emerald mt-1">{aiNote}</p>
            ) : (
              <p className="text-[10px] text-ink-3 mt-1">Facebook/Google ka tax invoice lagao — AI amount/GST/date khud bhar dega, aur bill expense se juda rahega.</p>
            )}
          </FormField>
          <FormField label="Note (optional)" htmlFor="cons_note">
            <Input id="cons_note" placeholder="e.g. ads run 1–15 Jan" value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={consume.isPending || uploading} disabled={amt <= 0 || tooMuch || gstTooMuch} onClick={submit}>
            {uploading ? "Uploading…" : `Book ${rupee(amt > 0 ? amt : 0)} expense`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KPI({ label, value, tone, sub }: { label: string; value: string; tone?: "emerald" | "amber"; sub?: string }) {
  const c = tone === "emerald" ? "text-emerald" : tone === "amber" ? "text-amber-ink" : "text-ink";
  return (
    <Card className="p-2.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5 truncate">{label}</div>
      <div className={`font-serif text-lg md:text-xl ${c} leading-tight truncate`}>{value}</div>
      {sub && <div className="text-[10px] text-ink-3 truncate">{sub}</div>}
    </Card>
  );
}
