"use client";

/**
 * Create / edit a package (2 Oct 2026). Name, one-line pitch, discount, and the parts:
 * each a catalogue item, per seat or a fixed count, required or optional, in order.
 * A live price for the preview seat count sits under the parts, so the operator sees
 * what a rep will quote before saving.
 */
import * as React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { rupee } from "@/lib/utils";
import type { Item } from "@/lib/supabase/database.types";
import { pricePackage, type PackageRow } from "@/lib/packages/price";
import { useSavePackage, type PackageDraft } from "@/lib/queries/packages";
import { headlinePrice, headlineSuffix } from "@/lib/catalog/headline-price";
import { billingUnitOf, isPerSeat } from "@/lib/catalog/billing-unit";

type Part = PackageDraft["items"][number];

const blank: PackageDraft = { id: null, name: "", pitch: "", discount_pct: 0, is_active: true, items: [] };

export function PackageEditor({ open, onOpenChange, initial, catalog }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: PackageRow | null;
  catalog: Item[];
}) {
  const save = useSavePackage();
  const [d, setD] = React.useState<PackageDraft>(blank);
  const [pick, setPick] = React.useState("");
  const [previewSeats, setPreviewSeats] = React.useState(10);

  React.useEffect(() => {
    if (!open) return;
    setPick("");
    setD(initial ? {
      id: initial.id, name: initial.name, pitch: initial.pitch ?? "", discount_pct: initial.discount_pct,
      is_active: initial.is_active,
      items: initial.items.map((i) => ({ item_id: i.item_id, qty_mode: i.qty_mode, fixed_qty: i.fixed_qty, optional: i.optional })),
    } : blank);
  }, [open, initial]);

  const sellable = React.useMemo(
    () => catalog.filter((c) => c.is_active !== false && c.item_type !== "one_time" && !d.items.some((p) => p.item_id === c.id))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [catalog, d.items],
  );

  const setPart = (idx: number, patch: Partial<Part>) =>
    setD((s) => ({ ...s, items: s.items.map((p, i) => (i === idx ? { ...p, ...patch } : p)) }));
  const move = (idx: number, by: -1 | 1) =>
    setD((s) => {
      const j = idx + by;
      if (j < 0 || j >= s.items.length) return s;
      const items = [...s.items];
      [items[idx], items[j]] = [items[j], items[idx]];
      return { ...s, items };
    });
  const addPart = (id: string) => {
    const it = catalog.find((c) => c.id === id);
    if (!it) return;
    /* A licence is per seat; support, a domain, hosting, a migration — one of them (R-526: by the item's unit). */
    const perSeat = isPerSeat(billingUnitOf(it));
    setD((s) => ({ ...s, items: [...s.items, { item_id: id, qty_mode: perSeat ? "per_seat" : "fixed", fixed_qty: perSeat ? null : 1, optional: false }] }));
    setPick("");
  };

  const preview = pricePackage(
    { id: d.id ?? "new", name: d.name, pitch: d.pitch, discount_pct: d.discount_pct, is_active: d.is_active, sort_order: 0,
      items: d.items.map((p, i) => ({ ...p, sort_order: i })) },
    catalog, previewSeats,
  );

  const nameOk = d.name.trim().length >= 2;
  const problem = !nameOk ? "Give the package a name." : d.items.length === 0 ? "Add at least one item." : null;

  const submit = () => {
    if (problem) return;
    save.mutate({ ...d, name: d.name.trim(), discount_pct: Math.min(30, Math.max(0, d.discount_pct || 0)) }, {
      onSuccess: () => onOpenChange(false),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{d.id ? "Edit package" : "New package"}</DialogTitle>
          <DialogDescription>Prices come from your catalogue, so they stay right when the catalogue changes.</DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <FormField label="Name" htmlFor="pkgName">
            <Input id="pkgName" value={d.name} maxLength={80} placeholder="e.g. Starter Office" onChange={(e) => setD({ ...d, name: e.target.value })} />
          </FormField>
          <FormField label="One line for the rep (optional)" htmlFor="pkgPitch">
            <Input id="pkgPitch" value={d.pitch} maxLength={240} placeholder="What problem this solves" onChange={(e) => setD({ ...d, pitch: e.target.value })} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Package discount %" htmlFor="pkgDisc">
              <Input id="pkgDisc" type="number" min={0} max={30} step={0.5} value={d.discount_pct}
                onChange={(e) => setD({ ...d, discount_pct: Math.min(30, Math.max(0, parseFloat(e.target.value) || 0)) })} />
            </FormField>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" checked={d.is_active} onChange={(e) => setD({ ...d, is_active: e.target.checked })} className="accent-amber" />
              Show on quotes
            </label>
          </div>

          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-ink-3 mb-2">Items</div>
            {d.items.length === 0 && <p className="text-sm text-ink-3 mb-2">No items yet — pick one below.</p>}
            <ul className="space-y-2">
              {d.items.map((p, idx) => {
                const it = catalog.find((c) => c.id === p.item_id);
                const hp = it ? headlinePrice(it) : null;
                return (
                  <li key={p.item_id} className="rounded-md border border-hairline p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-ink truncate">{it?.name ?? p.item_id}</div>
                        <div className="text-2xs text-ink-3">
                          {it ? `${rupee(hp!.amount)}${headlineSuffix(it)}` : <span className="text-amber-ink">Not active in the catalogue</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <IconButton icon="chevron_up" size="sm" aria-label="Move up" onClick={() => move(idx, -1)} disabled={idx === 0} title={idx === 0 ? "Already first" : "Move up"} />
                        <IconButton icon="chevron_down" size="sm" aria-label="Move down" onClick={() => move(idx, 1)} disabled={idx === d.items.length - 1} title={idx === d.items.length - 1 ? "Already last" : "Move down"} />
                        <IconButton icon="trash" size="sm" aria-label={`Remove ${it?.name ?? p.item_id}`} onClick={() => setD((s) => ({ ...s, items: s.items.filter((_, i) => i !== idx) }))} />
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-3 flex-wrap text-xs">
                      <select
                        aria-label="Quantity"
                        value={p.qty_mode}
                        onChange={(e) => setPart(idx, { qty_mode: e.target.value, fixed_qty: e.target.value === "fixed" ? (p.fixed_qty ?? 1) : null })}
                        className="rounded border border-hairline bg-paper px-1.5 py-1"
                      >
                        <option value="per_seat">One per seat</option>
                        <option value="fixed">Fixed quantity</option>
                      </select>
                      {p.qty_mode === "fixed" && (
                        <input type="number" min={1} value={p.fixed_qty ?? 1} aria-label="Fixed quantity"
                          onChange={(e) => setPart(idx, { fixed_qty: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                          className="w-16 rounded border border-hairline bg-paper px-1.5 py-1 tabular-nums" />
                      )}
                      <label className="inline-flex items-center gap-1.5">
                        <input type="checkbox" checked={p.optional} onChange={(e) => setPart(idx, { optional: e.target.checked })} className="accent-amber" />
                        Optional (rep can untick)
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
            <select
              aria-label="Add an item to the package"
              value={pick}
              onChange={(e) => addPart(e.target.value)}
              className="mt-2 w-full rounded-md border border-dashed border-hairline bg-paper px-2.5 py-2 text-sm text-ink-2"
            >
              <option value="">+ Add an item from the catalogue…</option>
              {sellable.map((c) => {
                const hp = headlinePrice(c);
                return <option key={c.id} value={c.id}>{c.name} — {rupee(hp.amount)}{headlineSuffix(c)}</option>;
              })}
            </select>
          </div>

          {preview.parts.length > 0 && (
            <div className="rounded-md bg-paper-2/60 px-3 py-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-ink-3">
                  Price for
                  <input type="number" min={1} value={previewSeats} aria-label="Preview seats"
                    onChange={(e) => setPreviewSeats(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-14 rounded border border-hairline bg-paper px-1.5 py-0.5 tabular-nums" />
                  seats
                </label>
                <span className="font-serif text-lg tabular-nums">{rupee(preview.total)}<span className="text-3xs text-ink-3 font-sans">/yr</span></span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-2xs text-ink-3">
                <span>{preview.marginPct !== null ? `Est. margin ${preview.marginPct}%` : ""}</span>
                {preview.saving > 0 && <span className="text-emerald">Customer saves {rupee(preview.saving)}</span>}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 pb-6 flex items-center justify-between gap-3">
          <span className="text-xs text-amber-ink">{problem ?? ""}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" onClick={submit} loading={save.isPending} disabled={!!problem} title={problem ?? undefined}>
              {d.id ? "Save package" : "Create package"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
