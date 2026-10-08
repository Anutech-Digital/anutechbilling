/**
 * Marketing Hub — /marketing
 *
 * Pardeep, 26 Sep 2026: "jo tools mere paas hone chahiye is business ko chalane ke liye,
 * unko use karne ka ek system banao". One page that answers, for every marketing tool the
 * business should run: is it set up, where is the account, who runs it, what is its monthly
 * budget and how much has actually gone out this month — and where in this app its work is
 * done. The advice is the catalogue (lib/marketing/tool-catalog.ts); the state is the
 * `marketing_tools` table; spend is `expenses.channel`.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { rupee, cn, formatDate } from "@/lib/utils";
import {
  TOOL_GROUPS, TOOL_STATUS, mergeTools, hubSummary,
  type ToolGroup, type ToolRow, type ToolStatus,
} from "@/lib/marketing/tool-catalog";
import {
  useMarketingTools, useSaveMarketingTool, useSpendThisMonth,
  useEmailSuppressions, useRemoveSuppression,
} from "@/lib/queries/marketing-hub";
import { useConfirm } from "@/components/providers/confirm-provider";
import { COPY } from "@/lib/copy";
import { NavDirectory } from "@/components/layout/nav-directory";

const GROUP_ORDER: ToolGroup[] = ["ads", "listings", "messaging", "email", "website", "social"];

export default function MarketingHubPage() {
  const tools = useMarketingTools();
  const spend = useSpendThisMonth();
  const [editing, setEditing] = React.useState<ToolRow | null>(null);

  const rows = React.useMemo(() => mergeTools(tools.data ?? [], spend.data ?? {}), [tools.data, spend.data]);
  const sum = hubSummary(rows);
  const loading = tools.isLoading || spend.isLoading;

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Sell</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Marketing Hub</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-3xl">
          The marketing tools the business runs on — each one's status, account, owner,
          monthly budget vs actual spend, and where its work happens in the app.
        </p>
      </header>

      {/* S30: the fourteen marketing pages that used to be sidebar rows, in five groups.
          Read from APP_NAV (the Hub's `directory`), so this list and the nav cannot drift —
          it replaces the hand-kept QUICK list that stood here, which had nine of them. */}
      <NavDirectory parentId="marketing-hub" />

      {tools.error ? (
        <Card className="p-4 text-sm text-red-600">{(tools.error as Error).message}</Card>
      ) : loading ? (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Metric label="Tools running" value={`${sum.active} / ${sum.total}`} sub={`"Not needed" tools are not counted`} />
            <Metric label="Budget this month" value={rupee(sum.budget)} sub="Running tools only" />
            <Metric label="Spend this month" value={rupee(sum.spent)} sub="Channel-tagged marketing expenses" />
            <Metric
              label="Over budget"
              value={String(sum.overBudget.length)}
              sub={sum.overBudget.length ? sum.overBudget.map((r) => r.name.split(" (")[0]).join(", ") : "None"}
              warn={sum.overBudget.length > 0}
            />
          </div>

          {GROUP_ORDER.map((g) => {
            const list = rows.filter((r) => r.group === g);
            if (!list.length) return null;
            return (
              <section key={g} className="space-y-3">
                <div className="flex items-baseline gap-2 border-b border-hairline pb-1.5">
                  <h2 className="text-base font-semibold text-ink">{TOOL_GROUPS[g].title}</h2>
                  <span className="text-xs text-ink-3">{TOOL_GROUPS[g].why}</span>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {list.map((r) => <ToolCard key={r.key} r={r} onEdit={() => setEditing(r)} />)}
                </div>
              </section>
            );
          })}

          <OptOuts />
        </>
      )}

      {editing && <EditTool r={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Metric({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <Card className={cn("p-4", warn && "border-amber/40 bg-amber-soft/30")}>
      <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">{label}</p>
      <p className="font-serif text-2xl leading-none text-ink">{value}</p>
      {sub && <p className="text-xs text-ink-2 mt-2 leading-relaxed">{sub}</p>}
    </Card>
  );
}

function ToolCard({ r, onEdit }: { r: ToolRow; onEdit: () => void }) {
  const [open, setOpen] = React.useState(false);
  const st = TOOL_STATUS[r.state.status];
  const budget = r.state.monthly_budget;
  const spent = r.spentThisMonth;
  const pct = budget > 0 && spent !== null ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const over = budget > 0 && (spent ?? 0) > budget;
  const account = r.state.account_url || r.homeUrl;
  const external = /^https?:\/\//.test(account);

  return (
    <Card className={cn("p-4 space-y-2.5", r.state.status === "not_needed" && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-ink">{r.name}</div>
          <p className="text-xs text-ink-2 mt-0.5 leading-relaxed">{r.why}</p>
        </div>
        <Badge kind={st.kind} size="sm">{st.label}</Badge>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
        <span>Owner: <b className="text-ink-2 font-medium">{r.state.owner_name || "—"}</b></span>
        {r.channel && (
          <span>
            This month: <b className={cn("font-medium tabular-nums", over ? "text-red-600" : "text-ink-2")}>{rupee(spent ?? 0)}</b>
            {budget > 0 && <> / {rupee(budget)} budget</>}
          </span>
        )}
      </div>
      {budget > 0 && r.channel && (
        <div className="h-1.5 rounded-full bg-paper-2 overflow-hidden">
          <div className={cn("h-full", over ? "bg-red-500" : "bg-emerald")} style={{ width: `${pct}%` }} />
        </div>
      )}
      {r.state.notes && <p className="text-xs text-ink-2 italic">{r.state.notes}</p>}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {external ? (
          <a href={account} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 text-xs font-medium text-amber-ink hover:underline">
            Open account <Icon name="external" size={11} />
          </a>
        ) : (
          <Link href={account as Route} className="text-xs font-medium text-amber-ink hover:underline">{COPY.open} →</Link>
        )}
        {r.inApp.map((l) => (
          <Link key={l.href + l.label} href={l.href as Route}
                className="text-xs rounded-full border border-hairline px-2 py-0.5 text-ink-2 hover:border-amber/60">
            {l.label}
          </Link>
        ))}
        <span className="flex-1" />
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-ink-3 hover:text-ink" aria-expanded={open}>
          {open ? "Hide steps" : "Setup steps"}
        </button>
        <Button variant="outline" size="sm" onClick={onEdit}>Update</Button>
      </div>
      {open && (
        <ol className="list-decimal pl-5 space-y-1 text-xs text-ink-2 border-t border-hairline pt-2">
          {r.setup.map((s) => <li key={s}>{s}</li>)}
        </ol>
      )}
    </Card>
  );
}

function EditTool({ r, onClose }: { r: ToolRow; onClose: () => void }) {
  const save = useSaveMarketingTool();
  const [status, setStatus] = React.useState<ToolStatus>(r.state.status);
  const [url, setUrl] = React.useState(r.state.account_url ?? "");
  const [owner, setOwner] = React.useState(r.state.owner_name ?? "");
  const [budget, setBudget] = React.useState(r.state.monthly_budget ? String(r.state.monthly_budget) : "");
  const [notes, setNotes] = React.useState(r.state.notes ?? "");
  const urlBad = url.trim() !== "" && !/^https?:\/\/\S+$/i.test(url.trim());

  async function submit() {
    if (urlBad) return;
    await save.mutateAsync({
      tool_key: r.key, name: r.name, status,
      account_url: url.trim() || null, owner_name: owner.trim() || null,
      monthly_budget: Number(budget) || 0, notes: notes.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>{r.name}</DialogTitle>
          <DialogDescription>Status, account and budget. Spend comes from Expenses automatically.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormField label="Status" htmlFor="mt_status">
            <Select value={status} onValueChange={(v) => setStatus(v as ToolStatus)}>
              <SelectTrigger id="mt_status"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(TOOL_STATUS) as ToolStatus[]).map((k) => <SelectItem key={k} value={k}>{TOOL_STATUS[k].label}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Account link" htmlFor="mt_url">
            <Input id="mt_url" placeholder={r.homeUrl.startsWith("http") ? r.homeUrl : "https://…"} value={url} onChange={(e) => setUrl(e.target.value)} />
            {urlBad && <p className="mt-1 text-xs text-red-600">Enter the full link, starting with https://.</p>}
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Owner" htmlFor="mt_owner">
              <Input id="mt_owner" placeholder="e.g. Pardeep" value={owner} onChange={(e) => setOwner(e.target.value)} />
            </FormField>
            <FormField label="Monthly budget (₹)" htmlFor="mt_budget">
              <Input id="mt_budget" type="number" min={0} prefix="₹" value={budget} onChange={(e) => setBudget(e.target.value)}
                     disabled={!r.channel} />
            </FormField>
          </div>
          {!r.channel && <p className="text-xs text-ink-3 -mt-1">This tool's spend is not linked to a channel, so it has no budget.</p>}
          <FormField label="Note" htmlFor="mt_notes">
            <Input id="mt_notes" placeholder="e.g. login via the owner's Gmail" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </FormField>
          <p className="text-xs text-ink-3">Do not write passwords here — use Admin → Password Vault.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending || urlBad}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptOuts() {
  const q = useEmailSuppressions();
  const remove = useRemoveSuppression();
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const list = q.data ?? [];
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Email unsubscribe list</p>
          <p className="text-xs text-ink-3 mt-0.5">
            Every campaign email carries an unsubscribe link automatically. Anyone who opts out gets no more campaign email.
          </p>
        </div>
        <button type="button" className="text-sm text-amber-ink hover:underline whitespace-nowrap" onClick={() => setOpen((o) => !o)}>
          {list.length} {list.length === 1 ? "address" : "addresses"} {open ? "▲" : "▼"}
        </button>
      </div>
      {open && (
        <div className="mt-3 divide-y divide-hairline border-t border-hairline">
          {list.length === 0 ? (
            <p className="py-3 text-xs text-ink-3">Nobody has unsubscribed yet.</p>
          ) : list.map((s) => (
            <div key={s.email} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className="text-ink">{s.email}</span>
              <span className="flex items-center gap-3">
                <span className="text-xs text-ink-3">{formatDate(s.created_at)}</span>
                <Button variant="ghost" size="sm" onClick={async () => {
                  const ok = await confirm({
                    title: "Add back to the mailing list?",
                    body: `${s.email} unsubscribed themselves. Only remove this if they asked for emails again.`,
                    confirmLabel: "Yes, they asked", cancelLabel: COPY.cancel,
                  });
                  if (ok) remove.mutate(s.email);
                }}>{COPY.remove}</Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
