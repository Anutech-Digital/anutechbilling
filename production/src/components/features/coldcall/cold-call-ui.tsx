/**
 * Cold Calling — the shared pieces of the list page and the campaign page (R-1663)
 *
 * A calling list from a spreadsheet, rung by the AI voice agent (Bolna) on a schedule. What each
 * call came to lands on its row; a person moves the interested ones into Sales & Pipeline with a
 * button — nothing enters the pipeline on its own (Abhishek, 19 Oct 2026). DND numbers are kept
 * on the list, marked, and never called.
 *
 * Laid out as three numbered steps (add numbers → start → move the interested ones) so a
 * salesperson who has never seen it knows what to press next (Abhishek, 19 Oct: "more easy").
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { cn, formatDate } from "@/lib/utils";
import { canCallNow } from "@/lib/coldcall/coldcall";
import {
  ColdCallError, useColdContacts, useColdProducts, useCreateCampaign, useImportList,
  useDeleteContact, useMoveToPipeline, useTick, useUpdateCampaign, type ColdCampaign, type ColdContact, type ImportResult, type SkippedNumber,
} from "@/lib/queries/cold-calling";

type BadgeKind = "muted" | "success" | "warning" | "danger" | "info" | "outline";

export const STATUS: Record<string, { label: string; kind: BadgeKind }> = {
  pending:        { label: "Waiting",          kind: "muted" },
  calling:        { label: "Calling now",      kind: "info" },
  interested:     { label: "Hot — interested", kind: "success" },
  callback:       { label: "Warm — call back", kind: "warning" },
  answered:       { label: "Talked — unclear", kind: "outline" },
  not_interested: { label: "Not interested",   kind: "muted" },
  no_answer:      { label: "No answer",        kind: "muted" },
  failed:         { label: "Call failed",      kind: "danger" },
  skipped_dnd:    { label: "DND — not called", kind: "muted" },
  moved:          { label: "In pipeline",      kind: "success" },
};

export const CAMPAIGN_STATUS: Record<ColdCampaign["status"], { label: string; kind: BadgeKind }> = {
  draft:   { label: "Not started", kind: "muted" },
  running: { label: "Calling",     kind: "success" },
  paused:  { label: "Paused",      kind: "warning" },
  done:    { label: "Finished",    kind: "outline" },
};

/** The filter boxes. A box may cover a few statuses ("Waiting" = not yet rung + ringing now). */
const FILTERS = [
  { id: "all",            label: "All numbers",    statuses: [] as string[],                  tone: "ink" },
  { id: "interested",     label: "Interested",     statuses: ["interested"],                  tone: "emerald" },
  { id: "callback",       label: "Call back",      statuses: ["callback"],                    tone: "amber" },
  { id: "answered",       label: "Talked",         statuses: ["answered"],                    tone: "ink" },
  { id: "waiting",        label: "Waiting",        statuses: ["pending", "calling"],          tone: "ink" },
  { id: "not_reached",    label: "Not reached",    statuses: ["no_answer", "failed"],         tone: "ink" },
  { id: "not_interested", label: "Not interested", statuses: ["not_interested"],              tone: "ink" },
  { id: "skipped_dnd",    label: "DND",            statuses: ["skipped_dnd"],                 tone: "ink" },
  { id: "moved",          label: "In pipeline",    statuses: ["moved"],                       tone: "emerald" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

/** Statuses a person may move into the pipeline — anyone who actually spoke to the agent. */
const MOVABLE = new Set(["interested", "callback", "answered"]);

const SAMPLE_CSV =
  "Phone,Name,Company,City,DND\n" +
  "9876543210,Rahul Sharma,Sharma Traders,Delhi,\n" +
  "+91 98111 22334,Neha Gupta,Gupta & Co CA,Noida,\n" +
  "9988776655,Amit Verma,Verma Logistics,Gurugram,Yes\n";

export function downloadSample() {
  const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "cold-calling-sample.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function failToast(err: unknown, fallback: string) {
  if (err instanceof ColdCallError) {
    toast.error(err.message, { description: err.detail ?? "Try again in a moment." });
  } else {
    toast.error(fallback, { description: "Check your internet connection and try again." });
  }
}

export function total(c: ColdCampaign): number {
  return Object.values(c.counts).reduce((a, b) => a + b, 0);
}

export function countOf(c: ColdCampaign, statuses: readonly string[]): number {
  return statuses.length === 0 ? total(c) : statuses.reduce((n, s) => n + (c.counts[s] ?? 0), 0);
}

/** One campaign on the list page: what it is, how far it got, what needs a person. */
export function CampaignCard({ campaign: c }: { campaign: ColdCampaign }) {
  const dnd = countOf(c, ["skipped_dnd"]);
  const callable = total(c) - dnd;
  const done = callable - countOf(c, ["pending", "calling"]);
  const pct = callable > 0 ? Math.round((done / callable) * 100) : 0;
  const hot = countOf(c, ["interested", "callback", "moved"]);
  return (
    <Link
      href={`/marketing/cold-calling/${c.id}` as Route}
      className="group block rounded-lg border border-hairline bg-paper p-4 transition-colors hover:border-amber hover:bg-paper-2/40 focus:outline-none focus:ring-2 focus:ring-amber/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-ink truncate group-hover:text-amber">{c.name}</p>
          <p className="text-xs text-ink-3 truncate mt-0.5">{c.productName ?? "Any product"} · {c.agentName ?? c.agentId}</p>
        </div>
        <Badge kind={CAMPAIGN_STATUS[c.status].kind} dot={c.status === "running"} size="sm">{CAMPAIGN_STATUS[c.status].label}</Badge>
      </div>
      <div className="mt-3">
        <div className="flex justify-between text-xs text-ink-3 mb-1">
          <span><strong className="text-ink">{done}</strong> of {callable} called</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-paper-2 overflow-hidden" aria-hidden>
          <div className="h-full bg-emerald" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div><dt className="text-[11px] text-ink-3">Interested</dt><dd className={cn("font-serif text-lg", hot ? "text-emerald" : "text-ink")}>{hot}</dd></div>
        <div><dt className="text-[11px] text-ink-3">Left</dt><dd className="font-serif text-lg text-ink">{countOf(c, ["pending"])}</dd></div>
        <div><dt className="text-[11px] text-ink-3">Today</dt><dd className="font-serif text-lg text-ink">{c.calledToday}/{c.dailyLimit}</dd></div>
      </dl>
      <p className="mt-3 text-xs text-amber font-medium">Open campaign →</p>
    </Link>
  );
}

export function NewCampaignForm(props: {
  onDone: (id: string | null) => void;
  agents: { id: string; name: string }[];
  defaultAgentId: string;
  loadingAgents: boolean;
}) {
  const create = useCreateCampaign();
  const [name, setName] = React.useState("");
  const [agentId, setAgentId] = React.useState("");
  const [limit, setLimit] = React.useState("50");
  const products = useColdProducts();
  const [productId, setProductId] = React.useState("");

  React.useEffect(() => {
    if (!agentId && props.agents.length) {
      setAgentId(props.agents.find((a) => a.id === props.defaultAgentId)?.id ?? props.agents[0].id);
    }
  }, [props.agents, props.defaultAgentId, agentId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const dailyLimit = Number(limit);
    if (!name.trim()) { toast.error("Give the campaign a name.", { description: "For example: Delhi CA firms — October." }); return; }
    if (!agentId) { toast.error("Pick an agent.", { description: "Agents come from your Bolna account." }); return; }
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) {
      toast.error("Calls per day must be 1 to 1,000.", { description: "50 a day is a good start." }); return;
    }
    try {
      const r = await create.mutateAsync({ name: name.trim(), agentId, dailyLimit, productItemId: productId || null });
      toast.success("Campaign created", { description: "Next: add your list of numbers." });
      props.onDone(r.id);
    } catch (err) {
      failToast(err, "Could not create the campaign.");
    }
  };

  return (
    <Card className="p-5 md:p-6">
      <h2 className="font-serif text-xl">New campaign</h2>
      <p className="text-sm text-ink-3 mt-0.5">Four details — you can add numbers right after.</p>
      <form onSubmit={submit} className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="cc-name" className="block text-sm font-medium text-ink mb-1.5">Campaign name</label>
          <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Delhi CA firms — October" maxLength={120} autoFocus />
          <p className="text-xs text-ink-3 mt-1">Only for you — the customer never hears it.</p>
        </div>
        <div>
          <label htmlFor="cc-agent" className="block text-sm font-medium text-ink mb-1.5">Which AI agent calls</label>
          <select
            id="cc-agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={props.loadingAgents}
            className="w-full h-9 rounded-md border border-hairline bg-paper px-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
          >
            {props.loadingAgents && <option value="">Loading agents…</option>}
            {props.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <p className="text-xs text-ink-3 mt-1">Agents come from your Bolna account.</p>
        </div>
        <div>
          <label htmlFor="cc-product" className="block text-sm font-medium text-ink mb-1.5">Calling about which product</label>
          <select
            id="cc-product"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            disabled={products.isLoading}
            className="w-full h-9 rounded-md border border-hairline bg-paper px-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
          >
            <option value="">Any product — let the customer say what they need</option>
            {(products.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <p className="text-xs text-ink-3 mt-1">The agent talks about this product and quotes only its price.</p>
        </div>
        <div>
          <label htmlFor="cc-limit" className="block text-sm font-medium text-ink mb-1.5">Calls per day</label>
          <Input id="cc-limit" type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} />
          <p className="text-xs text-ink-3 mt-1">The agent stops for the day at this number.</p>
        </div>
        <div className="md:col-span-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => props.onDone(null)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Create campaign</Button>
        </div>
      </form>
    </Card>
  );
}

/** One numbered step: a circle that turns into a tick when done. */
function Step(props: { n: number; done: boolean; active: boolean; title: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border p-4 flex flex-col gap-3 min-w-0",
        props.active ? "border-amber bg-amber-soft/30" : "border-hairline bg-paper",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "grid place-items-center h-7 w-7 rounded-full text-sm font-semibold shrink-0",
            props.done ? "bg-emerald text-white" : props.active ? "bg-amber text-white" : "bg-paper-2 text-ink-3",
          )}
        >
          {props.done ? <Icon name="check" size={14} /> : props.n}
        </span>
        <h3 className="font-medium text-ink">
          <span className="sr-only">Step {props.n}{props.done ? " (done)" : ""}: </span>{props.title}
        </h3>
      </div>
      {props.children}
    </div>
  );
}

export function CampaignPanel({ campaign }: { campaign: ColdCampaign }) {
  const [filter, setFilter] = React.useState<FilterId>("all");
  const [view, setView] = React.useState<"numbers" | "log">("numbers");
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0];
  const contacts = useColdContacts(campaign.id, active.statuses.length ? active.statuses.join(",") : null);
  const update = useUpdateCampaign();
  const importList = useImportList();
  const tick = useTick();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [report, setReport] = React.useState<ImportResult | null>(null);

  /* While the page is open and the campaign runs, check every minute: results come in and the
     next calls go out. On the live server the cron does this too; on localhost this is the only
     thing that does. Quiet — no toast; the Live box shows what happened. */
  const [lastCheck, setLastCheck] = React.useState<{ at: Date; note: string | null; placed: number } | null>(null);
  const tickRef = React.useRef(tick.mutateAsync);
  tickRef.current = tick.mutateAsync;
  React.useEffect(() => {
    if (campaign.status !== "running") return;
    let stop = false;
    const go = async () => {
      try {
        const r = await tickRef.current(campaign.id);
        if (!stop) setLastCheck({ at: new Date(), note: r.note, placed: r.placed });
      } catch { /* the Live box keeps the last good check; Refresh results shows the error */ }
    };
    void go();
    const t = window.setInterval(go, 60_000);
    return () => { stop = true; window.clearInterval(t); };
  }, [campaign.id, campaign.status]);

  const numbers = total(campaign);
  const toMove = countOf(campaign, ["interested", "callback"]);
  const running = campaign.status === "running";
  const started = campaign.status !== "draft";

  const setStatus = async (status: "running" | "paused" | "done") => {
    try {
      await update.mutateAsync({ id: campaign.id, status });
      toast.success(status === "running" ? "Calling started" : status === "paused" ? "Calling paused" : "Campaign finished", {
        description: status === "running"
          ? `The agent calls Mon–Fri ${campaign.windowStart}:00–${campaign.windowEnd}:00, up to ${campaign.dailyLimit} a day. Results show up below.`
          : "No new calls will be placed. Press Start again any time.",
      });
    } catch (err) { failToast(err, "Could not change the campaign."); }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 2_000_000) { toast.error("File is larger than 2 MB.", { description: "Split the list into smaller files." }); return; }
    try {
      const r = await importList.mutateAsync({ id: campaign.id, csv: await file.text() });
      const skipped = r.alreadyOnList + r.alreadyCalledCount + r.alreadyInSalesCount + r.invalidCount + r.duplicatesInFile;
      if (skipped === 0) {
        toast.success(`${r.added} numbers added`, { description: r.dnd ? `${r.dnd} marked DND will not be called.` : "Next: press Start calling." });
      } else {
        setReport(r);
      }
    } catch (err) { failToast(err, "Could not import the file."); }
  };

  const runNow = async () => {
    try {
      const r = await tick.mutateAsync(campaign.id);
      setLastCheck({ at: new Date(), note: r.note, placed: r.placed });
      toast.success(`${r.placed} calls placed · ${r.finished} results updated`, { description: r.note ?? "Results appear here a minute or two after each call." });
    } catch (err) { failToast(err, "Could not check the calls."); }
  };

  return (
    <Card className="p-4 md:p-6 space-y-6 min-w-0">
      {/* Title + what this campaign is set to */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-serif text-2xl leading-tight truncate">{campaign.name}</h2>
            <Badge kind={CAMPAIGN_STATUS[campaign.status].kind} dot={running}>{CAMPAIGN_STATUS[campaign.status].label}</Badge>
          </div>
          <p className="text-sm text-ink-3 mt-1">
            Product <strong className="text-ink font-medium">{campaign.productName ?? "Any"}</strong>
            <span aria-hidden> · </span>Agent <strong className="text-ink font-medium">{campaign.agentName ?? campaign.agentId}</strong>
            <span aria-hidden> · </span>Mon–Fri {campaign.windowStart}:00–{campaign.windowEnd}:00 IST
            <span aria-hidden> · </span>{campaign.calledToday} of {campaign.dailyLimit} calls today
          </p>
        </div>
        {started && (
          <Button size="sm" variant="ghost" icon="refresh" onClick={runNow} loading={tick.isPending}
            title="Fetch finished calls from the agent now and place the next ones">
            Refresh results
          </Button>
        )}
      </div>

      {started && <LiveStatus campaign={campaign} lastCheck={lastCheck} />}

      {/* The three steps */}
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} aria-label="Choose a CSV file to import" tabIndex={-1} />
      <ImportReportDialog report={report} campaignId={campaign.id} onClose={() => setReport(null)} />
      <div className="grid gap-3 md:grid-cols-3">
        <Step n={1} title="Add numbers" done={numbers > 0} active={numbers === 0}>
          <p className="text-sm text-ink-3">
            {numbers > 0
              ? <><strong className="text-ink">{numbers}</strong> numbers on the list. You can add more any time.</>
              : <>Upload your Excel list saved as <strong>CSV</strong>. Only the <strong>Phone</strong> column is required.</>}
          </p>
          <div className="flex gap-2 flex-wrap mt-auto">
            <Button size="sm" variant={numbers === 0 ? "primary" : "default"} icon="upload"
              onClick={() => fileRef.current?.click()} loading={importList.isPending}>
              {numbers === 0 ? "Upload list" : "Add more"}
            </Button>
            <Button size="sm" variant="ghost" icon="download" onClick={downloadSample}>Sample file</Button>
          </div>
        </Step>

        <Step n={2} title="Start calling" done={started && !running && campaign.status === "done"} active={numbers > 0 && !running && campaign.status !== "done"}>
          <p className="text-sm text-ink-3">
            {running
              ? <>On. See <strong className="text-ink">Live status</strong> above for who is being called now.</>
              : campaign.status === "done"
                ? <>Every number on the list has been called.</>
                : campaign.status === "paused"
                  ? <>Paused. No calls go out until you press Start.</>
                  : <>The agent calls one by one, only Mon–Fri {campaign.windowStart}:00–{campaign.windowEnd}:00, up to {campaign.dailyLimit} a day.</>}
          </p>
          <div className="flex gap-2 flex-wrap mt-auto">
            {running ? (
              <Button size="sm" icon="square" onClick={() => setStatus("paused")} loading={update.isPending}>Pause</Button>
            ) : campaign.status !== "done" ? (
              numbers === 0 ? (
                <p className="text-xs text-ink-3">Add numbers first (step 1).</p>
              ) : (
                <Button size="sm" variant="primary" icon="play" onClick={() => setStatus("running")} loading={update.isPending}>
                  {campaign.status === "paused" ? "Start again" : "Start calling"}
                </Button>
              )
            ) : null}
          </div>
        </Step>

        <Step n={3} title="Send interested ones to Sales" done={started && countOf(campaign, ["moved"]) > 0 && toMove === 0} active={toMove > 0}>
          <p className="text-sm text-ink-3">
            {toMove > 0
              ? <><strong className="text-emerald">{toMove}</strong> {toMove === 1 ? "person wants" : "people want"} to talk. Open them and press <strong>Move to Sales &amp; Pipeline</strong>.</>
              : <>When someone is interested, they show up here. Nothing goes to the pipeline without your click.</>}
          </p>
          <div className="flex gap-2 flex-wrap mt-auto">
            <Button size="sm" variant={toMove > 0 ? "primary" : "default"} icon="users"
              onClick={() => setFilter("interested")} disabled={toMove === 0 && countOf(campaign, ["interested"]) === 0}
              title={toMove === 0 ? "Nobody interested yet" : undefined}>
              Show interested
            </Button>
          </div>
        </Step>
      </div>

      {/* Two views: the numbers with their result, or every call in time order */}
      <div role="tablist" aria-label="Campaign detail" className="flex gap-1 border-b border-hairline">
        {([["numbers", "Numbers & results"], ["log", "Call log"]] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={view === id}
            onClick={() => setView(id)}
            className={cn(
              "px-4 py-2 text-sm -mb-px border-b-2 transition-colors focus:outline-none focus:ring-2 focus:ring-amber/40 rounded-t",
              view === id ? "border-amber text-ink font-medium" : "border-transparent text-ink-3 hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "log" ? <CallLog campaignId={campaign.id} /> : (
      <section aria-label="Results" className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium text-ink">Results</h3>
          <span className="text-xs text-ink-3">Click a box to filter the list</span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-5 xl:grid-cols-9 gap-2">
          {FILTERS.map((f) => {
            const n = countOf(campaign, f.statuses);
            const on = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                aria-pressed={on}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-amber/40",
                  on ? "border-amber bg-amber-soft/40" : "border-hairline bg-paper hover:bg-paper-2",
                )}
              >
                <span className={cn("block font-serif text-xl leading-none",
                  n > 0 && f.tone === "emerald" ? "text-emerald" : n > 0 && f.tone === "amber" ? "text-amber" : "text-ink")}>
                  {n}
                </span>
                <span className="block text-xs text-ink-3 mt-1 truncate">{f.label}</span>
              </button>
            );
          })}
        </div>

        {contacts.isLoading ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : (contacts.data ?? []).length === 0 ? (
          <EmptyState
            icon="phone"
            title={filter === "all" ? "No numbers on this list yet" : `Nobody in “${active.label}” yet`}
            body={filter === "all" ? "Upload a CSV with a Phone column — use the sample file if unsure." : "Results appear a minute or two after each call."}
            action={filter === "all"
              ? <Button variant="primary" icon="upload" onClick={() => fileRef.current?.click()}>Upload list</Button>
              : <Button onClick={() => setFilter("all")}>Show all numbers</Button>}
          />
        ) : (
          <div className="rounded-lg border border-hairline overflow-hidden">
            <div className="hidden md:grid grid-cols-[minmax(0,2fr)_150px_140px_minmax(0,1.2fr)] gap-3 px-4 py-2 bg-paper-2 text-xs font-medium text-ink-3">
              <span>Person</span><span>Result</span><span>Last call</span><span className="text-right">Next step</span>
            </div>
            <ul className="divide-y divide-hairline" aria-label="Numbers on this list">
              {(contacts.data ?? []).map((c) => <ContactItem key={c.id} contact={c} />)}
            </ul>
          </div>
        )}
      </section>
      )}
    </Card>
  );
}

function istDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}
function istTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}
function duration(sec: number | null): string {
  if (!sec) return "—";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

const SPOKE = new Set(["interested", "callback", "answered", "not_interested", "moved"]);

/**
 * Every call this campaign placed, newest first, grouped by day with that day's totals — the
 * "what happened, when" view (Abhishek, 19 Oct: tracking inside the campaign).
 */
export function CallLog({ campaignId }: { campaignId: string }) {
  const all = useColdContacts(campaignId, null);
  const calls = (all.data ?? [])
    .filter((c): c is ColdContact & { lastCalledAt: string } => !!c.lastCalledAt)
    .sort((a, b) => b.lastCalledAt.localeCompare(a.lastCalledAt));

  if (all.isLoading) return <Skeleton className="h-40 rounded-lg" />;
  if (calls.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title="No calls yet"
        body="Once the agent starts calling, every call shows up here with its time, length and result."
      />
    );
  }

  const days = new Map<string, typeof calls>();
  for (const c of calls) {
    const d = istDay(c.lastCalledAt);
    days.set(d, [...(days.get(d) ?? []), c]);
  }

  return (
    <div className="space-y-5">
      {[...days.entries()].map(([day, rows]) => {
        const spoke = rows.filter((r) => SPOKE.has(r.status)).length;
        const interested = rows.filter((r) => ["interested", "callback", "moved"].includes(r.status)).length;
        const noAnswer = rows.filter((r) => ["no_answer", "failed", "pending"].includes(r.status)).length;
        return (
          <section key={day} aria-label={`Calls on ${day}`} className="space-y-2">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h3 className="font-medium text-ink">{day}</h3>
              <p className="text-xs text-ink-3">
                {rows.length} {rows.length === 1 ? "call" : "calls"} · {spoke} talked · <span className="text-emerald">{interested} interested</span> · {noAnswer} not reached
              </p>
            </div>
            <ul className="rounded-lg border border-hairline divide-y divide-hairline">
              {rows.map((c) => {
                const st = STATUS[c.status] ?? { label: c.status, kind: "muted" as BadgeKind };
                return (
                  <li key={c.id} className="px-4 py-2.5 grid gap-1 sm:grid-cols-[70px_minmax(0,1fr)_70px_140px] sm:items-center sm:gap-3">
                    <span className="text-sm font-mono text-ink-2">{istTime(c.lastCalledAt)}</span>
                    <div className="min-w-0">
                      <p className="text-sm text-ink truncate">
                        <span className="font-medium">{c.name || c.company || c.phone}</span>
                        {c.company && c.name && <span className="text-ink-3"> · {c.company}</span>}
                      </p>
                      {c.summary
                        ? <p className="text-xs text-ink-3 truncate">“{c.summary}”</p>
                        : c.error ? <p className="text-xs text-rose-ink truncate">{c.error}</p>
                        : <p className="text-xs text-ink-3 font-mono">{c.phone}</p>}
                    </div>
                    <span className="text-xs text-ink-3" title="Call length">{duration(c.durationSec)}</span>
                    <span className="flex items-center gap-1.5 sm:justify-end flex-wrap">
                      <Badge kind={st.kind} size="sm">{st.label}</Badge>
                      {c.attempts > 1 && <span className="text-xs text-ink-3">{c.attempts} tries</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * "Is it calling right now, and if not, why?" — the first question after pressing Start
 * (Abhishek, 19 Oct). Progress, who is on the line, and the plain reason when nothing is ringing.
 */
export function LiveStatus({ campaign, lastCheck }: {
  campaign: ColdCampaign;
  lastCheck: { at: Date; note: string | null; placed: number } | null;
}) {
  const ringing = useColdContacts(campaign.status === "running" ? campaign.id : null, "calling");
  const dnd = countOf(campaign, ["skipped_dnd"]);
  const pending = countOf(campaign, ["pending"]);
  const calling = countOf(campaign, ["calling"]);
  const failed = countOf(campaign, ["failed"]);
  const callable = total(campaign) - dnd;
  const done = callable - pending - calling;
  const pct = callable > 0 ? Math.round((done / callable) * 100) : 0;
  const now = new Date();

  let tone: "live" | "wait" | "stop" = "wait";
  let headline: string;
  let detail: string | null = null;
  if (calling > 0 && campaign.status !== "running") {
    tone = "live"; headline = `Reading ${calling} call ${calling === 1 ? "result" : "results"}…`; detail = "Press Refresh results if it does not update in a minute.";
  } else if (campaign.status === "paused") {
    tone = "stop"; headline = "Paused — no calls are going out."; detail = "Press Start again to continue.";
  } else if (campaign.status === "done" || (pending === 0 && calling === 0)) {
    tone = "stop"; headline = "Finished — every number has been called."; detail = "Add more numbers to call again.";
  } else if (calling > 0) {
    tone = "live";
    const who = (ringing.data ?? []).map((c) => c.name || c.company || c.phone);
    headline = `Calling now: ${who.length ? who.slice(0, 3).join(", ") + (who.length > 3 ? ` +${who.length - 3}` : "") : `${calling} ${calling === 1 ? "number" : "numbers"}`}`;
    detail = "The result shows up here a minute or two after the call ends.";
  } else if (!canCallNow(now, campaign.windowStart, campaign.windowEnd)) {
    headline = "Waiting for calling hours.";
    detail = `Calls go out only Mon–Fri ${campaign.windowStart}:00–${campaign.windowEnd}:00 IST. It starts again by itself.`;
  } else if (campaign.calledToday >= campaign.dailyLimit) {
    headline = `Today's limit of ${campaign.dailyLimit} calls is reached.`;
    detail = "It continues tomorrow by itself.";
  } else {
    tone = "live"; headline = "Next call within a minute.";
    detail = lastCheck?.note && lastCheck.placed === 0 ? `Last check: ${lastCheck.note}.` : null;
  }

  return (
    <section aria-label="Live status" aria-live="polite" className="rounded-lg border border-hairline bg-paper-2/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-2.5 min-w-0">
          <span aria-hidden className="relative mt-1.5 flex h-2.5 w-2.5 shrink-0">
            {tone === "live" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald opacity-60" />}
            <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full",
              tone === "live" ? "bg-emerald" : tone === "wait" ? "bg-amber" : "bg-ink-3")} />
          </span>
          <div className="min-w-0">
            <p className="font-medium text-ink">{headline}</p>
            {detail && <p className="text-sm text-ink-3">{detail}</p>}
          </div>
        </div>
        <p className="text-xs text-ink-3">
          {campaign.status === "running"
            ? lastCheck ? `Checked ${lastCheck.at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · checks every minute` : "Checking…"
            : null}
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between text-xs text-ink-3 mb-1">
          <span><strong className="text-ink">{done}</strong> of {callable} called</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-paper border border-hairline overflow-hidden" role="progressbar"
          aria-valuemin={0} aria-valuemax={callable} aria-valuenow={done} aria-label="Numbers called">
          <div className="h-full bg-emerald transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
        {[
          { k: "Called", v: done },
          { k: "Left to call", v: pending },
          { k: "Calling now", v: calling },
          { k: "Skipped (DND)", v: dnd },
          { k: "Call failed", v: failed },
        ].map((x) => (
          <div key={x.k} className="rounded-md bg-paper border border-hairline px-3 py-2">
            <dt className="text-xs text-ink-3">{x.k}</dt>
            <dd className="font-serif text-lg leading-tight text-ink">{x.v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-ink-3">Today: {campaign.calledToday} of {campaign.dailyLimit} calls used.</p>
    </section>
  );
}

/** After an import: what was added and, number by number, what was left out and why. */
/** A CSV cell, quoted when it holds a comma or a quote. */
function cell(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function ImportReportDialog({ report: r, campaignId, onClose }: {
  report: ImportResult | null; campaignId: string; onClose: () => void;
}) {
  const importList = useImportList();
  const [added, setAdded] = React.useState<Set<string>>(new Set());
  React.useEffect(() => { setAdded(new Set()); }, [r]);

  /* "Add anyway": the person saw why a number was left out and still wants it called. */
  const addAnyway = async (rows: SkippedNumber[]) => {
    const todo = rows.filter((x) => !added.has(x.phone));
    if (todo.length === 0) return;
    const csv = "Phone,Name,Company,City\n" + todo.map((x) => [x.phone, x.name, x.company, x.city].map(cell).join(",")).join("\n");
    try {
      const res = await importList.mutateAsync({ id: campaignId, csv, force: todo.map((x) => x.phone) });
      setAdded((prev) => new Set([...prev, ...todo.map((x) => x.phone)]));
      toast.success(`${res.added} ${res.added === 1 ? "number" : "numbers"} added anyway`, { description: "They will be called with the rest of the list." });
    } catch (err) { failToast(err, "Could not add them."); }
  };

  const groups: { title: string; hint: string; rows: SkippedNumber[]; total: number }[] = r ? [
    { title: "Already called in another campaign", hint: "One person is cold-called only once.", rows: r.alreadyCalled, total: r.alreadyCalledCount },
    { title: "Already in Sales (lead or customer)", hint: "Your team already has them — no cold call.", rows: r.alreadyInSales, total: r.alreadyInSalesCount },
  ] : [];
  return (
    <Dialog open={!!r} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{r?.added ?? 0} new {r?.added === 1 ? "number" : "numbers"} added</DialogTitle>
          <DialogDescription>Some numbers in the file were left out so nobody is called twice.</DialogDescription>
        </DialogHeader>
        {r && (
          <div className="space-y-4 max-h-[60vh] overflow-auto text-sm">
            <ul className="space-y-1 text-ink-2">
              {r.alreadyOnList > 0 && <li>• {r.alreadyOnList} already on this list</li>}
              {r.duplicatesInFile > 0 && <li>• {r.duplicatesInFile} repeated in the file</li>}
              {r.invalidCount > 0 && <li>• {r.invalidCount} unreadable numbers (lines {r.invalidLines.slice(0, 8).join(", ")}{r.invalidCount > 8 ? "…" : ""})</li>}
              {r.dnd > 0 && <li>• {r.dnd} marked DND — on the list, never called</li>}
            </ul>
            {groups.filter((g) => g.total > 0).map((g) => (
              <section key={g.title} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-medium text-ink">{g.title} · {g.total}</h3>
                  {g.rows.length > 1 && g.rows.some((x) => !added.has(x.phone)) && (
                    <Button size="sm" variant="ghost" onClick={() => addAnyway(g.rows)} loading={importList.isPending}>Add all anyway</Button>
                  )}
                </div>
                <p className="text-xs text-ink-3">{g.hint}</p>
                <ul className="rounded-md border border-hairline divide-y divide-hairline">
                  {g.rows.map((x) => (
                    <li key={x.phone} className="px-3 py-2 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate"><span className="font-medium">{x.name || x.phone}</span>{x.name && <span className="text-ink-3 font-mono text-xs"> · {x.phone}</span>}</p>
                        <p className="text-xs text-ink-3 truncate">{x.reason}</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {x.leadId && (
                          <Link href={`/leads?lead=${encodeURIComponent(x.leadId)}` as Route} className="text-xs text-amber hover:underline">Open lead</Link>
                        )}
                        {added.has(x.phone)
                          ? <Badge kind="success" size="sm">Added</Badge>
                          : <Button size="sm" onClick={() => addAnyway([x])} loading={importList.isPending}>Add anyway</Button>}
                      </div>
                    </li>
                  ))}
                </ul>
                {g.total > g.rows.length && <p className="text-xs text-ink-3">…and {g.total - g.rows.length} more.</p>}
              </section>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ContactItem({ contact: c }: { contact: ColdContact }) {
  const [open, setOpen] = React.useState(false);
  const move = useMoveToPipeline();
  const del = useDeleteContact();
  const [confirming, setConfirming] = React.useState(false);
  const s = STATUS[c.status] ?? { label: c.status, kind: "muted" as BadgeKind };
  const title = c.name || c.company || c.phone;
  const hasDetail = !!(c.summary || c.transcript || c.error || (c.nextAttemptAt && c.status === "pending"));

  const doMove = async () => {
    try {
      const r = await move.mutateAsync(c.id);
      const due = new Date(r.followUpAt).toLocaleString("en-IN", {
        weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata",
      });
      toast.success(r.joined ? "Added to the existing lead" : "Moved to Sales & Pipeline", {
        description: r.joined
          ? `${title} was already a lead — the call notes are added there. Follow-up call task: ${due}.`
          : `${title} is now a lead. A follow-up call task is on your Tasks for ${due}.`,
        action: { label: "Open lead", onClick: () => { window.location.href = `/leads?lead=${encodeURIComponent(r.leadId)}`; } },
      });
    } catch (err) { failToast(err, "Could not move it to the pipeline."); }
  };

  const doDelete = async () => {
    try {
      await del.mutateAsync(c.id);
      toast.success("Number removed from this list", {
        description: c.leadId ? "The lead it became stays in Sales & Pipeline." : "It will not be called.",
      });
    } catch (err) { failToast(err, "Could not remove the number."); setConfirming(false); }
  };

  return (
    <li className="px-4 py-3">
      <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_150px_140px_minmax(0,1.2fr)] md:gap-3 md:items-center">
        <div className="min-w-0">
          <p className="text-ink truncate">
            <span className="font-medium">{title}</span>
            {c.company && c.name && <span className="text-ink-3"> · {c.company}</span>}
          </p>
          <p className="text-xs text-ink-3 font-mono truncate">{c.phone}{c.city ? ` · ${c.city}` : ""}</p>
          {!open && (c.reasons[0]
            ? <p className="text-xs text-ink-2 mt-1 line-clamp-1"><span className="text-ink-3">Why: </span>{c.reasons[0]}</p>
            : c.summary && <p className="text-xs text-ink-2 mt-1 line-clamp-1">“{c.summary}”</p>)}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge kind={s.kind} size="sm">{s.label}</Badge>
          {c.seatsHeard ? <Badge kind="info" size="sm">{c.seatsHeard} users</Badge> : null}
        </div>
        <span className="text-xs text-ink-3">
          {c.lastCalledAt ? formatDate(c.lastCalledAt) : "Not called yet"}{c.attempts > 1 ? ` · ${c.attempts} tries` : ""}
        </span>
        <div className="flex items-center gap-2 md:justify-end flex-wrap">
          {hasDetail && (
            <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "Hide call" : "See call"}
            </Button>
          )}
          {MOVABLE.has(c.status) && (
            <Button size="sm" variant="primary" icon="send" onClick={doMove} loading={move.isPending}>Move to Sales</Button>
          )}
          {c.status === "moved" && c.leadId && (
            <Link href={`/leads?lead=${encodeURIComponent(c.leadId)}` as Route}
              className="inline-flex items-center gap-1 text-sm text-amber hover:underline">
              Open lead <Icon name="external" size={12} />
            </Link>
          )}
          {c.status !== "calling" && (confirming ? (
            <span className="inline-flex items-center gap-1">
              <Button size="sm" variant="danger" onClick={doDelete} loading={del.isPending}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            </span>
          ) : (
            <Button size="icon" variant="ghost" icon="trash" onClick={() => setConfirming(true)}
              aria-label={`Remove ${title} from this list`} title="Remove from this list" />
          ))}
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-2 text-sm rounded-md bg-paper-2 p-3">
          {c.reasons.length > 0 && (
            <div>
              <p className="text-ink-3">Why the agent rated it this way:</p>
              <ul className="list-disc pl-5 mt-1 space-y-0.5">
                {c.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
            </div>
          )}
          {c.summary && <p><span className="text-ink-3">Call summary:</span> {c.summary}</p>}
          {c.error && <p className="text-rose-ink">Call failed: {c.error}</p>}
          {c.nextAttemptAt && c.status === "pending" && (
            <p className="text-ink-3">No answer last time — the agent tries again after {formatDate(c.nextAttemptAt)}.</p>
          )}
          {c.transcript && (
            <details>
              <summary className="cursor-pointer text-xs text-ink-3">Full conversation</summary>
              <pre className="mt-2 whitespace-pre-wrap text-xs text-ink max-h-72 overflow-auto">{c.transcript}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}
