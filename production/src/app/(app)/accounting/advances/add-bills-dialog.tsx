/**
 * R-1871 — Accounting → Advances → "Add bills": the employee's bills booked against their
 * office-expense advance, several at once.
 *
 * Each bill: date, vendor, category, amount (incl. GST), GST, optional photo (read by the bill
 * reader when AI is set up) and a note. They become expenses in their own categories — the P&L
 * sees them, with GST input credit where it is a GST bill from a registered vendor — and the
 * advance balance goes down. Bills more than the balance: the extra is what the employee paid
 * from their own money, so the dialog offers "Reimburse ₹X to <name>" (a reimbursement, paid
 * later and reconciled from the bank line). One atomic RPC: add_employee_advance_bills.
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { rupee } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";
import { useVendors } from "@/lib/queries/vendors";
import { uploadBillAttachment } from "@/lib/queries/vendor-bills";
import { useAddAdvanceBills, type AdvanceBillInput } from "@/lib/queries/employee-advance-bank";
import { billProblem, parseRupees, splitBills } from "@/lib/accounting/employee-advance";
import type { EmployeeAdvance } from "@/lib/queries/advances";

/** Categories a bill paid from an office advance can be (salary and director pay go through Payroll). */
export const ADVANCE_BILL_CATEGORIES: readonly string[] = EXPENSE_CATEGORIES.filter((c) => c !== "Salaries" && c !== "Director's Remuneration");

interface Row {
  key: number;
  date: string;
  vendor: string;
  category: string;
  amount: string;
  gst: string;
  billNo: string;
  note: string;
  attachment: string | null;
  fileName: string | null;
  reading: boolean;
}

const PROBLEM_TEXT: Record<string, string> = {
  date: "Enter the bill date.",
  category: "Pick a category.",
  amount: "Enter the bill amount in whole rupees.",
  gst: "GST must be whole rupees and less than the bill amount.",
};

let nextKey = 1;
const blankRow = (): Row => ({
  key: nextKey++, date: istToday(), vendor: "", category: "", amount: "", gst: "", billNo: "", note: "",
  attachment: null, fileName: null, reading: false,
});

const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

export function AddBillsDialog({ advance, open, onOpenChange }: { advance: EmployeeAdvance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const add = useAddAdvanceBills();
  const { data: vendors } = useVendors();
  const [rows, setRows] = React.useState<Row[]>(() => [blankRow()]);
  const [reimburse, setReimburse] = React.useState(false);
  const [readNote, setReadNote] = React.useState<string | null>(null);

  React.useEffect(() => { if (open) { setRows([blankRow()]); setReimburse(false); setReadNote(null); } }, [open, advance.id]);

  const parsed = rows.map((r) => {
    const amount = parseRupees(r.amount);
    const gst = parseRupees(r.gst);
    return { row: r, amount, gst, problem: billProblem({ date: r.date, category: r.category, amount, gst }) };
  });
  const filled = parsed.filter((p) => p.row.amount.trim() !== "" || p.row.vendor.trim() !== "" || p.row.category !== "");
  const split = splitBills(filled.map((p) => ({ amount: Number.isFinite(p.amount) ? p.amount : 0, gst: 0 })), advance.remaining_balance);
  const anyProblem = filled.some((p) => p.problem);
  const canSave = filled.length > 0 && !anyProblem && (split.extra === 0 || reimburse) && !rows.some((r) => r.reading);

  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function onFile(key: number, file: File | null) {
    if (!file) return;
    update(key, { reading: true, fileName: file.name });
    setReadNote(null);
    try {
      const path = await uploadBillAttachment(file);
      update(key, { attachment: path });
      // The bill reader fills what is still empty; the person checks every number before saving.
      const base64 = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(file);
      });
      const res = await fetch("/api/ai/extract-bill", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileBase64: base64, mimeType: file.type }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.fields) {
        setReadNote(json.code === "ai_not_configured" ? "Photo attached. AI reading is not set up — fill the bill by hand." : "Photo attached. Couldn't read it — fill the bill by hand.");
        return;
      }
      const f = json.fields as { vendor_name: string | null; vendor_gstin: string | null; bill_no: string | null; bill_date: string | null; total: number | null; cgst: number; sgst: number; igst: number; expense_category: string | null };
      const gst = Math.round((f.cgst ?? 0) + (f.sgst ?? 0) + (f.igst ?? 0));
      const byGstin = f.vendor_gstin ? (vendors ?? []).find((v) => (v.gstin ?? "").toUpperCase() === f.vendor_gstin) : undefined;
      setRows((rs) => rs.map((r) => (r.key !== key ? r : {
        ...r,
        vendor: r.vendor || byGstin?.name || f.vendor_name || "",
        date: f.bill_date ?? r.date,
        amount: r.amount || (f.total ? String(Math.round(f.total)) : ""),
        gst: r.gst || (gst > 0 ? String(gst) : ""),
        billNo: r.billNo || f.bill_no || "",
        category: r.category || (f.expense_category && ADVANCE_BILL_CATEGORIES.includes(f.expense_category) ? f.expense_category : ""),
      })));
      setReadNote("Read from the photo — check the numbers before saving.");
    } catch {
      setReadNote("Couldn't attach the photo — try again, or save the bill without it.");
    } finally {
      update(key, { reading: false });
    }
  }

  function save() {
    const bills: AdvanceBillInput[] = filled.map((p) => {
      const vendor = (vendors ?? []).find((v) => v.name.trim().toLowerCase() === p.row.vendor.trim().toLowerCase());
      return {
        date: p.row.date,
        vendor_name: p.row.vendor.trim() || null,
        vendor_id: vendor?.id ?? null,
        category: p.row.category,
        amount: p.amount,
        gst: p.gst,
        bill_no: p.row.billNo.trim() || null,
        attachment_url: p.row.attachment,
        note: p.row.note.trim() || null,
      };
    });
    add.mutate({ advanceId: advance.id, bills, reimburseExtra: split.extra > 0 && reimburse }, { onSuccess: () => onOpenChange(false) });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add bills — {advance.employee_name}</DialogTitle>
          <DialogDescription>
            {rupee(advance.remaining_balance)} is with {advance.employee_name}. Each bill is booked as an expense in its category; the advance goes down by the same amount.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {rows.map((r, i) => {
            const p = parsed[i];
            const touched = filled.includes(p);
            return (
              <fieldset key={r.key} className="rounded-md border border-hairline p-3 space-y-2" aria-label={`Bill ${i + 1}`}>
                <div className="flex items-center justify-between">
                  <legend className="text-xs font-semibold text-ink-2">Bill {i + 1}</legend>
                  {rows.length > 1 && (
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove bill ${i + 1}`}
                      onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>Remove</Button>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input type="date" aria-label={`Bill ${i + 1} date`} value={r.date} max={istToday()} onChange={(e) => update(r.key, { date: e.target.value })} />
                  <Input aria-label={`Bill ${i + 1} vendor`} placeholder="Vendor (shop / supplier)" list="advance-bill-vendors" value={r.vendor} onChange={(e) => update(r.key, { vendor: e.target.value })} />
                  <select aria-label={`Bill ${i + 1} category`} value={r.category} onChange={(e) => update(r.key, { category: e.target.value })} className={selectCls}>
                    <option value="">Category…</option>
                    {ADVANCE_BILL_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <Input aria-label={`Bill ${i + 1} bill number`} placeholder="Bill no. (optional)" value={r.billNo} onChange={(e) => update(r.key, { billNo: e.target.value })} />
                  <Input aria-label={`Bill ${i + 1} amount`} inputMode="numeric" placeholder="Amount incl. GST ₹" value={r.amount} onChange={(e) => update(r.key, { amount: e.target.value })} />
                  <Input aria-label={`Bill ${i + 1} GST`} inputMode="numeric" placeholder="GST in it ₹ (0 if none)" value={r.gst} onChange={(e) => update(r.key, { gst: e.target.value })} />
                </div>
                <Input aria-label={`Bill ${i + 1} note`} placeholder="Note (optional)" value={r.note} onChange={(e) => update(r.key, { note: e.target.value })} />
                <label className="flex items-center gap-2 text-xs text-ink-2 cursor-pointer">
                  <input type="file" accept="image/*,application/pdf" className="sr-only" aria-label={`Bill ${i + 1} photo`}
                    onChange={(e) => onFile(r.key, e.target.files?.[0] ?? null)} />
                  <span className="rounded border border-hairline px-2 py-1 hover:bg-paper-2">{r.reading ? "Reading…" : r.attachment ? "Change photo" : "Attach photo / PDF"}</span>
                  {r.fileName && <span className="truncate text-ink-3">{r.fileName}</span>}
                </label>
                {touched && p.problem && <p role="alert" className="text-xs text-rose">{PROBLEM_TEXT[p.problem]}</p>}
              </fieldset>
            );
          })}
          <datalist id="advance-bill-vendors">
            {(vendors ?? []).map((v) => <option key={v.id} value={v.name} />)}
          </datalist>
          <Button size="sm" variant="outline" icon="plus" onClick={() => setRows((rs) => [...rs, blankRow()])}>Add another bill</Button>
          {readNote && <p className="text-xs text-ink-3">{readNote}</p>}

          <div className="rounded-md border border-hairline bg-paper-2/50 p-3 text-xs space-y-1" aria-live="polite">
            <div className="flex justify-between"><span>Bills</span><span className="font-semibold tabular-nums">{rupee(split.total)}</span></div>
            <div className="flex justify-between"><span>From the advance</span><span className="tabular-nums">{rupee(split.fromAdvance)}</span></div>
            <div className="flex justify-between border-t border-hairline pt-1 font-semibold">
              <span>Left with {advance.employee_name}</span><span className="tabular-nums">{rupee(split.left)}</span>
            </div>
          </div>

          {split.extra > 0 && (
            <label className="flex items-start gap-2 rounded-md border border-amber/50 bg-amber-soft/20 p-3 text-xs cursor-pointer">
              <input type="checkbox" checked={reimburse} onChange={(e) => setReimburse(e.target.checked)} className="mt-0.5" />
              <span>
                <b>Reimburse {rupee(split.extra)} to {advance.employee_name}</b> — the bills are {rupee(split.extra)} more than the advance, paid from their own money.
                It is booked as a reimbursement (owed to them); when you pay it, reconcile that bank line as &quot;Reimbursement to employee&quot;.
              </span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" icon="check" loading={add.isPending} disabled={!canSave} onClick={save}>
            {filled.length > 0 ? `Book ${filled.length} bill${filled.length === 1 ? "" : "s"} (${rupee(split.total)})` : "Book bills"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
