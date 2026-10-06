/**
 * WhatsApp broadcast — /marketing/whatsapp
 *
 * Phase 2 (Pardeep, 26 Sep 2026). Four parts:
 *   Broadcast — pick an approved template and an audience, see the count and the message
 *               as a lead will read it, then send (server route, capped per run).
 *   Templates — the company's templates as submitted to Meta; starter wording to copy;
 *               "Sync from Meta" pulls approval status.
 *   Opt-outs  — numbers that replied STOP (the webhook records them) or were added by hand.
 *   History   — each broadcast and its counts.
 * The inbox for one-to-one chat stays at /whatsapp.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/providers/confirm-provider";
import { COPY } from "@/lib/copy";
import { toast } from "sonner";
import { cn, formatDate } from "@/lib/utils";
import {
  STARTER_WA_TEMPLATES, PARAM_FIELDS, isValidTemplateName, paramCount, templateProblem,
  renderBody, slotValues, normalizeWaPhone, type ParamField,
} from "@/lib/marketing/whatsapp-broadcast";
import {
  useWaTemplates, useSaveWaTemplate, useDeleteWaTemplate, useSyncWaTemplates,
  useWaOptOuts, useAddWaOptOut, useRemoveWaOptOut, useWaBroadcasts,
  useBroadcastPreview, useSendBroadcast,
  type WaStatus, type BroadcastPreview,
} from "@/lib/queries/whatsapp-marketing";

const TABS: TabBarItem[] = [
  { id: "broadcast", label: "Broadcast" },
  { id: "templates", label: "Templates" },
  { id: "optouts",   label: "Opt-outs" },
  { id: "history",   label: "History" },
];

const STATUS: Record<WaStatus, { label: string; kind: "muted" | "warning" | "success" | "danger" | "info" }> = {
  draft:     { label: "Draft",            kind: "muted" },
  submitted: { label: "With Meta",        kind: "warning" },
  approved:  { label: "Approved",         kind: "success" },
  rejected:  { label: "Rejected",         kind: "danger" },
  paused:    { label: "Paused",           kind: "info" },
};

const STAGES = [
  { id: "new", label: "New" }, { id: "contact", label: "Contacted" }, { id: "demo", label: "Demo" },
  { id: "trial", label: "Trial" }, { id: "quote", label: "Quote sent" }, { id: "won", label: "Won" }, { id: "lost", label: "Lost" },
];

export default function WhatsAppMarketingPage() {
  const [tab, setTab] = React.useState("broadcast");
  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">WhatsApp broadcast</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-3xl">
          The first WhatsApp message can only be an <b>approved template</b> from Meta. Write the template here, submit it to Meta,
          and once approved send it to leads in one go. Anyone who replies STOP gets nothing more. For one-to-one chats, use the{" "}
          <Link href="/whatsapp" className="text-amber-ink hover:underline">WhatsApp inbox</Link>. Automatic renewal and invoice
          reminders:{" "}
          <Link href="/marketing/whatsapp/reminders" className="text-amber-ink hover:underline">WhatsApp reminders</Link>.
        </p>
      </header>
      <TabBar items={TABS} value={tab} onChange={setTab} />
      {tab === "broadcast" && <BroadcastTab goTemplates={() => setTab("templates")} />}
      {tab === "templates" && <TemplatesTab />}
      {tab === "optouts" && <OptOutsTab />}
      {tab === "history" && <HistoryTab />}
    </div>
  );
}

// ── Broadcast ────────────────────────────────────────────────────────────────

function BroadcastTab({ goTemplates }: { goTemplates: () => void }) {
  const tpls = useWaTemplates();
  const preview = useBroadcastPreview();
  const send = useSendBroadcast();
  const confirm = useConfirm();
  const approved = (tpls.data ?? []).filter((t) => t.status === "approved");
  const [templateId, setTemplateId] = React.useState("");
  const [stages, setStages] = React.useState<string[]>(["new", "contact"]);
  const [p, setP] = React.useState<BroadcastPreview | null>(null);

  React.useEffect(() => { setP(null); }, [templateId, stages]);
  const input = { templateId, audience: { stages } };

  if (tpls.isLoading) return <Skeleton className="h-40" />;
  if (approved.length === 0) {
    return (
      <Card className="py-2">
        <EmptyState icon="whatsapp" title="No approved templates yet"
          body="Copy a starter template in the Templates tab and submit it to Meta (WhatsApp Manager → Message templates) under the same name. Once approved, set its status to Approved here or press Sync from Meta." />
        <div className="flex justify-center pb-4"><Button onClick={goTemplates}>Open templates</Button></div>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-4">
      <FormField label="Template" htmlFor="bc_tpl">
        <Select value={templateId} onValueChange={setTemplateId}>
          <SelectTrigger id="bc_tpl"><SelectValue placeholder="Choose an approved template" /></SelectTrigger>
          <SelectContent>{approved.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.language})</SelectItem>)}</SelectContent>
        </Select>
      </FormField>
      <div>
        <p className="text-sm font-medium text-ink mb-1.5">Leads in these stages</p>
        <div className="flex flex-wrap gap-2">
          {STAGES.map((s) => (
            <button key={s.id} type="button"
              onClick={() => setStages((cur) => cur.includes(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id])}
              className={cn("rounded-full border px-3 py-1 text-xs", stages.includes(s.id) ? "border-amber bg-amber-soft/40 text-ink" : "border-hairline text-ink-2")}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" disabled={!templateId || stages.length === 0 || preview.isPending}
          onClick={() => preview.mutate(input, { onSuccess: setP })}>
          {preview.isPending ? "Counting…" : "How many will receive it?"}
        </Button>
      </div>

      {p && (
        <div className="rounded-lg border border-hairline bg-paper-2/40 p-3 space-y-2 text-sm">
          <p>Goes to <b>{p.recipients}</b> leads
            {p.skippedOptOut > 0 && <> · {p.skippedOptOut} skipped (sent STOP)</>}
            {p.noPhone > 0 && <> · {p.noPhone} without a valid mobile number</>}
            {p.overCap > 0 && <> · {p.overCap} next time (250 per send)</>}
          </p>
          {p.sample && (
            <div>
              <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1">What the first lead will see</p>
              <p className="whitespace-pre-wrap rounded-md bg-[#dcf8c6] text-[#111] p-2.5 max-w-md text-[13px]">{p.sample}</p>
            </div>
          )}
          {!p.connected && (
            <p className="text-amber-ink text-xs">WhatsApp Business API is not connected — connect it in Settings before sending.</p>
          )}
          <Button disabled={p.recipients === 0 || !p.connected || send.isPending} onClick={async () => {
            const ok = await confirm({
              title: `Send WhatsApp to ${p.recipients} people?`,
              body: "A sent message can't be taken back. If many people block or report it, Meta lowers your number's rating — only send to people who know you.",
              confirmLabel: "Yes, send", cancelLabel: COPY.cancel,
            });
            if (ok) send.mutate(input, { onSuccess: () => setP(null) });
          }}>{send.isPending ? "Sending…" : `Send to ${p.recipients}`}</Button>
        </div>
      )}
    </Card>
  );
}

// ── Templates ────────────────────────────────────────────────────────────────

type Draft = { id?: string; name: string; language: string; category: "MARKETING" | "UTILITY"; body: string; param_map: string[]; status: WaStatus };

function TemplatesTab() {
  const q = useWaTemplates();
  const sync = useSyncWaTemplates();
  const del = useDeleteWaTemplate();
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<Draft | null>(null);
  const mine = q.data ?? [];
  const names = new Set(mine.map((t) => t.name));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <Button icon="plus" onClick={() => setEditing({ name: "", language: "en", category: "MARKETING", body: "", param_map: [], status: "draft" })}>New template</Button>
        <Button variant="outline" icon="refresh" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? "Sync…" : "Sync from Meta"}</Button>
      </div>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-ink border-b border-hairline pb-1.5">Your templates ({mine.length})</h2>
        {q.isLoading ? <Skeleton className="h-24" /> : mine.length === 0 ? (
          <p className="text-sm text-ink-3">None yet — copy a starter below.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {mine.map((t) => (
              <Card key={t.id} className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-mono text-sm text-ink">{t.name} <span className="text-ink-3">· {t.language}</span></div>
                  <Badge kind={STATUS[t.status].kind} size="sm">{STATUS[t.status].label}</Badge>
                </div>
                <p className="whitespace-pre-wrap text-xs text-ink-2 line-clamp-4">{t.body}</p>
                {t.param_map.length > 0 && (
                  <p className="text-xs text-ink-3">{t.param_map.map((f, i) => `{{${i + 1}}} = ${PARAM_FIELDS[f as ParamField]?.label ?? f}`).join(" · ")}</p>
                )}
                {t.notes && <p className="text-xs text-amber-ink">{t.notes}</p>}
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => setEditing({ ...t })}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={async () => {
                    try { await navigator.clipboard.writeText(t.body); toast.success("Text copied — paste it in Meta"); } catch { toast.error("Couldn't copy"); }
                  }}>Copy text</Button>
                  <Button variant="ghost" size="sm" onClick={async () => {
                    const ok = await confirm({ title: "Delete template?", body: `${t.name} is removed from the app only, not from Meta.`, danger: true, confirmLabel: COPY.delete, cancelLabel: COPY.cancel });
                    if (ok) del.mutate(t.id);
                  }}>Delete</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-ink border-b border-hairline pb-1.5">Starter templates</h2>
        <p className="text-xs text-ink-3">Copy → submit to Meta under the same name → set status to Approved once approved.</p>
        <div className="grid gap-3 md:grid-cols-2">
          {STARTER_WA_TEMPLATES.map((s) => (
            <Card key={s.name} className="p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="font-mono text-sm text-ink">{s.name}</div>
                <span className="text-xs text-ink-3">{s.when}</span>
              </div>
              <p className="whitespace-pre-wrap text-xs text-ink-2">{s.body}</p>
              <Button variant="outline" size="sm" disabled={names.has(s.name)}
                onClick={() => setEditing({ name: s.name, language: "en", category: s.category, body: s.body, param_map: [...s.param_map], status: "draft" })}>
                {names.has(s.name) ? "Already added" : "Add to my templates"}
              </Button>
            </Card>
          ))}
        </div>
      </section>

      {editing && <TemplateDialog draft={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TemplateDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const save = useSaveWaTemplate();
  const [d, setD] = React.useState<Draft>(draft);
  const n = paramCount(d.body);
  // Keep the field list as long as the slot count.
  React.useEffect(() => {
    setD((cur) => cur.param_map.length === n ? cur
      : { ...cur, param_map: Array.from({ length: n }, (_, i) => cur.param_map[i] ?? "first_name") });
  }, [n]);
  const problem = !isValidTemplateName(d.name) ? "Name: lowercase letters, numbers and _ only (e.g. festival_offer)." : templateProblem(d.body, d.param_map);
  const sample = renderBody(d.body, slotValues(d.param_map, { first_name: "Deepak", company: "Excel Technologies", sender: "Anutech" }));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>{d.id ? "Edit template" : "WhatsApp template"}</DialogTitle>
          <DialogDescription>Keep the name and text exactly as submitted to Meta. {"{{1}}"}, {"{{2}}"} … are filled in for each lead.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[62vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-3 gap-3">
            <FormField label="Name (as on Meta)" required htmlFor="wt_name">
              <Input id="wt_name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value.trim().toLowerCase() })} placeholder="festival_offer" />
            </FormField>
            <FormField label="Language" htmlFor="wt_lang">
              <Input id="wt_lang" value={d.language} onChange={(e) => setD({ ...d, language: e.target.value.trim() })} placeholder="en / hi / en_US" />
            </FormField>
            <FormField label="Status" htmlFor="wt_status">
              <Select value={d.status} onValueChange={(v) => setD({ ...d, status: v as WaStatus })}>
                <SelectTrigger id="wt_status"><SelectValue /></SelectTrigger>
                <SelectContent>{(Object.keys(STATUS) as WaStatus[]).map((k) => <SelectItem key={k} value={k}>{STATUS[k].label}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          </div>
          <FormField label="Message" required htmlFor="wt_body">
            <textarea id="wt_body" rows={6} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })}
              className="w-full rounded-md border border-hairline bg-paper p-2 text-sm" />
          </FormField>
          {n > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {d.param_map.map((f, i) => (
                <FormField key={i} label={`What goes in {{${i + 1}}}`} htmlFor={`wt_p${i}`}>
                  <Select value={f} onValueChange={(v) => setD({ ...d, param_map: d.param_map.map((x, j) => j === i ? v : x) })}>
                    <SelectTrigger id={`wt_p${i}`}><SelectValue /></SelectTrigger>
                    <SelectContent>{(Object.keys(PARAM_FIELDS) as ParamField[]).map((k) => <SelectItem key={k} value={k}>{PARAM_FIELDS[k].label}</SelectItem>)}</SelectContent>
                  </Select>
                </FormField>
              ))}
            </div>
          )}
          {d.body.trim() && (
            <div>
              <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Preview</p>
              <p className="whitespace-pre-wrap rounded-md bg-[#dcf8c6] text-[#111] p-2.5 max-w-md text-[13px]">{sample}</p>
            </div>
          )}
          {!/stop/i.test(d.body) && d.category === "MARKETING" && d.body.trim() && (
            <p className="text-xs text-amber-ink">Add a line like &ldquo;Reply STOP to opt out&rdquo; to marketing messages — Meta prefers it, and a STOP reply opts the person out automatically.</p>
          )}
          {problem && <p className="text-xs text-red-600">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!!problem || save.isPending} onClick={async () => {
            await save.mutateAsync({ id: d.id, name: d.name, language: d.language || "en", category: d.category, body: d.body, param_map: d.param_map, status: d.status, notes: null });
            onClose();
          }}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Opt-outs ─────────────────────────────────────────────────────────────────

function OptOutsTab() {
  const q = useWaOptOuts();
  const add = useAddWaOptOut();
  const remove = useRemoveWaOptOut();
  const confirm = useConfirm();
  const [phone, setPhone] = React.useState("");
  const norm = normalizeWaPhone(phone);
  return (
    <Card className="p-4 space-y-3">
      <p className="text-sm text-ink-2">Anyone who replies STOP is added here automatically. If someone declined by phone, add their number by hand.</p>
      <div className="flex gap-2 flex-wrap">
        <Input aria-label="Phone number to opt out" className="max-w-xs" placeholder="98990 65121" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Button disabled={!norm || add.isPending} onClick={() => { if (norm) add.mutate(norm, { onSuccess: () => setPhone("") }); }}>Add to opt-out list</Button>
        {phone && !norm && <span className="text-xs text-red-600 self-center">Number looks invalid</span>}
      </div>
      {q.isLoading ? <Skeleton className="h-16" /> : (q.data ?? []).length === 0 ? (
        <p className="text-xs text-ink-3">None yet.</p>
      ) : (
        <div className="divide-y divide-hairline border-t border-hairline">
          {(q.data ?? []).map((o) => (
            <div key={o.phone} className="flex items-center justify-between py-2 text-sm">
              <span className="font-mono text-ink">{o.phone}</span>
              <span className="flex items-center gap-3 text-xs text-ink-3">
                {o.reason === "stop" ? "Replied STOP" : "Manual"} · {formatDate(o.created_at)}
                <Button variant="ghost" size="sm" onClick={async () => {
                  const ok = await confirm({ title: "Remove opt-out?", body: "Only if this person asked for messages again.", confirmLabel: "Yes, they asked", cancelLabel: COPY.cancel });
                  if (ok) remove.mutate(o.phone);
                }}>{COPY.remove}</Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── History ──────────────────────────────────────────────────────────────────

function HistoryTab() {
  const q = useWaBroadcasts();
  if (q.isLoading) return <Skeleton className="h-24" />;
  if ((q.data ?? []).length === 0) return <Card className="py-2"><EmptyState icon="whatsapp" title="No broadcasts yet" body="Your first broadcast will appear here once sent." /></Card>;
  return (
    <Card flush>
      <table className="w-full">
        <thead className="bg-paper-2 border-y border-hairline-strong">
          <tr>{["Date", "Template", "Recipients", "Sent", "Failed", "Skipped (STOP)"].map((h, i) => (
            <th key={h} className={cn("px-3 py-2 text-2xs font-semibold text-ink-3 uppercase tracking-wider", i >= 2 ? "text-right" : "text-left")}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((b) => (
            <tr key={b.id} className="border-b border-hairline last:border-0 text-sm">
              <td className="px-3 py-2 text-ink-2">{formatDate(b.created_at)}</td>
              <td className="px-3 py-2 font-mono">{b.template_name}</td>
              <td className="px-3 py-2 text-right tabular-nums">{b.recipients_count}</td>
              <td className="px-3 py-2 text-right tabular-nums text-emerald">{b.sent_count}</td>
              <td className={cn("px-3 py-2 text-right tabular-nums", b.failed_count ? "text-red-600" : "text-ink-3")}>{b.failed_count}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-3">{b.skipped_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

