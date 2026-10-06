/**
 * Campaigns — budget & target — /marketing/campaigns
 *
 * Phase 3 (Pardeep, 26 Sep 2026): a campaign is a name, dates, a budget and a target
 * ("Diwali offer: ₹20,000, 1–31 Oct, 30 leads"). Spend comes from expenses tagged with it;
 * leads from tracking links carrying its code. Each card answers: how much is used, is it
 * on pace, how many leads against the target, what does a lead / a deal cost.
 * Arithmetic: lib/marketing/campaign-metrics.ts. (Email campaigns are a different thing, at
 * /campaigns.)
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/providers/confirm-provider";
import { COPY } from "@/lib/copy";
import { rupee, cn, formatDate } from "@/lib/utils";
import { campaignMetrics, campaignCode, todayIso, type CampaignPhase } from "@/lib/marketing/campaign-metrics";
import { sourceLabel } from "@/lib/leads/lead-sources";
import {
  useMarketingCampaigns, useSaveCampaign, useDeleteCampaign,
  type CampaignRow, type MarketingCampaign,
} from "@/lib/queries/marketing-campaigns";

const PHASE: Record<CampaignPhase, { label: string; kind: "info" | "success" | "muted" | "warning" }> = {
  upcoming:  { label: "Upcoming", kind: "info" },
  running:   { label: "Running", kind: "success" },
  ended:     { label: "Ended",      kind: "muted" },
  cancelled: { label: "Cancelled", kind: "warning" },
};

type Draft = Omit<MarketingCampaign, "id"> & { id?: string };

export default function MarketingCampaignsPage() {
  const q = useMarketingCampaigns();
  const [editing, setEditing] = React.useState<Draft | null>(null);
  const today = todayIso();
  const rows = q.data ?? [];
  const running = rows.filter((r) => campaignMetrics(r, r.actuals, today).phase === "running");
  const totals = running.reduce((t, r) => ({ budget: t.budget + r.budget, spend: t.spend + r.actuals.spend, leads: t.leads + r.actuals.leads }), { budget: 0, spend: 0, leads: 0 });

  const blank = (): Draft => {
    const s = new Date(); const e = new Date(); e.setDate(e.getDate() + 30);
    const iso = (d: Date) => todayIso(d);
    return { name: "", code: "", start_date: iso(s), end_date: iso(e), budget: 0, target_leads: null, target_won: null, cancelled: false, notes: null };
  };

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Campaigns — budget &amp; target</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            Each campaign's budget, dates and target. Spend counts once an expense is tagged with the campaign; leads count
            when they come in through the campaign's tracking link.
          </p>
        </div>
        <Button icon="plus" onClick={() => setEditing(blank())}>New campaign</Button>
      </header>

      {running.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <Tile label="Running campaigns" value={String(running.length)} />
          <Tile label="Their spend / budget" value={`${rupee(totals.spend)} / ${rupee(totals.budget)}`} />
          <Tile label="Their leads" value={String(totals.leads)} />
        </div>
      )}

      {q.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">{[1, 2].map((i) => <Skeleton key={i} className="h-56" />)}</div>
      ) : q.error ? (
        <Card className="p-4 text-sm text-red-600">{(q.error as Error).message}</Card>
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="target" title="No campaigns yet"
            body="For example: “Diwali offer — ₹20,000, 1–31 Oct, 30 leads”. Create a campaign, put its tracking link in your ads, and pick the campaign on the ad bill." />
          <div className="flex justify-center pb-4"><Button onClick={() => setEditing(blank())}>Create your first campaign</Button></div>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rows.map((r) => <CampaignCard key={r.id} r={r} today={today} onEdit={() => setEditing({ ...r })} />)}
        </div>
      )}

      {editing && <EditDialog draft={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">{label}</p>
      <p className="font-serif text-xl leading-none text-ink">{value}</p>
    </Card>
  );
}

function Bar({ pct, tone }: { pct: number; tone: "ok" | "warn" | "bad" }) {
  return (
    <div className="h-1.5 rounded-full bg-paper-2 overflow-hidden">
      <div className={cn("h-full", tone === "bad" ? "bg-red-500" : tone === "warn" ? "bg-amber" : "bg-emerald")} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

function CampaignCard({ r, today, onEdit }: { r: CampaignRow; today: string; onEdit: () => void }) {
  const m = campaignMetrics(r, r.actuals, today);
  const [open, setOpen] = React.useState(false);
  const del = useDeleteCampaign();
  const confirm = useConfirm();
  const ph = PHASE[m.phase];
  const paceText = m.pace === "overspending" ? `${rupee(m.paceGap ?? 0)} over plan — budget will run out early`
    : m.pace === "underspending" ? `${rupee(Math.abs(m.paceGap ?? 0))} under plan`
    : m.pace === "on_track" ? "On plan" : null;

  return (
    <Card className={cn("p-4 space-y-3", m.phase === "cancelled" && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-ink">{r.name}</div>
          <div className="text-xs text-ink-3">
            {formatDate(r.start_date)} – {formatDate(r.end_date)} · <code>{r.code}</code>
            {m.phase === "running" && <> · day {m.daysElapsed}/{m.days}</>}
          </div>
        </div>
        <Badge kind={ph.kind} size="sm">{ph.label}</Badge>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-ink-2">Kharcha</span>
          <span className={cn("tabular-nums", m.overBudget ? "text-red-600 font-medium" : "text-ink-2")}>
            {rupee(r.actuals.spend)}{r.budget > 0 && <> / {rupee(r.budget)} ({m.budgetUsedPct}%)</>}
          </span>
        </div>
        {r.budget > 0 && <Bar pct={m.budgetUsedPct ?? 0} tone={m.overBudget ? "bad" : m.pace === "overspending" ? "warn" : "ok"} />}
        {paceText && <p className={cn("text-xs", m.pace === "overspending" ? "text-amber-ink" : "text-ink-3")}>{paceText}</p>}
      </div>

      <div className="space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-ink-2">Leads</span>
          <span className="tabular-nums text-ink-2">{r.actuals.leads}{r.target_leads ? <> / {r.target_leads} ({m.leadsPct}%)</> : null}</span>
        </div>
        {r.target_leads ? <Bar pct={m.leadsPct ?? 0} tone={(m.leadsPct ?? 0) >= 100 ? "ok" : "warn"} /> : null}
      </div>

      <div className="grid grid-cols-4 gap-2 text-center">
        <Stat label="Deals" value={`${r.actuals.won}${r.target_won ? `/${r.target_won}` : ""}`} />
        <Stat label="Per lead" value={m.costPerLead !== null ? rupee(m.costPerLead) : "—"} />
        <Stat label="Per deal" value={m.costPerWon !== null ? rupee(m.costPerWon) : "—"} />
        <Stat label="ROAS" value={m.roas !== null ? `${m.roas}×` : "—"} />
      </div>
      {r.notes && <p className="text-xs text-ink-2 italic">{r.notes}</p>}

      <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-2">
        <Link href={`/marketing/links?campaign=${encodeURIComponent(r.code)}` as Route}>
          <Button variant="outline" size="sm" icon="globe">Create tracking link</Button>
        </Link>
        <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>{open ? "Hide details" : `Details (${r.expenses.length} expenses · ${r.leadList.length} leads)`}</Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={async () => {
          const ok = await confirm({ title: "Delete campaign?", body: "Expenses and leads stay — they are only unlinked from this campaign.", danger: true, confirmLabel: COPY.delete, cancelLabel: COPY.cancel });
          if (ok) del.mutate(r.id);
        }}>Delete</Button>
      </div>

      {open && (
        <div className="space-y-3 text-xs">
          <div>
            <p className="font-semibold text-ink-2 mb-1">Kharche</p>
            {r.expenses.length === 0 ? <p className="text-ink-3">None. Tag a marketing expense (or use the Spend page) with this campaign.</p> : (
              <ul className="divide-y divide-hairline">
                {r.expenses.map((e) => (
                  <li key={e.id} className="flex justify-between gap-2 py-1">
                    <span className="text-ink-2">{formatDate(e.expense_date)} · {e.vendor_name || e.description || e.category}</span>
                    <span className="tabular-nums">{rupee(e.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="font-semibold text-ink-2 mb-1">Leads</p>
            {r.leadList.length === 0 ? <p className="text-ink-3">None. Put the campaign's tracking link in your ads / posts.</p> : (
              <ul className="divide-y divide-hairline">
                {r.leadList.map((l) => (
                  <li key={l.id} className="flex justify-between gap-2 py-1">
                    <Link href={`/leads?lead=${l.id}` as Route} className="text-ink hover:underline">{l.company}</Link>
                    <span className="text-ink-3">{sourceLabel(l.utm_source)} · {l.stage}{l.stage === "won" && l.value ? ` · ${rupee(l.value)}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-paper-2/60 px-1 py-1.5">
      <div className="text-xs text-ink-3">{label}</div>
      <div className="text-sm font-medium text-ink tabular-nums">{value}</div>
    </div>
  );
}

function EditDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const save = useSaveCampaign();
  const [d, setD] = React.useState<Draft>(draft);
  const [codeTouched, setCodeTouched] = React.useState(Boolean(draft.id));
  const code = codeTouched ? d.code : campaignCode(d.name);
  const problem = d.name.trim().length < 2 ? "Enter a name."
    : !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(code) ? "Code: lowercase letters, numbers and - (e.g. diwali-2026)."
    : d.end_date < d.start_date ? "End date cannot be before the start date." : null;
  const num = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.round(Number(v) || 0)));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>{d.id ? "Edit campaign" : "New campaign"}</DialogTitle>
          <DialogDescription>The code goes into the tracking link — do not change it once created, or leads from older links will be split off.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="Name" required htmlFor="mc_name">
            <Input id="mc_name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Diwali offer 2026" />
          </FormField>
          <FormField label="Code (in the link)" htmlFor="mc_code">
            <Input id="mc_code" value={code} onChange={(e) => { setCodeTouched(true); setD({ ...d, code: e.target.value.trim().toLowerCase() }); }} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Start" htmlFor="mc_start"><Input id="mc_start" type="date" value={d.start_date} onChange={(e) => setD({ ...d, start_date: e.target.value })} /></FormField>
            <FormField label="End" htmlFor="mc_end"><Input id="mc_end" type="date" value={d.end_date} onChange={(e) => setD({ ...d, end_date: e.target.value })} /></FormField>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <FormField label="Budget (₹)" htmlFor="mc_budget"><Input id="mc_budget" type="number" min={0} value={d.budget || ""} onChange={(e) => setD({ ...d, budget: num(e.target.value) ?? 0 })} /></FormField>
            <FormField label="Target leads" htmlFor="mc_tl"><Input id="mc_tl" type="number" min={0} value={d.target_leads ?? ""} onChange={(e) => setD({ ...d, target_leads: num(e.target.value) })} /></FormField>
            <FormField label="Target deals" htmlFor="mc_tw"><Input id="mc_tw" type="number" min={0} value={d.target_won ?? ""} onChange={(e) => setD({ ...d, target_won: num(e.target.value) })} /></FormField>
          </div>
          <FormField label="Note" htmlFor="mc_notes">
            <Input id="mc_notes" value={d.notes ?? ""} onChange={(e) => setD({ ...d, notes: e.target.value || null })} placeholder="e.g. Facebook + Google, Workspace Starter 20% off" />
          </FormField>
          {d.id && (
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={d.cancelled} onChange={(e) => setD({ ...d, cancelled: e.target.checked })} /> Campaign cancel kar diya
            </label>
          )}
          {problem && <p className="text-xs text-red-600">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!!problem || save.isPending} onClick={async () => {
            await save.mutateAsync({ ...d, name: d.name.trim(), code, notes: d.notes?.trim() || null });
            onClose();
          }}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
