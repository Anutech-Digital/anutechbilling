/**
 * Private Vault → Wealth. The investment portfolio.
 *
 * ─── EVERY VALUE HERE IS TYPED BY A HUMAN ───────────────────────────────────
 * There is no AMC feed, no NSE quote, no gold price API. That is a deliberate limit, not
 * an oversight: a live price for a mutual fund folio needs a CAMS/KFin integration and
 * the owner's PAN, and a half-connected feed that silently stops updating is worse than
 * a number somebody knows they typed.
 *
 * The consequence is that `valued_on` carries the whole honesty of this screen. A
 * holding is shown with how old its number is, and anything past the threshold is
 * called out — because "₹42,00,000" reads as today's figure whether or not it is.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Money } from "@/components/ui/money";
import { EmptyState } from "@/components/shared/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConfirm } from "@/components/providers/confirm-provider";
import { VaultLoadError } from "@/components/features/vault/vault-load-error";
import {
  usePersonalHoldings,
  useSavePersonalHolding,
  useDeletePersonalHolding,
  type PersonalHolding,
} from "@/lib/queries/personal-vault";
import {
  computeNetWorth,
  ASSET_CLASSES,
  ASSET_CLASS_LABEL,
  STALE_AFTER_DAYS,
  type AssetClass,
} from "@/lib/vault/personal/net-worth";
import { formatDate, rupee } from "@/lib/utils";

interface FormState {
  id?: string;
  asset_class: AssetClass;
  name: string;
  invested: string;
  current_value: string;
  units: string;
  valued_on: string;
  notes: string;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const EMPTY: FormState = {
  asset_class: "mutual_fund", name: "", invested: "", current_value: "",
  units: "", valued_on: todayIso(), notes: "",
};

function parseRupees(value: string): number | null {
  const cleaned = value.replace(/[,\s₹]/g, "");
  if (cleaned === "") return 0;
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Math.round(Number(cleaned));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** How stale is one holding's figure? Returns null when it is fresh enough to say nothing. */
function stalenessNote(valuedOn: string | null, now: Date): string | null {
  if (!valuedOn) return "value kabhi update nahi hua";
  const d = new Date(valuedOn);
  if (Number.isNaN(d.getTime())) return "value ki date samajh nahi aayi";
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days > STALE_AFTER_DAYS) return `${days} din purana`;
  return null;
}

export default function PersonalWealthPage() {
  const { data, isLoading, error } = usePersonalHoldings();
  const save = useSavePersonalHolding();
  const del = useDeletePersonalHolding();
  const confirm = useConfirm();

  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<FormState>(EMPTY);

  const now = React.useMemo(() => new Date(), []);
  // Memoised: a fresh [] each render would re-run computeNetWorth on every keystroke.
  const rows = React.useMemo(() => data ?? [], [data]);
  const nw = React.useMemo(() => computeNetWorth([], rows, now), [rows, now]);

  const openNew = () => { setForm(EMPTY); setOpen(true); };
  const openEdit = (h: PersonalHolding) => {
    setForm({
      id: h.id,
      asset_class: h.asset_class,
      name: h.name,
      invested: String(h.invested ?? 0),
      current_value: String(h.current_value ?? 0),
      units: h.units === null ? "" : String(h.units),
      valued_on: h.valued_on ?? "",
      notes: h.notes ?? "",
    });
    setOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Enter the investment name", { description: "For example \"HDFC Flexi Cap\" or \"SBI FD\"." }); return; }

    const invested = parseRupees(form.invested);
    const current = parseRupees(form.current_value);
    if (invested === null) { toast.error("Amount invested must be a number", { description: "Type digits only, e.g. 50000. No commas or ₹ sign needed." }); return; }
    if (current === null) { toast.error("Current value must be a number", { description: "Type digits only, e.g. 56000. No commas or ₹ sign needed." }); return; }

    const units = form.units.trim() === "" ? null : Number(form.units);
    if (units !== null && !Number.isFinite(units)) { toast.error("Units must be a number", { description: "Leave it blank if you don't track units." }); return; }

    try {
      await save.mutateAsync({
        id: form.id,
        asset_class: form.asset_class,
        name: form.name.trim(),
        invested,
        current_value: current,
        units,
        // Left null when blank rather than silently stamped today — a value nobody
        // dated must not look freshly checked.
        valued_on: form.valued_on || null,
        notes: form.notes.trim() || null,
      });
      toast.success(form.id ? "Holding updated" : "Holding added");
      setOpen(false);
    } catch { /* the hook surfaced it */ }
  };

  const handleDelete = async (h: PersonalHolding) => {
    const ok = await confirm({
      title: `"${h.name}" hata dein?`,
      body: `Aaj ki value ${rupee(h.current_value)}.`,
      confirmLabel: "Hata do",
      danger: true,
    });
    if (!ok) return;
    await del.mutateAsync(h.id);
    toast.success("Holding hata di.");
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-3">
          Mutual fund, share, property, gold/SGB, LIC, PPF — sab ek jagah.
        </p>
        <Button variant="primary" onClick={openNew} className="flex-shrink-0">
          <Icon name="plus" size={14} className="mr-1.5" />
          Investment add karo
        </Button>
      </div>

      {error && <VaultLoadError error={error} />}

      {isLoading && <Skeleton className="h-48 w-full rounded-xl" />}

      {!isLoading && !error && rows.length === 0 && (
        <Card className="p-6">
          <EmptyState
            icon="trending_up"
            title="Abhi koi investment nahi"
            body="Apne mutual fund, share, property ya PPF add karo. Values aapko khud update karni hongi — koi market feed nahi juda hua."
            action={<Button onClick={openNew}>Pehli investment</Button>}
          />
        </Card>
      )}

      {!isLoading && rows.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-4">Aaj ki value</p>
              <div className="mt-0.5"><Money amount={nw.investments} size="display" /></div>
            </Card>
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-4">Lagaya tha</p>
              <div className="mt-0.5"><Money amount={nw.investedTotal} size="display" /></div>
            </Card>
            <Card className="p-4">
              <p className="text-2xs uppercase tracking-wide text-ink-4">Faayda / nuksaan</p>
              <div className="mt-0.5">
                <Money amount={nw.portfolioGain} size="display" />
              </div>
              {nw.portfolioGainPct !== null && (
                <p className={`text-2xs mt-0.5 ${nw.portfolioGain >= 0 ? "text-emerald" : "text-rose"}`}>
                  {nw.portfolioGain >= 0 ? "+" : ""}{nw.portfolioGainPct.toFixed(1)}%
                </p>
              )}
            </Card>
          </div>

          {(nw.neverValuedCount > 0 || nw.staleCount > 0) && (
            <div className="rounded-lg border border-amber/30 bg-amber-soft p-3 flex gap-2.5">
              <Icon name="alert" size={15} className="text-amber-ink flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-ink leading-relaxed">
                Upar ka total poora bharosemand nahi hai: <b>{rupee(nw.staleValue)}</b> ka figure purana ya
                bina date ka hai. Neeche jin par nishaan laga hai, unki value update kar do.
              </p>
            </div>
          )}

          <Card className="p-0 overflow-hidden">
            <ul className="divide-y divide-hairline">
              {rows.map((h) => {
                const stale = stalenessNote(h.valued_on, now);
                const gain = h.current_value - h.invested;
                return (
                  <li key={h.id} className="px-4 py-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-ink">{h.name}</span>
                        <Badge kind="muted" size="sm">{ASSET_CLASS_LABEL[h.asset_class]}</Badge>
                        {stale && <Badge kind="warning" size="sm">{stale}</Badge>}
                      </div>
                      <p className="text-xs text-ink-3 mt-0.5">
                        lagaya {rupee(h.invested)}
                        {h.units !== null && <> · {h.units} units</>}
                        {h.valued_on && <> · value {formatDate(h.valued_on)} ki</>}
                        {h.notes && <> · {h.notes}</>}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <Money amount={h.current_value} size="cell" />
                      <p className={`text-2xs mt-0.5 ${gain >= 0 ? "text-emerald" : "text-rose"}`}>
                        {gain >= 0 ? "+" : ""}{rupee(gain)}
                      </p>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => openEdit(h)} aria-label="Edit">
                        <Icon name="edit" size={14} />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => handleDelete(h)} aria-label="Delete" className="text-rose">
                        <Icon name="trash" size={14} />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{form.id ? "Investment edit karo" : "Nayi investment"}</DialogTitle>
            <DialogDescription className="text-xs">
              Value aapko khud update karni hogi — koi market feed juda hua nahi hai.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="vw-kind" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Kis tarah ka</label>
                <Select value={form.asset_class} onValueChange={(v) => setForm((f) => ({ ...f, asset_class: v as AssetClass }))}>
                  <SelectTrigger id="vw-kind"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ASSET_CLASSES.map((c) => <SelectItem key={c} value={c}>{ASSET_CLASS_LABEL[c]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label htmlFor="vw-units" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Units (optional)</label>
                <Input id="vw-units"
                  value={form.units}
                  onChange={(e) => setForm((f) => ({ ...f, units: e.target.value }))}
                  placeholder="120.5"
                  inputMode="decimal"
                />
              </div>
            </div>

            <div>
              <label htmlFor="vw-name" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Naam</label>
              <Input id="vw-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Parag Parikh Flexi Cap / Dwarka flat"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="vw-invested" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Lagaya tha (₹)</label>
                <Input id="vw-invested"
                  value={form.invested}
                  onChange={(e) => setForm((f) => ({ ...f, invested: e.target.value }))}
                  placeholder="500000"
                  inputMode="numeric"
                />
              </div>
              <div>
                <label htmlFor="vw-current-value" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Aaj ki value (₹)</label>
                <Input id="vw-current-value"
                  value={form.current_value}
                  onChange={(e) => setForm((f) => ({ ...f, current_value: e.target.value }))}
                  placeholder="640000"
                  inputMode="numeric"
                />
              </div>
            </div>

            <div>
              <label htmlFor="vw-value-date" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Value kis din ki hai</label>
              <Input id="vw-value-date"
                type="date"
                value={form.valued_on}
                onChange={(e) => setForm((f) => ({ ...f, valued_on: e.target.value }))}
              />
              <p className="text-2xs text-ink-4 mt-1">
                Khali chhod doge to &quot;kabhi update nahi hua&quot; likha aayega — total ke saath.
              </p>
            </div>

            <div>
              <label htmlFor="vw-note" className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">Note</label>
              <Input id="vw-note"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="optional"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} loading={save.isPending}>
              {form.id ? "Update" : "Add"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
