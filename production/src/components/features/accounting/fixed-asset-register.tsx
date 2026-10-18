/**
 * Fixed asset register — the assets, this year's depreciation, WDV; add / dispose;
 * the schedule as CSV for the CA / ITR (lib/accounting/depreciation.ts).
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FormField } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useConfirm } from "@/components/providers/confirm-provider";
import { rupee, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { useFixedAssets, useCreateFixedAsset, useDisposeFixedAsset, useDeleteFixedAsset, useCapitalisableExpenses, type FixedAsset } from "@/lib/queries/fixed-assets";
import { useEmiPurchases } from "@/lib/queries/emi";
import { useEmployeeAssets } from "@/lib/queries/employee-assets";
import { BLOCKS, depreciationSchedule, depreciationInFy, bookValueAt, registerSummary, fyStartOf, fyLabel, type AssetBlock } from "@/lib/accounting/depreciation";
import { istToday } from "@/lib/dates/ist";

function todayIso(): string { return istToday(); }

export function FixedAssetRegister() {
  const { data: assets, isLoading } = useFixedAssets();
  const { data: issued } = useEmployeeAssets();
  const holder = new Map((issued ?? []).filter((a) => !a.returned_on && a.fixed_asset_id).map((a) => [a.fixed_asset_id as string, a.employee_name]));
  const dispose = useDisposeFixedAsset();
  const del = useDeleteFixedAsset();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = React.useState(false);
  const [disposeFor, setDisposeFor] = React.useState<FixedAsset | null>(null);
  const today = todayIso();
  const fy = fyStartOf(today);
  const rows = assets ?? [];
  const summary = registerSummary(rows, fy);

  function exportSchedule() {
    const out: (string | number)[][] = [];
    for (const a of rows) {
      out.push([a.name, BLOCKS[a.block].label, `${BLOCKS[a.block].ratePct}%`, a.cost, a.put_to_use, "", "", "", ""]);
      for (const r of depreciationSchedule(a, fy)) out.push(["", "", "", "", `FY ${r.fyLabel}`, r.opening, `${r.ratePct}%${r.halfRate ? " (half — <180 days)" : ""}`, r.depreciation, r.closing]);
    }
    out.push([], [`Totals FY ${fyLabel(fy)}`, "", "", summary.cost, "", summary.openingWdv, "", summary.depreciation, summary.closingWdv]);
    downloadCSV(`Depreciation-schedule-FY${fyLabel(fy)}.csv`, ["Asset", "Block", "Rate", "Cost", "Put to use / FY", "Opening WDV", "Rate applied", "Depreciation", "Closing WDV"], out);
  }

  return (
    <section className="mt-8">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="font-serif text-2xl text-ink">Fixed asset register</h2>
          <p className="text-sm text-ink-3 mt-0.5">
            Jo cheezein saalon chalti hain (laptop, furniture, gaadi) — kharcha nahi, asset. Har saal Income-tax WDV rate se depreciation; Balance Sheet par WDV dikhta hai.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 0 && <Button variant="outline" size="sm" icon="download" onClick={exportSchedule}>Depreciation schedule (CSV)</Button>}
          <Button variant="primary" size="sm" icon="plus" onClick={() => setAddOpen(true)}>Add asset</Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="layout" title="Koi asset register mein nahi" body="Laptop, phone, furniture, AC — jo bhi ₹ 10,000+ ka saalon chalega, yahan jodo (Equipment kharche se bhi utha sakte ho). Depreciation apne aap." />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <Card className="p-3"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Cost</div><div className="font-serif text-xl text-ink mt-0.5">{rupee(summary.cost)}</div></Card>
            <Card className="p-3"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Opening WDV FY {fyLabel(fy)}</div><div className="font-serif text-xl text-ink mt-0.5">{rupee(summary.openingWdv)}</div></Card>
            <Card className="p-3"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Depreciation this FY</div><div className="font-serif text-xl text-amber-ink mt-0.5">{rupee(summary.depreciation)}</div></Card>
            <Card className="p-3"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Closing WDV</div><div className="font-serif text-xl text-ink mt-0.5">{rupee(summary.closingWdv)}</div></Card>
          </div>
          <Card flush>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                  <tr>
                    <th className="text-left px-3 py-2">Asset</th>
                    <th className="text-left px-3 py-2">Block · rate</th>
                    <th className="text-right px-3 py-2">Cost</th>
                    <th className="text-left px-3 py-2">Put to use</th>
                    <th className="text-right px-3 py-2">Dep. FY {fyLabel(fy)}</th>
                    <th className="text-right px-3 py-2">WDV (Balance Sheet)</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {rows.map((a) => {
                    const sold = !!a.disposed_on;
                    return (
                      <tr key={a.id} className={sold ? "opacity-60" : ""}>
                        <td className="px-3 py-2 text-ink">{a.name}{holder.get(a.id) && <span className="ml-2 text-xs text-indigo">with {holder.get(a.id)}</span>}{sold && <span className="ml-2 text-xs text-ink-3">sold {formatDate(a.disposed_on!)} for {rupee(a.disposal_value)}</span>}</td>
                        <td className="px-3 py-2 text-ink-2 text-xs">{BLOCKS[a.block].label} · {BLOCKS[a.block].ratePct}%</td>
                        <td className="px-3 py-2 text-right font-mono">{rupee(a.cost)}</td>
                        <td className="px-3 py-2 text-ink-2 text-xs">{formatDate(a.put_to_use)}{fyStartOf(a.put_to_use) === fy && depreciationSchedule(a, fy)[0]?.halfRate ? <span className="ml-1 text-amber-ink">(½ rate — &lt;180 din)</span> : null}</td>
                        <td className="px-3 py-2 text-right font-mono text-amber-ink">{rupee(depreciationInFy(a, fy))}</td>
                        <td className="px-3 py-2 text-right font-mono font-semibold text-ink">{rupee(bookValueAt(a, today))}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {!sold && <Button variant="ghost" size="sm" onClick={() => setDisposeFor(a)}>Sold / scrap</Button>}
                          <button type="button" aria-label="Delete asset" className="rounded p-1.5 text-ink-3 hover:bg-paper-2 hover:text-rose"
                            onClick={async () => { if (await confirm({ title: "Asset register se hatayein?", body: `${a.name} — sirf register se hatega; jis kharche/EMI se aaya tha wo waisa hi rahega.`, confirmLabel: "Hatao", danger: true })) del.mutate(a.id); }}>
                            <Icon name="trash" size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {addOpen && <AddAssetDialog onClose={() => setAddOpen(false)} />}
      {disposeFor && (
        <DisposeDialog asset={disposeFor} onClose={() => setDisposeFor(null)}
          onSave={(d, v) => dispose.mutate({ id: disposeFor.id, disposedOn: d, disposalValue: v }, { onSuccess: () => setDisposeFor(null) })} pending={dispose.isPending} />
      )}
    </section>
  );
}

function AddAssetDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateFixedAsset();
  const { data: candidates } = useCapitalisableExpenses();
  const { data: emis } = useEmiPurchases();
  const { data: existing } = useFixedAssets();
  const usedExp = new Set((existing ?? []).map((a) => a.expense_id).filter(Boolean));
  const usedEmi = new Set((existing ?? []).map((a) => a.emi_purchase_id).filter(Boolean));
  const [source, setSource] = React.useState<string>("");   // "exp:<id>" | "emi:<id>" | ""
  const [name, setName] = React.useState("");
  const [block, setBlock] = React.useState<AssetBlock>("computers");
  const [cost, setCost] = React.useState("");
  const [putToUse, setPutToUse] = React.useState(todayIso());
  const [notes, setNotes] = React.useState("");

  function pickSource(v: string) {
    setSource(v);
    if (v.startsWith("exp:")) {
      const e = (candidates ?? []).find((c) => c.id === v.slice(4));
      if (e) { setName(e.description || e.vendor_name || "Equipment"); setCost(String((e.amount ?? 0) - (e.gst_paid ?? 0))); setPutToUse(e.expense_date); }
    } else if (v.startsWith("emi:")) {
      const p = (emis ?? []).find((c) => c.id === v.slice(4));
      if (p) { setName(p.name); setCost(String(p.total_cost)); setPutToUse(p.purchased_on); setBlock(p.category === "vehicle" ? "vehicles" : p.category === "furniture" ? "furniture" : p.category === "property" ? "building" : "plant"); }
    }
  }
  const costN = Math.round(Number(cost) || 0);
  const valid = name.trim().length > 0 && costN > 0 && !!putToUse;

  async function submit() {
    if (!valid) return;
    try {
      await create.mutateAsync({
        name, block, cost: costN, putToUse, notes: notes || null,
        expenseId: source.startsWith("exp:") ? source.slice(4) : null,
        emiPurchaseId: source.startsWith("emi:") ? source.slice(4) : null,
      });
      onClose();
    } catch { /* hook toasts */ }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>Add fixed asset</DialogTitle>
          <DialogDescription>Cost GST ke bina (ITC liya ho to). Put-to-use date se depreciation shuru — 180 din se kam chala to us saal aadha rate.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="Kahan se aaya" htmlFor="fa_src">
            <select id="fa_src" value={source} onChange={(e) => pickSource(e.target.value)} className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink">
              <option value="">Naya — haath se bharo</option>
              {(emis ?? []).filter((p) => !usedEmi.has(p.id)).map((p) => <option key={p.id} value={`emi:${p.id}`}>EMI purchase · {p.name} · {rupee(p.total_cost)} · {formatDate(p.purchased_on)}</option>)}
              {(candidates ?? []).filter((c) => !usedExp.has(c.id)).map((c) => <option key={c.id} value={`exp:${c.id}`}>Equipment kharcha · {c.vendor_name ?? c.description ?? c.id} · {rupee((c.amount ?? 0) - (c.gst_paid ?? 0))} · {formatDate(c.expense_date)}</option>)}
            </select>
          </FormField>
          <FormField label="Asset" required htmlFor="fa_name"><Input id="fa_name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. MacBook Air M3 — Pardeep" /></FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Block (Income-tax)" required htmlFor="fa_block">
              <select id="fa_block" value={block} onChange={(e) => setBlock(e.target.value as AssetBlock)} className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink">
                {(Object.keys(BLOCKS) as AssetBlock[]).map((b) => <option key={b} value={b}>{BLOCKS[b].label} · {BLOCKS[b].ratePct}%</option>)}
              </select>
              <p className="text-xs text-ink-3 mt-1">{BLOCKS[block].examples}</p>
            </FormField>
            <FormField label="Cost (₹, ex-GST)" required htmlFor="fa_cost"><Input id="fa_cost" type="number" min={1} prefix="₹" value={cost} onChange={(e) => setCost(e.target.value)} /></FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Put to use" required htmlFor="fa_date"><Input id="fa_date" type="date" value={putToUse} max={todayIso()} onChange={(e) => setPutToUse(e.target.value)} /></FormField>
            <FormField label="Note" htmlFor="fa_notes"><Input id="fa_notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="serial no., kiske paas" /></FormField>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" disabled={!valid} loading={create.isPending} onClick={submit}>Add asset</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisposeDialog({ asset, onClose, onSave, pending }: { asset: FixedAsset; onClose: () => void; onSave: (d: string, v: number) => void; pending: boolean }) {
  const [date, setDate] = React.useState(todayIso());
  const [value, setValue] = React.useState("0");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Sold / scrapped — {asset.name}</DialogTitle>
          <DialogDescription>Us saal depreciation nahi lagegi; WDV aur mili raqam ka farq block par gain/loss hai (CA ke liye schedule mein likha aata hai).</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Date" required htmlFor="fd_date"><Input id="fd_date" type="date" value={date} min={asset.put_to_use} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></FormField>
          <FormField label="Mila (₹)" htmlFor="fd_val"><Input id="fd_val" type="number" min={0} prefix="₹" value={value} onChange={(e) => setValue(e.target.value)} /></FormField>
        </div>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Cancel</Button>
          <Button type="button" variant="primary" loading={pending} disabled={!date} onClick={() => onSave(date, Math.round(Number(value) || 0))}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
