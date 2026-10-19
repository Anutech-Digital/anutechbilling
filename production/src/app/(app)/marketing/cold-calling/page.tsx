/**
 * Cold Calling — /marketing/cold-calling (R-1663)
 *
 * A calling list from a spreadsheet, rung by the AI voice agent (Bolna) on a schedule. What each
 * call came to lands on its row; a person moves the interested ones into Sales & Pipeline with a
 * button — nothing enters the pipeline on its own (Abhishek, 19 Oct 2026). DND numbers are kept
 * on the list, marked, and never called.
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
import { Skeleton } from "@/components/ui/skeleton";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { cn, formatDate } from "@/lib/utils";
import {
  ColdCallError, useBolnaAgents, useColdCampaigns, useColdContacts, useCreateCampaign, useImportList,
  useMoveToPipeline, useTick, useUpdateCampaign, type ColdCampaign, type ColdContact,
} from "@/lib/queries/cold-calling";

type BadgeKind = "muted" | "success" | "warning" | "danger" | "info" | "outline";

const STATUS: Record<string, { label: string; kind: BadgeKind }> = {
  pending:        { label: "Waiting",         kind: "muted" },
  calling:        { label: "Calling…",        kind: "info" },
  interested:     { label: "Interested",      kind: "success" },
  callback:       { label: "Call back",       kind: "warning" },
  answered:       { label: "Answered",        kind: "outline" },
  not_interested: { label: "Not interested",  kind: "muted" },
  no_answer:      { label: "No answer",       kind: "muted" },
  failed:         { label: "Failed",          kind: "danger" },
  skipped_dnd:    { label: "DND — not called", kind: "muted" },
  moved:          { label: "In pipeline",     kind: "success" },
};

const CAMPAIGN_STATUS: Record<ColdCampaign["status"], { label: string; kind: BadgeKind }> = {
  draft:   { label: "Not started", kind: "muted" },
  running: { label: "Running",     kind: "success" },
  paused:  { label: "Paused",      kind: "warning" },
  done:    { label: "Finished",    kind: "outline" },
};

/** Statuses a person may move into the pipeline — anyone who actually spoke to the agent. */
const MOVABLE = new Set(["interested", "callback", "answered"]);

function failToast(err: unknown, fallback: string) {
  if (err instanceof ColdCallError) {
    toast.error(err.message, { description: err.detail ?? "Try again in a moment." });
  } else {
    toast.error(fallback, { description: "Check your internet connection and try again." });
  }
}

export default function ColdCallingPage() {
  const agents = useBolnaAgents();
  const campaigns = useColdCampaigns();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const list = campaigns.data ?? [];
  const selected = list.find((c) => c.id === selectedId) ?? list[0] ?? null;
  const notConnected = agents.error instanceof ColdCallError && agents.error.status === 409 ? agents.error : null;

  return (
    <div className="mx-auto max-w-[1400px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing Hub</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Cold Calling</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            Import a list of numbers, pick an AI agent and start — the agent calls Monday to Friday within the hours below
            and the daily limit. Interested people stay here until you press <strong>Move to Sales &amp; Pipeline</strong>.
            Numbers marked DND in your file are never called.
          </p>
        </div>
        {!notConnected && <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New campaign</Button>}
      </header>

      {notConnected && (
        <Card className="p-6">
          <EmptyState icon="phone" title={notConnected.message} body={notConnected.detail ?? undefined} />
        </Card>
      )}

      {creating && !notConnected && (
        <NewCampaignForm
          onDone={(id) => { setCreating(false); if (id) setSelectedId(id); }}
          agents={agents.data?.agents ?? []}
          defaultAgentId={agents.data?.defaultAgentId ?? ""}
          loadingAgents={agents.isLoading}
        />
      )}

      {campaigns.isLoading ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : list.length === 0 && !creating && !notConnected ? (
        <Card className="p-6">
          <EmptyState
            icon="phone"
            title="No calling campaigns yet"
            body="Start one, import your Excel list (saved as CSV) and the AI agent calls it for you."
            action={<Button variant="primary" onClick={() => setCreating(true)}>New campaign</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          <ul className="space-y-2" aria-label="Campaigns">
            {list.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  aria-pressed={selected?.id === c.id}
                  className={cn(
                    "w-full text-left rounded-lg border p-3 transition-colors focus:outline-none focus:ring-2 focus:ring-amber/40",
                    selected?.id === c.id ? "border-amber bg-amber-soft/40" : "border-hairline bg-paper hover:bg-paper-2",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-ink truncate">{c.name}</span>
                    <Badge kind={CAMPAIGN_STATUS[c.status].kind} size="sm">{CAMPAIGN_STATUS[c.status].label}</Badge>
                  </div>
                  <p className="text-xs text-ink-3 mt-1 truncate">Agent: {c.agentName ?? c.agentId}</p>
                  <p className="text-xs text-ink-3 mt-0.5">
                    {total(c)} numbers · <span className="text-emerald">{c.counts.interested ?? 0} interested</span> · today {c.calledToday}/{c.dailyLimit}
                  </p>
                </button>
              </li>
            ))}
          </ul>
          {selected && <CampaignPanel campaign={selected} />}
        </div>
      )}
    </div>
  );
}

function total(c: ColdCampaign): number {
  return Object.values(c.counts).reduce((a, b) => a + b, 0);
}

function NewCampaignForm(props: {
  onDone: (id: string | null) => void;
  agents: { id: string; name: string }[];
  defaultAgentId: string;
  loadingAgents: boolean;
}) {
  const create = useCreateCampaign();
  const [name, setName] = React.useState("");
  const [agentId, setAgentId] = React.useState("");
  const [limit, setLimit] = React.useState("50");

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
      toast.error("Daily limit must be 1 to 1,000.", { description: "50 a day is a good start." }); return;
    }
    try {
      const r = await create.mutateAsync({ name: name.trim(), agentId, dailyLimit });
      toast.success("Campaign created", { description: "Now import your list of numbers." });
      props.onDone(r.id);
    } catch (err) {
      failToast(err, "Could not create the campaign.");
    }
  };

  return (
    <Card className="p-5">
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-[1fr_1fr_160px_auto] md:items-end">
        <div>
          <label htmlFor="cc-name" className="block text-xs font-medium text-ink-3 mb-1.5">Campaign name</label>
          <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Delhi CA firms — October" maxLength={120} />
        </div>
        <div>
          <label htmlFor="cc-agent" className="block text-xs font-medium text-ink-3 mb-1.5">AI agent</label>
          <select
            id="cc-agent"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={props.loadingAgents}
            className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
          >
            {props.loadingAgents && <option value="">Loading agents…</option>}
            {props.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="cc-limit" className="block text-xs font-medium text-ink-3 mb-1.5">Calls per day</label>
          <Input id="cc-limit" type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={() => props.onDone(null)}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>Create</Button>
        </div>
      </form>
    </Card>
  );
}

const TABS = ["all", "interested", "callback", "answered", "pending", "calling", "no_answer", "not_interested", "skipped_dnd", "moved", "failed"] as const;

function CampaignPanel({ campaign }: { campaign: ColdCampaign }) {
  const [tab, setTab] = React.useState<(typeof TABS)[number]>("all");
  const contacts = useColdContacts(campaign.id, tab === "all" ? null : tab);
  const update = useUpdateCampaign();
  const importList = useImportList();
  const tick = useTick();
  const fileRef = React.useRef<HTMLInputElement>(null);

  const setStatus = async (status: "running" | "paused" | "done") => {
    try {
      await update.mutateAsync({ id: campaign.id, status });
      toast.success(status === "running" ? "Campaign started" : status === "paused" ? "Campaign paused" : "Campaign finished", {
        description: status === "running"
          ? `Calls go out Mon–Fri ${campaign.windowStart}:00–${campaign.windowEnd}:00, up to ${campaign.dailyLimit} a day.`
          : "No new calls will be placed.",
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
      const parts = [
        r.alreadyOnList ? `${r.alreadyOnList} already on the list` : null,
        r.dnd ? `${r.dnd} DND (will not be called)` : null,
        r.invalidCount ? `${r.invalidCount} unreadable (lines ${r.invalidLines.slice(0, 5).join(", ")}${r.invalidCount > 5 ? "…" : ""})` : null,
        r.duplicatesInFile ? `${r.duplicatesInFile} repeated in the file` : null,
      ].filter(Boolean);
      toast.success(`${r.added} numbers added`, { description: parts.join(" · ") || "Start the campaign when you are ready." });
    } catch (err) { failToast(err, "Could not import the file."); }
  };

  const runNow = async () => {
    try {
      const r = await tick.mutateAsync(campaign.id);
      toast.success(`${r.placed} calls placed · ${r.finished} results updated`, { description: r.note ?? "Results appear here a minute or two after each call." });
    } catch (err) { failToast(err, "Could not check the calls."); }
  };

  const count = (s: string) => campaign.counts[s] ?? 0;

  return (
    <Card className="p-4 md:p-5 space-y-4 min-w-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="font-serif text-2xl leading-tight truncate">{campaign.name}</h2>
          <p className="text-xs text-ink-3 mt-1">
            Agent <strong className="text-ink">{campaign.agentName ?? campaign.agentId}</strong> · Mon–Fri {campaign.windowStart}:00–{campaign.windowEnd}:00 IST ·
            {" "}{campaign.calledToday} of {campaign.dailyLimit} calls today
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} aria-label="Choose a CSV file to import" />
          <Button icon="upload" onClick={() => fileRef.current?.click()} loading={importList.isPending}>Import CSV</Button>
          <Button icon="refresh" onClick={runNow} loading={tick.isPending} title="Read finished calls from the agent and place the next calls now">Check &amp; call now</Button>
          {campaign.status === "running"
            ? <Button onClick={() => setStatus("paused")} loading={update.isPending}>Pause</Button>
            : campaign.status !== "done"
              ? <Button variant="primary" onClick={() => setStatus("running")} loading={update.isPending} disabled={total(campaign) === 0}
                  title={total(campaign) === 0 ? "Import a list first" : undefined}>Start calling</Button>
              : null}
        </div>
      </div>
      <p className="text-xs text-ink-3">
        CSV columns: <strong>Phone</strong> (required), Name, Company, City, DND (Yes = do not call). In Excel: File → Save As → CSV.
      </p>

      <TabBar
        value={tab}
        onChange={(v) => setTab(v as (typeof TABS)[number])}
        items={TABS.map((t) => ({
          id: t,
          label: t === "all" ? "All" : STATUS[t].label,
          count: t === "all" ? total(campaign) || undefined : count(t) || undefined,
          dot: t === "interested" && count(t) ? "emerald" : undefined,
        }))}
      />

      {contacts.isLoading ? (
        <Skeleton className="h-40 rounded-lg" />
      ) : (contacts.data ?? []).length === 0 ? (
        <EmptyState
          icon="phone"
          title={tab === "all" ? "No numbers on this list yet" : "Nobody here yet"}
          body={tab === "all" ? "Import a CSV with a Phone column." : "Results appear here a minute or two after each call."}
          action={tab === "all" ? <Button variant="primary" icon="upload" onClick={() => fileRef.current?.click()}>Import CSV</Button> : undefined}
        />
      ) : (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline" aria-label="Numbers on this list">
          {(contacts.data ?? []).map((c) => <ContactItem key={c.id} contact={c} />)}
        </ul>
      )}
    </Card>
  );
}

function ContactItem({ contact: c }: { contact: ColdContact }) {
  const [open, setOpen] = React.useState(false);
  const move = useMoveToPipeline();
  const s = STATUS[c.status] ?? { label: c.status, kind: "muted" as BadgeKind };
  const title = c.name || c.company || c.phone;

  const doMove = async () => {
    try {
      const r = await move.mutateAsync(c.id);
      toast.success("Moved to Sales & Pipeline", {
        description: `${title} is now a lead (${r.leadId}) with the call's summary.`,
        action: { label: "Open lead", onClick: () => { window.location.href = `/leads?lead=${encodeURIComponent(r.leadId)}`; } },
      });
    } catch (err) { failToast(err, "Could not move it to the pipeline."); }
  };

  return (
    <li className="p-3">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex-1 min-w-[200px] text-left focus:outline-none focus:ring-2 focus:ring-amber/40 rounded"
        >
          <span className="font-medium text-ink">{title}</span>
          {c.company && c.name && <span className="text-ink-3"> · {c.company}</span>}
          <span className="block text-xs text-ink-3 font-mono">{c.phone}{c.city ? ` · ${c.city}` : ""}</span>
        </button>
        <Badge kind={s.kind} size="sm">{s.label}</Badge>
        {c.seatsHeard ? <Badge kind="info" size="sm">{c.seatsHeard} users</Badge> : null}
        <span className="text-xs text-ink-3 w-28 text-right">
          {c.lastCalledAt ? formatDate(c.lastCalledAt) : "Not called"}{c.attempts > 1 ? ` · ${c.attempts}×` : ""}
        </span>
        {MOVABLE.has(c.status) && (
          <Button size="sm" variant="primary" onClick={doMove} loading={move.isPending}>Move to Sales &amp; Pipeline</Button>
        )}
        {c.status === "moved" && c.leadId && (
          <Link href={`/leads?lead=${encodeURIComponent(c.leadId)}` as Route} className="text-xs text-amber underline">Open lead</Link>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-2 text-sm">
          {c.summary && <p><span className="text-ink-3">Summary:</span> {c.summary}</p>}
          {c.error && <p className="text-rose-ink">Call failed: {c.error}</p>}
          {c.nextAttemptAt && c.status === "pending" && (
            <p className="text-ink-3">No answer last time — tries again after {formatDate(c.nextAttemptAt)}.</p>
          )}
          {c.transcript ? (
            <pre className="whitespace-pre-wrap rounded-md bg-paper-2 p-3 text-xs text-ink max-h-72 overflow-auto">{c.transcript}</pre>
          ) : (
            !c.summary && !c.error && <p className="text-ink-3">No conversation yet.</p>
          )}
        </div>
      )}
    </li>
  );
}
