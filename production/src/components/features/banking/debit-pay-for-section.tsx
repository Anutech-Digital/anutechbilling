/**
 * R-1866 — "Paying a vendor? This payment is for:" on a money-out bank line (Banking → Reconcile).
 * The vendor side of R-1838's "This money is for:".
 *
 *   1. Vendor — guessed from the narration (UPI id, account no., name), changeable, or added on
 *      the spot (name, GSTIN, PAN, usual TDS section).
 *   2. What it pays —
 *        (a) that vendor's open bills: COGS bills and unpaid expense bills, oldest first, the exact
 *            match (or the match after TDS) ticked; several bills share the amount oldest-first,
 *            a COGS bill's share is editable (part payment);
 *        (b) a bill that was never entered — recorded and paid in the same step;
 *        (c) an advance (nothing billed yet, or the extra over the bills).
 *      TDS: the vendor's section pre-filled, the rate and threshold from the app's TDS config.
 *      A bank charge on the line is its own expense.
 *   3. The maths, then one button → one server transaction (lib/queries/bank-debit-pay-for.ts),
 *      and the sheet says what happened, with links.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { useVendors } from "@/lib/queries/vendors";
import { useVendorTdsThisFy, EXPENSE_CATEGORIES } from "@/lib/queries/expenses";
import { VENDOR_BILL_CATEGORIES } from "@/lib/queries/vendor-bills";
import { TDS_SECTION_RATES } from "@/lib/accounting/tds-rates";
import type { BankTransactionRow } from "@/lib/queries/bank";
import { useVendorOpenItems, usePayVendorFromBankDebit, useVendor194q, useSet194qBuyer } from "@/lib/queries/bank-debit-pay-for";
import {
  allocateOldestFirst, cashDue, guessVendor, isRecorded, itemKey, itemLabel, newBillTds, newBillTotal, planTds, preselect,
  resultLines, summarise, tdsMap, vendorPan,
  type NewBillDraft, type VendorLite, type VendorOpenItem, type VendorPayResult,
} from "@/lib/banking/debit-pay-for";
import type { VendorFocus } from "@/lib/banking/vendor-line-guard";

const NEW_VENDOR = "__new_vendor__";
const TDS_SECTIONS = Object.keys(TDS_SECTION_RATES);
const EXPENSE_CATS = EXPENSE_CATEGORIES.filter((c) => c !== "Salaries");

const selectCls =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

interface Props {
  transaction: BankTransactionRow;
  /** The line is booked — the parent hides the choices that no longer apply. */
  onSaved?: () => void;
  onDone: () => void;
  /** R-1917: the vendor this line is being paid to (guessed or picked) and its open items — the
   *  sheet makes this section the one way and guards "Book as expense" with it. null = no vendor. */
  onVendorChange?: (focus: VendorFocus | null) => void;
}

export function DebitPayForSection({ transaction, onSaved, onDone, onVendorChange }: Props) {
  const debit = transaction.debit ?? 0;

  /* ── 1. Vendor ───────────────────────────────────────────────────────────── */
  const { data: vendorRows } = useVendors();
  const vendors = React.useMemo<VendorLite[]>(
    () => (vendorRows ?? []).map((v) => v as unknown as VendorLite),
    [vendorRows],
  );
  const guess = React.useMemo(() => guessVendor(transaction, vendors), [transaction, vendors]);
  const [vendorId, setVendorId] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const [nv, setNv] = React.useState({ name: "", gstin: "", pan: "", tdsSection: "" });
  React.useEffect(() => { setVendorId(""); setTouched(false); setNv({ name: "", gstin: "", pan: "", tdsSection: "" }); }, [transaction.id]);
  React.useEffect(() => { if (!touched && guess && !vendorId) setVendorId(guess.vendorId); }, [guess, touched, vendorId]);
  const isNew = vendorId === NEW_VENDOR;
  const vendor = isNew ? null : vendors.find((v) => v.id === vendorId) ?? null;
  const vendorName = isNew ? nv.name.trim() : vendor?.name ?? "";

  /* ── 2. Open bills ───────────────────────────────────────────────────────── */
  const { data: items, isLoading: itemsLoading } = useVendorOpenItems(vendor?.id ?? null);
  const open = React.useMemo(() => items ?? [], [items]);
  /* R-1917: tell the sheet which vendor this line is for, with its open items once loaded. */
  React.useEffect(() => {
    if (!onVendorChange) return;
    onVendorChange(vendorName ? { vendorId: vendor?.id ?? null, vendorName, openItems: vendor && items ? items : [] } : null);
  }, [onVendorChange, vendorName, vendor, items]);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [cashEdit, setCashEdit] = React.useState<Record<string, number>>({});

  /* TDS — the vendor's usual section, else the one already on its bills. */
  const [section, setSection] = React.useState("");
  const [noTds, setNoTds] = React.useState(false);
  React.useEffect(() => {
    const fromBills = open.find((i) => i.tds_section)?.tds_section ?? "";
    setSection((isNew ? nv.tdsSection : vendor?.default_tds_section) || fromBills || "");
    setNoTds(false);
  }, [vendor?.id, vendor?.default_tds_section, isNew, nv.tdsSection, open]);
  const pan = isNew ? (nv.pan.trim() || null) : vendorPan(vendor);
  const { data: fy } = useVendorTdsThisFy(vendor?.id ?? null, vendorName, section, transaction.txn_date);
  const pickedItems = React.useMemo(() => open.filter((i) => picked.has(itemKey(i))), [open, picked]);
  /* The vendor's other payments this FY: the year so far (which already holds the unpaid
     expense bills) less the bills now being paid. */
  const othersFor = React.useCallback((bills: readonly VendorOpenItem[]) => {
    if (!fy) return null;
    const exp = bills.filter((i) => i.source === "expense");
    return {
      base: Math.max(0, fy.base - exp.reduce((s, i) => s + i.tds_base, 0)),
      baseWithoutTds: Math.max(0, fy.baseWithoutTds - exp.filter((i) => i.tds_amount === 0).reduce((s, i) => s + i.tds_base, 0)),
    };
  }, [fy]);
  const fyOthers = othersFor(pickedItems);
  /* R-1891: 194Q on goods (COGS) bills — the database's figure per bill, and the company's
     answer to "turnover last FY above ₹10 crore?". */
  const { data: q194rows } = useVendor194q(vendor?.id ?? null);
  const q194 = React.useMemo(() => new Map((q194rows ?? []).map((r) => [r.doc_id, r])), [q194rows]);
  const buyer = q194rows?.[0]?.buyer ?? null;
  const setBuyer = useSet194qBuyer();
  const tdsOpts = { section: section || null, pan, fyOthers, off: noTds, q194 };
  const tdsLines = planTds(pickedItems, tdsOpts);
  const tdsByKey = tdsMap(tdsLines);

  /* Pre-select once per vendor / bill list: the exact bill (after TDS, or without it), or all of
     them when together they make the bank amount. Waits for the year's TDS figures. */
  const preKey = `${vendorId}|${open.map(itemKey).join(",")}`;
  const [preDone, setPreDone] = React.useState("");
  React.useEffect(() => {
    if (!items || preDone === preKey || (section && !fy) || (section === "194Q" && vendor && !q194rows)) return;
    const pre = preselect(items, debit, (bills) => tdsMap(planTds(bills, { section: section || null, pan, fyOthers: othersFor(bills), off: false, q194 })), transaction.txn_date);
    setPicked(new Set(pre.keys));
    if (pre.noTds) setNoTds(true);
    setCashEdit({});
    setPreDone(preKey);
  }, [items, preKey, preDone, debit, section, pan, fy, othersFor, vendor, q194rows, q194, transaction.txn_date]);
  /* A picked goods bill that crosses ₹50 lakh this year — 194Q may apply. */
  const goodsOver = pickedItems.some((i) => i.source === "vendor_bill" && (q194.get(i.doc_id)?.base ?? 0) > 0);
  React.useEffect(() => { setPicked(new Set()); setCashEdit({}); setPreDone(""); }, [transaction.id, vendorId]);

  /* (b) New bill on the spot. */
  const [showNew, setShowNew] = React.useState(false);
  const [bill, setBill] = React.useState<NewBillDraft>({
    kind: "expense", billNo: "", billDate: transaction.txn_date, category: "", taxable: 0, gst: 0, itc: true, pay: 0,
  });
  React.useEffect(() => {
    setShowNew(false);
    setBill({ kind: "expense", billNo: "", billDate: transaction.txn_date, category: "", taxable: 0, gst: 0, itc: true, pay: 0 });
  }, [transaction.id, transaction.txn_date, vendorId]);
  React.useEffect(() => {
    const cat = vendor?.default_category ?? "";
    if (cat) setBill((b) => ({ ...b, kind: cat.startsWith("COGS-") ? "cogs" : "expense", category: cat }));
  }, [vendor?.default_category]);
  const billTotal = newBillTotal(bill);
  const billTds = bill.kind === "expense" ? newBillTds(Math.round(bill.taxable || 0), tdsOpts) : { tds: 0, section: null, reason: null };
  const billPay = bill.kind === "expense" ? billTotal : Math.min(billTotal, Math.round(bill.pay || billTotal));
  const newBillCash = showNew && billTotal > 0 ? Math.max(0, billPay - billTds.tds) : 0;
  const newBillBad = showNew && (!(bill.taxable > 0) || !bill.category || (bill.kind === "cogs" && !(billPay > 0)));

  /* (c) Advance + bank charge. */
  const [charge, setCharge] = React.useState(0);
  const [advEdited, setAdvEdited] = React.useState<number | null>(null);
  const [advCategory, setAdvCategory] = React.useState("");
  React.useEffect(() => { setCharge(0); setAdvEdited(null); setAdvCategory(""); }, [transaction.id, vendorId]);

  /* Allocation: oldest first over what is left after the new bill and the charge; a COGS bill's
     share can be typed over (part payment). */
  const pool = Math.max(0, debit - newBillCash - charge);
  const auto = allocateOldestFirst(pickedItems, pool, tdsByKey);
  const cashOf = (i: VendorOpenItem) => {
    const k = itemKey(i);
    return i.can_part && cashEdit[k] !== undefined ? cashEdit[k] : auto.cashByKey.get(k) ?? 0;
  };
  const billsCash = pickedItems.reduce((s, i) => s + cashOf(i), 0);
  /* The extra over the bills is an advance; with open bills and none ticked nothing is assumed —
     the operator picks the bills or types the advance. */
  const autoAdvance = pickedItems.length || showNew || open.length === 0 ? Math.max(0, debit - billsCash - newBillCash - charge) : 0;
  const advance = advEdited ?? autoAdvance;
  const sum = summarise(debit, { bills: billsCash, newBill: newBillCash, advance, charge });
  const starved = pickedItems.filter((i) => cashOf(i) <= 0);
  const tdsTotal = pickedItems.reduce((s, i) => s + (cashOf(i) > 0 ? tdsByKey.get(itemKey(i)) ?? 0 : 0), 0) + (showNew ? billTds.tds : 0);
  const grossBills = pickedItems.reduce((s, i) => s + (cashOf(i) > 0 ? cashOf(i) + (tdsByKey.get(itemKey(i)) ?? 0) : 0), 0) + (showNew ? (bill.kind === "expense" ? billTotal : billPay) : 0);

  /* ── 3. Save ─────────────────────────────────────────────────────────────── */
  const pay = usePayVendorFromBankDebit();
  const [result, setResult] = React.useState<VendorPayResult | null>(null);
  React.useEffect(() => { setResult(null); }, [transaction.id]);
  const advCat = advCategory || (vendor?.default_category && !vendor.default_category.startsWith("COGS-") ? vendor.default_category : "") || "Other";
  const nothingPicked = pickedItems.length === 0 && !showNew && advance <= 0;
  const canSave = Boolean(vendorName) && !pay.isPending && sum.diff === 0 && !nothingPicked && !newBillBad && starved.length === 0;
  /* R-1911: the line only matches payments already recorded — the button says so. */
  const onlyMatch = pickedItems.length > 0 && pickedItems.every(isRecorded) && !showNew && advance <= 0 && charge <= 0;

  const save = async () => {
    if (!canSave) return;
    try {
      const r = await pay.mutateAsync({
        transactionId: transaction.id,
        vendorId: vendor?.id ?? null,
        newVendor: isNew ? { name: nv.name, gstin: nv.gstin || null, pan: nv.pan || null, tdsSection: nv.tdsSection || null } : null,
        items: pickedItems.map((i) => {
          const t = tdsLines.find((x) => x.key === itemKey(i));
          return { item: i, cash: cashOf(i), tds: t?.tds ?? 0, section: t?.section ?? null };
        }),
        newBill: showNew ? { ...bill, pay: billPay, tds: billTds.tds, tdsSection: billTds.section } : null,
        advance,
        advanceCategory: advance > 0 ? advCat : null,
        bankCharge: charge,
        note: null,
      });
      setResult(r);
      onSaved?.();
    } catch { /* the hook toasts */ }
  };

  if (debit <= 0) return null;

  if (result) {
    return (
      <section aria-labelledby="vpay-done-h" className="rounded-md border border-emerald/40 bg-emerald-soft/25 p-3 space-y-2">
        <p id="vpay-done-h" className="text-xs font-semibold text-ink-2 inline-flex items-center gap-1">
          <Icon name="check" size={14} className="text-emerald" /> Done — this bank line is reconciled
        </p>
        <ul className="space-y-1">
          {resultLines(result).map((l, i) => (
            <li key={i} className={`text-sm break-words ${l.tone === "warn" ? "text-amber-ink" : "text-ink"}`}>
              {l.href ? <Link href={l.href as never} className="underline hover:no-underline">{l.text}</Link> : l.text}
            </li>
          ))}
        </ul>
        <Button size="sm" variant="primary" onClick={onDone}>Close</Button>
      </section>
    );
  }

  const toggle = (i: VendorOpenItem) => setPicked((s) => {
    const n = new Set(s); const k = itemKey(i);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  return (
    <section aria-labelledby="vpay-h" className="rounded-md border border-amber/50 bg-amber-soft/25 p-3 space-y-3">
      <div>
        <p id="vpay-h" className="text-xs font-semibold text-ink-2">Paying a vendor? This payment is for:</p>
        <p className="text-xs text-ink-3 mt-0.5">Pick the vendor and the bills it pays — bills are marked paid, TDS is recorded, extra money stays as an advance. A payment already recorded on the Bills or Expenses page is listed first: match this line to it so it is counted once.</p>
      </div>

      {/* 1. Vendor */}
      <div className="space-y-1">
        <select
          value={vendorId}
          onChange={(e) => { setVendorId(e.target.value); setTouched(true); }}
          aria-label="Vendor paid"
          className={selectCls}
        >
          <option value="" disabled>Who was paid? Select a vendor…</option>
          <option value={NEW_VENDOR}>＋ New vendor</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        {guess && vendorId === guess.vendorId && !touched && (
          <p className="text-xs text-ink-3">Guessed from {guess.reason} — change it if wrong.</p>
        )}
      </div>

      {isNew && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 rounded-md border border-hairline bg-paper p-2.5">
          <Input aria-label="New vendor name" placeholder="Vendor name" value={nv.name} onChange={(e) => setNv({ ...nv, name: e.target.value })} className="sm:col-span-2" />
          <Input aria-label="GSTIN (optional)" placeholder="GSTIN (optional)" value={nv.gstin} onChange={(e) => setNv({ ...nv, gstin: e.target.value.toUpperCase() })} />
          <Input aria-label="PAN (optional)" placeholder="PAN (optional)" value={nv.pan} onChange={(e) => setNv({ ...nv, pan: e.target.value.toUpperCase() })} />
          <select aria-label="Usual TDS section" value={nv.tdsSection} onChange={(e) => setNv({ ...nv, tdsSection: e.target.value })} className={`${selectCls} sm:col-span-2`}>
            <option value="">No TDS usually</option>
            {TDS_SECTIONS.map((s) => <option key={s} value={s}>{s} · {TDS_SECTION_RATES[s].ratePct}%</option>)}
          </select>
        </div>
      )}

      {vendorName && (
        <>
          {/* 2a. Open bills */}
          {vendor && (itemsLoading ? <Skeleton className="h-16" /> : open.length === 0 ? (
            <p className="text-xs text-ink-3">{vendor.name} has no unpaid bills. Record the bill below, or keep the money as an advance.</p>
          ) : (
            <ul className="space-y-1.5" aria-label="Open bills of this vendor">
              {open.map((i) => {
                const k = itemKey(i);
                const on = picked.has(k);
                const t = tdsLines.find((x) => x.key === k);
                const tds = on ? t?.tds ?? 0 : 0;
                const cash = on ? cashOf(i) : 0;
                const exact = cashDue(i, i.tds_amount) === debit;
                /* R-1911: a payment already recorded on the Bills / Expenses page — this line is
                   MATCHED to it (it replaces that entry), never paid again. */
                if (isRecorded(i)) {
                  return (
                    <li key={k} className={`rounded-md border p-2.5 ${on ? "border-emerald bg-emerald-soft/30" : "border-hairline bg-paper"}`}>
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input type="checkbox" className="mt-1" checked={on} onChange={() => toggle(i)} aria-label={`Match this bank line to the payment ${itemLabel(i)}`} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-ink break-words">{itemLabel(i)} — match this bank line to it</span>
                            {exact && <Badge kind="success" size="sm">Exact amount</Badge>}
                          </span>
                          <span className="block text-xs text-ink-3 tabular-nums">
                            {rupee(i.amount_due)} recorded as paid{i.total > i.amount_due ? ` on a ${rupee(i.total)} bill` : ""} — this bank line takes its place, so it is counted once.
                          </span>
                        </span>
                      </label>
                      {on && cash <= 0 && (
                        <p className="mt-2 pl-6 text-xs text-rose-ink">Not enough left on this line for it ({rupee(i.amount_due)} needed) — untick it.</p>
                      )}
                    </li>
                  );
                }
                return (
                  <li key={k} className={`rounded-md border p-2.5 ${on ? "border-amber bg-amber/10" : "border-hairline bg-paper"}`}>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input type="checkbox" className="mt-1" checked={on} disabled={Boolean(i.in_run)} onChange={() => toggle(i)} aria-label={`Pay ${itemLabel(i)}`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm text-ink break-words">{itemLabel(i)}</span>
                          <Badge kind="muted" size="sm">{i.source === "vendor_bill" ? "COGS bill" : i.category ?? "Expense"}</Badge>
                          {exact && <Badge kind="success" size="sm">Exact amount</Badge>}
                        </span>
                        <span className="block text-xs text-ink-3 tabular-nums">
                          Due {rupee(i.amount_due)}{i.amount_due !== i.total ? ` of ${rupee(i.total)}` : ""}{i.due_date ? ` · due date ${formatDate(i.due_date)}` : ""}
                          {i.tds_amount > 0 ? ` · TDS ${rupee(i.tds_amount)} on the bill` : ""}
                        </span>
                        {i.in_run && <span className="block text-xs text-amber-ink">In payment run {i.in_run} — mark that run paid instead.</span>}
                      </span>
                    </label>
                    {on && (
                      <div className="mt-2 pl-6 flex flex-wrap items-center gap-2 text-xs text-ink-2 tabular-nums">
                        {i.can_part ? (
                          <label className="inline-flex items-center gap-1.5">
                            <span>Pays ₹</span>
                            <Input type="number" min={0} className="w-28 h-8" aria-label={`Amount paid on ${itemLabel(i)}`}
                              value={String(cash)}
                              onChange={(e) => setCashEdit((c) => ({ ...c, [k]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
                            {tds > 0 && cash > 0 && <span>+ TDS {rupee(tds)} ({t?.section}) = {rupee(cash + tds)} settled</span>}
                            {cash > 0 && cash + tds < i.amount_due && <span className="text-amber-ink">part payment — {rupee(i.amount_due - cash - tds)} stays due</span>}
                          </label>
                        ) : cash > 0 ? (
                          <span>{rupee(i.amount_due)}{tds > 0 ? <> − TDS {rupee(tds)} ({t?.section}) = <b>{rupee(cash)}</b> from bank</> : <> from bank</>}</span>
                        ) : (
                          <span className="text-rose-ink">Not enough left for this bill ({rupee(cashDue(i, tds))} needed) — untick it or record the rest as an advance.</span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ))}

          {/* TDS */}
          {(pickedItems.some((i) => i.source === "expense") || (showNew && bill.kind === "expense") || goodsOver) && (
            <div className="rounded-md border border-hairline bg-paper p-2.5 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-ink-2">TDS deducted</span>
                <select aria-label="TDS section" value={noTds ? "" : section} onChange={(e) => { setSection(e.target.value); setNoTds(!e.target.value); }} className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink">
                  <option value="">No TDS</option>
                  {TDS_SECTIONS.map((s) => <option key={s} value={s}>{s} · {TDS_SECTION_RATES[s].ratePct}%</option>)}
                </select>
              </div>
              {[...tdsLines.filter((t) => t.reason && (!t.fixed || t.section === "194Q")).map((t) => t.reason), showNew ? billTds.reason : null]
                .filter(Boolean).slice(-1).map((r) => <p key="r" className="text-xs text-ink-3">{r}</p>)}
              {/* R-1891: 194Q needs one answer about the company, asked here the first time. */}
              {goodsOver && !noTds && section === "194Q" && buyer === null && (
                <div className="rounded-md border border-amber/50 bg-amber-soft/30 p-2 space-y-1.5" role="group" aria-label="194Q turnover question">
                  <p className="text-xs text-ink">
                    194Q TDS applies only if your business turnover last financial year was <b>above ₹10 crore</b>. Was it?
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="primary" loading={setBuyer.isPending} onClick={() => setBuyer.mutate(true)}>Yes, above ₹10 crore — deduct 194Q</Button>
                    <Button size="sm" variant="default" disabled={setBuyer.isPending} onClick={() => setBuyer.mutate(false)}>No</Button>
                  </div>
                </div>
              )}
              {goodsOver && !noTds && section === "194Q" && buyer === false && (
                <p className="text-xs text-ink-3">
                  No 194Q: you said your turnover last year was not above ₹10 crore.{" "}
                  <button type="button" className="underline hover:no-underline" onClick={() => setBuyer.mutate(true)}>It was above — deduct 194Q</button>
                </p>
              )}
            </div>
          )}

          {/* 2b. New bill on the spot */}
          <div className="rounded-md border border-hairline bg-paper p-2.5 space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium text-ink-2 cursor-pointer">
              <input type="checkbox" checked={showNew} onChange={(e) => setShowNew(e.target.checked)} />
              The bill is not in the books yet — record it now
            </label>
            {showNew && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Bill type">
                  {([["expense", "Expense bill"], ["cogs", "COGS bill (resale)"]] as const).map(([k, label]) => (
                    <button key={k} type="button" aria-pressed={bill.kind === k}
                      onClick={() => setBill((b) => ({ ...b, kind: k, category: k === "cogs" ? "COGS-Other" : (vendor?.default_category && !vendor.default_category.startsWith("COGS-") ? vendor.default_category : "") }))}
                      className={`rounded-md border px-2 py-1.5 text-xs font-medium text-left ${bill.kind === k ? "border-amber bg-amber/10 text-amber-ink" : "border-hairline text-ink-2"}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input aria-label="Bill number" placeholder="Bill number" value={bill.billNo} onChange={(e) => setBill({ ...bill, billNo: e.target.value })} />
                  <Input aria-label="Bill date" type="date" value={bill.billDate} onChange={(e) => setBill({ ...bill, billDate: e.target.value })} />
                  <select aria-label="Category" value={bill.category} onChange={(e) => setBill({ ...bill, category: e.target.value })} className={`${selectCls} sm:col-span-2`}>
                    <option value="" disabled>Category…</option>
                    {(bill.kind === "cogs" ? VENDOR_BILL_CATEGORIES : EXPENSE_CATS).map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <label className="text-xs text-ink-3 space-y-0.5">
                    <span className="block">Value before GST ₹</span>
                    <Input type="number" min={0} aria-label="Value before GST" value={bill.taxable ? String(bill.taxable) : ""} onChange={(e) => setBill({ ...bill, taxable: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                  </label>
                  <label className="text-xs text-ink-3 space-y-0.5">
                    <span className="block">GST ₹</span>
                    <Input type="number" min={0} aria-label="GST on the bill" value={bill.gst ? String(bill.gst) : ""} onChange={(e) => setBill({ ...bill, gst: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                  </label>
                </div>
                {bill.gst > 0 && (
                  <label className="flex items-center gap-2 text-xs text-ink-2 cursor-pointer">
                    <input type="checkbox" checked={bill.itc} onChange={(e) => setBill({ ...bill, itc: e.target.checked })} />
                    Claim input GST credit (a GST tax invoice from a registered vendor)
                  </label>
                )}
                {bill.kind === "cogs" && billTotal > 0 && (
                  <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                    <span>Paying now ₹</span>
                    <Input type="number" min={0} className="w-28 h-8" aria-label="Amount paid on the new bill" value={String(billPay)} onChange={(e) => setBill({ ...bill, pay: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                    <span className="text-ink-3">of {rupee(billTotal)}</span>
                  </label>
                )}
                {billTotal > 0 && (
                  <p className="text-xs text-ink-2 tabular-nums">
                    Bill {rupee(billTotal)}{billTds.tds > 0 ? <> − TDS {rupee(billTds.tds)} ({billTds.section})</> : null} = <b>{rupee(newBillCash)}</b> from bank
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 2c. Advance + bank charge */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="text-xs text-ink-3 space-y-0.5">
              <span className="block">{pickedItems.length || showNew ? "Extra kept as advance ₹" : "Advance to vendor (nothing billed yet) ₹"}</span>
              <Input type="number" min={0} aria-label="Advance to vendor" value={String(advance)} onChange={(e) => setAdvEdited(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
            </label>
            <label className="text-xs text-ink-3 space-y-0.5">
              <span className="block">Bank charge on this line ₹</span>
              <Input type="number" min={0} aria-label="Bank charge" value={charge ? String(charge) : ""} onChange={(e) => setCharge(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
            </label>
            {advance > 0 && (
              <label className="text-xs text-ink-3 space-y-0.5 sm:col-span-2">
                <span className="block">The advance will be used for</span>
                <select aria-label="Advance category" value={advCat} onChange={(e) => setAdvCategory(e.target.value)} className={selectCls}>
                  {EXPENSE_CATS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
          </div>

          {/* 3. The maths */}
          <div className="rounded-md border border-hairline bg-paper px-2.5 py-2 text-xs text-ink-2 tabular-nums space-y-0.5" aria-live="polite">
            {grossBills > 0 && <p>Bills {rupee(grossBills)}{tdsTotal > 0 ? <> − TDS {rupee(tdsTotal)}</> : null} = {rupee(sum.bills + sum.newBill)}</p>}
            {sum.advance > 0 && <p>+ advance {rupee(sum.advance)}</p>}
            {sum.charge > 0 && <p>+ bank charge {rupee(sum.charge)}</p>}
            {sum.diff === 0
              ? <p className="text-emerald inline-flex items-center gap-1"><Icon name="check" size={12} /> = {rupee(debit)} paid from the bank</p>
              : <p className="text-rose-ink">{sum.diff > 0 ? `${rupee(sum.diff)} of the ${rupee(debit)} is not placed yet` : `${rupee(-sum.diff)} more than the ${rupee(debit)} the bank paid`} — adjust the amounts.</p>}
          </div>

          <Button size="sm" variant="primary" icon="check" disabled={!canSave} loading={pay.isPending} onClick={save}
            className="whitespace-normal h-auto min-h-8 py-1.5 text-left max-w-full">
            {onlyMatch ? `Match ${rupee(debit)} to the payment already recorded & reconcile` : `Record payment ${rupee(debit)} to ${vendorName} & reconcile`}
          </Button>
        </>
      )}
    </section>
  );
}
