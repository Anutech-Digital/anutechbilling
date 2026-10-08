/**
 * WhatsApp reminders — /marketing/whatsapp/reminders (S28, Pardeep).
 *
 * The renewals and invoice-dunning crons can already send a WhatsApp next to their email
 * (lib/marketing/whatsapp-reminders.server.ts), but the switch and the template per
 * reminder kind could only be set in the database. This is that screen:
 *   1. What must be true first — template approved on Meta, automation dial on "auto",
 *      WhatsApp connected. Said up front, because each one silently stops a reminder.
 *   2. The master switch (default OFF).
 *   3. One template per reminder kind, with what would stop that kind today.
 *   4. The last 20 attempts from whatsapp_reminder_log (sent → delivered → read / failed).
 * WHEN a reminder is due is the crons' ladder, not decided here.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/errors/toast-error";
import { startersToSubmit } from "@/lib/marketing/whatsapp-reminders-submit";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/providers/confirm-provider";
import { COPY } from "@/lib/copy";
import { cn, formatDate } from "@/lib/utils";
import { paramCount } from "@/lib/marketing/whatsapp-broadcast";
import {
  REMINDER_KINDS, REMINDER_PARAM_FIELDS, STARTER_REMINDER_TEMPLATES, type ReminderParamField,
} from "@/lib/marketing/whatsapp-reminders";
import {
  REMINDER_FIELD_ORDER, defaultParamMap, isStarterReminderName, logStatus, mappingProblem, skipReasonText,
} from "@/lib/marketing/whatsapp-reminders-settings";
import {
  useWaReminders, useSetWaRemindersEnabled, useSaveReminderMapping, useDeleteReminderMapping,
  type ReminderKindView, type WaRemindersView,
} from "@/lib/queries/whatsapp-reminders";

const DIAL_LABEL: Record<string, string> = { auto: "auto (sends)", hold: "hold (paused)", off: "off" };

export default function WhatsAppRemindersPage() {
  const q = useWaReminders();
  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">WhatsApp reminders</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-3xl">
          Renewal and invoice reminders can go on WhatsApp as well as email. The renewals / dunning schedule decides
          when — here you only set ON/OFF and which template. To write templates and sync them from Meta, use{" "}
          <Link href="/marketing/whatsapp" className="text-amber-ink hover:underline">WhatsApp broadcast → Templates</Link>.
        </p>
      </header>

      {q.isLoading ? (
        <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-48" /><Skeleton className="h-40" /></div>
      ) : q.error || !q.data ? (
        <Card className="py-2">
          <EmptyState icon="whatsapp" title="Could not load settings"
            body={q.error instanceof Error ? q.error.message : "Refresh the page and try again."} />
          <div className="flex justify-center pb-4"><Button variant="outline" onClick={() => q.refetch()}>{COPY.tryAgain}</Button></div>
        </Card>
      ) : (
        <>
          <BeforeYouStart v={q.data} />
          <MasterSwitch v={q.data} />
          <KindsCard v={q.data} />
          <LogCard v={q.data} />
        </>
      )}
    </div>
  );
}

// ── 1. What must be true first ──────────────────────────────────────────────

function BeforeYouStart({ v }: { v: WaRemindersView }) {
  const dialOk = !v.dial.killSwitch && v.dial.renewal === "auto" && v.dial.dunning === "auto";
  return (
    <Card className="p-4 border-amber/40 bg-amber-soft/20 space-y-2">
      <h2 className="text-sm font-semibold text-ink">A WhatsApp reminder goes out only when all three are true</h2>
      <ol className="list-decimal pl-5 space-y-1.5 text-sm text-ink-2">
        <li>
          <b>The template is approved on Meta.</b> Typing a name here sends nothing — use the button below to send the starter templates
          to Meta from the app (or submit them in WhatsApp Manager with the same name + language); once approved, press{" "}
          <Link href="/marketing/whatsapp" className="text-amber-ink hover:underline">Templates → Sync from Meta</Link>.
          Reminders are about bills, so keep the category <b>UTILITY</b>.
        </li>
        <li>
          <b>The automation dial allows it.</b> &ldquo;Send a renewal reminder&rdquo; and &ldquo;Chase an overdue invoice&rdquo; are both on{" "}
          <b>auto</b> — on hold or off, no WhatsApp goes out.{" "}
          <Link href="/automation" className="text-amber-ink hover:underline">Open automation</Link>
          <span className="ml-2 inline-flex flex-wrap gap-1.5 align-middle">
            {v.dial.killSwitch && <Badge kind="danger" size="sm">Master switch off</Badge>}
            <Badge kind={v.dial.renewal === "auto" && !v.dial.killSwitch ? "success" : "warning"} size="sm">Renewal: {DIAL_LABEL[v.dial.renewal] ?? v.dial.renewal}</Badge>
            <Badge kind={v.dial.dunning === "auto" && !v.dial.killSwitch ? "success" : "warning"} size="sm">Invoice: {DIAL_LABEL[v.dial.dunning] ?? v.dial.dunning}</Badge>
          </span>
        </li>
        <li>
          <b>WhatsApp Business API is connected.</b>{" "}
          <Link href="/settings" className="text-amber-ink hover:underline">Settings → Integrations</Link>
          <span className="ml-2 align-middle">
            <Badge kind={v.connected ? "success" : "warning"} size="sm">{v.connected ? "Connected" : "Not connected"}</Badge>
          </span>
        </li>
      </ol>
      <p className="text-xs text-ink-3">
        Anyone who sent STOP never gets one. Each step (e.g. &ldquo;7 days overdue&rdquo;) goes to a customer only once.
        {!dialOk && " Some reminders are held by the dial right now — each kind below says which."}
      </p>
      <SubmitStarters v={v} />
    </Card>
  );
}

// ── 1a. Starter templates → Meta, from the app ──────────────────────────────

interface SubmitResult { kind: string; name: string; ok: boolean; status: string | null; error?: string }

/** One button that submits every not-yet-submitted starter to Meta (POST …/reminders/submit). */
function SubmitStarters({ v }: { v: WaRemindersView }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [results, setResults] = React.useState<SubmitResult[] | null>(null);
  const pending = startersToSubmit(v.templates);
  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/marketing/whatsapp/reminders/submit", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Could not send templates to Meta — refresh the page and try again.");
      return j as { submitted: number; results: SubmitResult[] };
    },
    onSuccess: (r) => {
      setResults(r.results);
      qc.invalidateQueries({ queryKey: ["wa-reminders"] });
      const failed = r.results.filter((x) => !x.ok).length;
      if (failed === 0) toast.success(`${r.results.length} templates sent to Meta — approval usually takes a few minutes to 24 hours`);
      else toast.warning(`${failed} templates not sent — the reason is shown below`);
    },
    onError: (err) => toastError(err),
  });

  if (!v.connected || (pending.length === 0 && !results)) return null;

  return (
    <div className="border-t border-amber/30 pt-3 space-y-2">
      {pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={submit.isPending} onClick={async () => {
            const ok = await confirm({
              title: `Send ${pending.length} templates to Meta?`,
              body: `These starter templates (UTILITY, English) go from your WhatsApp Business account to Meta for approval: ${pending.map((s) => s.name).join(", ")}. Nothing is sent to customers yet.`,
              confirmLabel: "Yes, send", cancelLabel: COPY.cancel,
            });
            if (ok) submit.mutate();
          }}>
            {submit.isPending ? "Sending to Meta…" : `Send for Meta approval (${pending.length})`}
          </Button>
          <span className="text-xs text-ink-3">
            No need to sign in to WhatsApp Manager and type them. Copying each kind's &ldquo;Starter wording&rdquo; below also works.
          </span>
        </div>
      )}
      {results && (
        <div className="space-y-1" aria-live="polite">
          <ul className="space-y-1 text-xs">
            {results.map((r) => (
              <li key={r.name} className="flex flex-wrap items-center gap-1.5">
                <Badge kind={r.ok ? (r.status === "approved" ? "success" : "info") : "danger"} size="sm">
                  {r.ok ? (r.status ?? "sent") : "Not sent"}
                </Badge>
                <span className="font-mono text-ink-2">{r.name}</span>
                {r.error && <span className={r.ok ? "text-ink-3" : "text-rose-ink"}>{r.error}</span>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-3">
            Once approved, press{" "}
            <Link href="/marketing/whatsapp" className="text-amber-ink hover:underline">Templates → Sync from Meta</Link>,{" "}
            then &ldquo;Set template&rdquo; on each kind below — the starter name is filled in already.
          </p>
        </div>
      )}
    </div>
  );
}

// ── 2. Master switch ────────────────────────────────────────────────────────

function MasterSwitch({ v }: { v: WaRemindersView }) {
  const set = useSetWaRemindersEnabled();
  const confirm = useConfirm();
  const readyCount = v.kinds.filter((k) => k.readiness.state === "ready" || k.readiness.state === "switch_off").length;

  async function toggle(next: boolean) {
    if (next) {
      const ok = await confirm({
        title: "Turn on WhatsApp reminders?",
        body: readyCount === 0
          ? "No template is ready yet, so nothing will go out even when on — set a template below first. Turn on anyway?"
          : `From the next cron run, reminders for ${readyCount} kinds go to customers on WhatsApp. A sent message can't be taken back.`,
        confirmLabel: "Yes, turn on", cancelLabel: COPY.cancel,
      });
      if (!ok) return;
    }
    set.mutate(next);
  }

  return (
    <Card className="p-4 flex flex-wrap items-center gap-4 justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-ink">WhatsApp reminders</h2>
          <Badge kind={v.enabled ? "success" : "muted"} dot>{v.enabled ? "ON" : "OFF"}</Badge>
        </div>
        <p className="text-sm text-ink-3 mt-0.5">
          {v.enabled
            ? "Renewal and invoice reminders go on WhatsApp as well as email (where a template is ready)."
            : "Off — no reminder goes on WhatsApp. Email continues as before."}
          {v.updatedAt && <> · Last changed {formatDate(v.updatedAt, "long")}</>}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-2">
        <Switch checked={v.enabled} disabled={set.isPending} onCheckedChange={toggle} aria-label="WhatsApp reminders ON / OFF" />
        {set.isPending ? "Saving…" : v.enabled ? "ON" : "OFF"}
      </label>
    </Card>
  );
}

// ── 3. Template per kind ────────────────────────────────────────────────────

function KindsCard({ v }: { v: WaRemindersView }) {
  const [editing, setEditing] = React.useState<ReminderKindView | null>(null);
  const del = useDeleteReminderMapping();
  const confirm = useConfirm();
  const groups = [
    { subject: "subscription" as const, title: "Renewal reminders" },
    { subject: "invoice" as const, title: "Invoice due / overdue reminders" },
  ];

  return (
    <Card flush>
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-base font-semibold text-ink">Template for each reminder</h2>
        <p className="text-xs text-ink-3 mt-0.5">Kinds without a template send email only.</p>
      </div>
      {groups.map((g) => (
        <section key={g.subject} className="border-t border-hairline">
          <h3 className="px-4 pt-3 pb-1 text-2xs uppercase tracking-wider text-ink-3 font-semibold">{g.title}</h3>
          <ul className="divide-y divide-hairline">
            {v.kinds.filter((k) => k.subject === g.subject).map((k) => (
              <li key={k.kind} className="px-4 py-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium text-ink">{k.label}</p>
                  {k.mapping ? (
                    <p className="text-xs text-ink-2 flex flex-wrap items-center gap-1.5">
                      <span className="font-mono">{k.mapping.template_name}</span>
                      <span className="text-ink-3">· {k.mapping.language}</span>
                      <Badge kind={k.templateStatus === "approved" ? "success" : k.templateStatus ? "warning" : "muted"} size="sm">
                        Meta: {k.templateStatus ?? "not in app"}
                      </Badge>
                      {!k.mapping.enabled && <Badge kind="muted" size="sm">Off</Badge>}
                    </p>
                  ) : (
                    <p className="text-xs text-ink-3">No template set</p>
                  )}
                  <p className="text-xs flex items-start gap-1.5">
                    <Badge kind={k.readiness.tone} size="sm">{k.readiness.state === "ready" ? "Will send" : k.readiness.state === "switch_off" ? "Ready" : "Held"}</Badge>
                    <span className="text-ink-2">{k.readiness.text}</span>
                  </p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button variant="outline" size="sm" onClick={() => setEditing(k)}>{k.mapping ? "Edit" : "Set template"}</Button>
                  {k.mapping && (
                    <Button variant="ghost" size="sm" disabled={del.isPending} onClick={async () => {
                      const ok = await confirm({
                        title: "Remove template?",
                        body: `WhatsApp for "${k.label}" stops; email keeps going. The template stays in Meta.`,
                        danger: true, confirmLabel: COPY.remove, cancelLabel: COPY.cancel,
                      });
                      if (ok) del.mutate(k.kind);
                    }}>{COPY.remove}</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {editing && <MappingDialog kind={editing} v={v} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function MappingDialog({ kind, v, onClose }: { kind: ReminderKindView; v: WaRemindersView; onClose: () => void }) {
  const save = useSaveReminderMapping();
  const starter = STARTER_REMINDER_TEMPLATES.find((s) => s.kind === kind.kind)!;
  const [name, setName] = React.useState(kind.mapping?.template_name ?? starter.name);
  const [language, setLanguage] = React.useState(kind.mapping?.language ?? "en");
  const [enabled, setEnabled] = React.useState(kind.mapping?.enabled ?? true);
  const known = v.templates.find((t) => t.name === name && t.language === language) ?? null;
  const knownBody = known?.body ?? null;
  const [map, setMap] = React.useState<ReminderParamField[]>(() =>
    defaultParamMap(kind.kind, name, knownBody, kind.mapping?.param_map ?? []));

  /* Naam / language badla → agar app ke paas us template ka text hai to {{n}} ki ginti wahi;
     starter naam ho to uska apna map. Pehli render par saved map hi rehta hai. */
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) { first.current = false; return; }
    setMap((cur) => defaultParamMap(kind.kind, name, knownBody, isStarterReminderName(name) ? [] : cur));
  }, [kind.kind, name, knownBody]);

  function setSlotCount(n: number) {
    const c = Math.max(0, Math.min(10, Number.isFinite(n) ? Math.trunc(n) : 0));
    setMap((cur) => Array.from({ length: c }, (_, i) => cur[i] ?? "customer_name"));
  }

  const problem = mappingProblem(name, language, map, knownBody);
  const approved = known?.status === "approved";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>{REMINDER_KINDS[kind.kind].label}</DialogTitle>
          <DialogDescription>Use the exact name and language approved on Meta. {"{{1}}"}, {"{{2}}"} … are filled in for each customer.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[62vh] overflow-y-auto pr-1">
          {v.templates.length > 0 && (
            <FormField label="Pick from templates in the app" htmlFor="wr_pick">
              <Select value={known ? `${known.name}|${known.language}` : ""} onValueChange={(val) => {
                const [n, l] = val.split("|");
                setName(n); setLanguage(l);
              }}>
                <SelectTrigger id="wr_pick"><SelectValue placeholder="Choose a template (or type a name below)" /></SelectTrigger>
                <SelectContent>
                  {v.templates.map((t) => (
                    <SelectItem key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
                      {t.name} ({t.language}) — {t.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Template name (as on Meta)" required htmlFor="wr_name" className="sm:col-span-2">
              <Input id="wr_name" value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder={starter.name} />
            </FormField>
            <FormField label="Language" required htmlFor="wr_lang">
              <Input id="wr_lang" value={language} onChange={(e) => setLanguage(e.target.value.trim())} placeholder="en / hi / en_US" />
            </FormField>
          </div>

          {known ? (
            <div className="space-y-1">
              <p className="text-xs">
                <Badge kind={approved ? "success" : "warning"} size="sm">Meta: {known.status}</Badge>
                {!approved && <span className="ml-2 text-amber-ink">This template will not send until approved.</span>}
              </p>
              <p className="whitespace-pre-wrap rounded-md bg-[#dcf8c6] text-[#111] p-2.5 max-w-md text-[13px]">{known.body}</p>
            </div>
          ) : (
            <div className="rounded-md border border-hairline bg-paper-2/40 p-3 space-y-2">
              <p className="text-xs text-amber-ink">
                This name is not among the app's templates, so it cannot show as &ldquo;approved&rdquo; and the reminder will not send.
                Submit it on Meta, then press Templates → Sync from Meta.
              </p>
              <FormField label="How many {{n}} in the template" htmlFor="wr_slots">
                <Input id="wr_slots" type="number" min={0} max={10} className="max-w-[8rem]" value={map.length}
                  onChange={(e) => setSlotCount(Number(e.target.value))} />
              </FormField>
            </div>
          )}

          {map.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {map.map((f, i) => (
                <FormField key={i} label={`What goes in {{${i + 1}}}`} htmlFor={`wr_p${i}`}>
                  <Select value={f} onValueChange={(val) => setMap((cur) => cur.map((x, j) => (j === i ? (val as ReminderParamField) : x)))}>
                    <SelectTrigger id={`wr_p${i}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {REMINDER_FIELD_ORDER.map((k) => <SelectItem key={k} value={k}>{REMINDER_PARAM_FIELDS[k].label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </FormField>
              ))}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-ink-2" htmlFor="wr_enabled">
            <Checkbox id="wr_enabled" checked={enabled} onCheckedChange={(c) => setEnabled(c === true)} />
            WhatsApp on for this kind
          </label>

          <details className="rounded-md border border-hairline p-3 text-xs">
            <summary className="cursor-pointer text-ink-2 font-medium">Starter wording (to submit on Meta)</summary>
            <p className="mt-2 font-mono text-ink">{starter.name} · UTILITY · {paramCount(starter.body)} slots</p>
            <p className="mt-1 whitespace-pre-wrap text-ink-2">{starter.body}</p>
            <p className="mt-1 text-ink-3">{starter.param_map.map((f, i) => `{{${i + 1}}} = ${REMINDER_PARAM_FIELDS[f].label}`).join(" · ")}</p>
            <Button variant="ghost" size="sm" className="mt-1" onClick={async () => {
              try { await navigator.clipboard.writeText(starter.body); toast.success("Text copied — paste it in Meta"); }
              catch { toast.error("Couldn't copy — select the text and copy it"); }
            }}>Copy text</Button>
          </details>

          {problem && <p className="text-xs text-red-600" role="alert">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!!problem || save.isPending} onClick={async () => {
            await save.mutateAsync({ kind: kind.kind, template_name: name, language, param_map: map, enabled });
            onClose();
          }}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 4. Log ──────────────────────────────────────────────────────────────────

function LogCard({ v }: { v: WaRemindersView }) {
  if (v.log.length === 0) {
    return (
      <Card className="py-2">
        <EmptyState icon="whatsapp" title="No WhatsApp reminders sent yet"
          body="Once the switch is ON and a template is approved, each reminder sent or held in the next cron run shows up here." />
      </Card>
    );
  }
  return (
    <Card flush>
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-base font-semibold text-ink">Last {v.log.length} WhatsApp reminders</h2>
        <p className="text-xs text-ink-3 mt-0.5">Delivered / Read update automatically from Meta.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead className="bg-paper-2 border-y border-hairline-strong">
            <tr>{["When", "Reminder", "Number", "Template", "Status", "Detail"].map((h) => (
              <th key={h} scope="col" className="px-3 py-2 text-left text-2xs font-semibold text-ink-3 uppercase tracking-wider">{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {v.log.map((r) => {
              const st = logStatus(r.status);
              const kindLabel = (REMINDER_KINDS as Record<string, { label: string }>)[r.kind]?.label ?? r.kind;
              const detail = r.status === "skipped" ? skipReasonText(r.skip_reason)
                : r.status === "failed" ? r.error_message
                : r.status === "read" ? `Padha ${formatDate(r.read_at, "long")}`
                : r.status === "delivered" ? `Pahuncha ${formatDate(r.delivered_at, "long")}`
                : null;
              return (
                <tr key={r.id} className="border-b border-hairline last:border-0 text-sm align-top">
                  <td className="px-3 py-2 text-ink-2 whitespace-nowrap">{formatDate(r.sent_at ?? r.created_at, "long")}</td>
                  <td className="px-3 py-2">
                    <span className="text-ink">{kindLabel}</span>
                    <span className="block text-xs text-ink-3">{r.subject_type === "invoice" ? "Invoice" : "Subscription"} {r.subject_id} · {r.step}</span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-ink-2">{r.phone ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-ink-2">{r.template_name ?? "—"}</td>
                  <td className="px-3 py-2"><Badge kind={st.tone} size="sm" dot>{st.label}</Badge></td>
                  <td className={cn("px-3 py-2 text-xs", r.status === "failed" ? "text-rose-ink" : "text-ink-3")}>{detail ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
