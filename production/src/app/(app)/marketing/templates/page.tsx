/**
 * Email templates — /marketing/templates
 *
 * Pardeep, 26 Sep 2026: "kuch template bana do aur iska bhi management system ho". The
 * composer could load templates but nothing could be created, edited or deleted outside it,
 * and the system list was empty. Here: the system set (read-only, "Copy to mine"), the
 * company's own (create / edit / delete), a live preview, and a warning for any {{variable}}
 * the send route would not fill.
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirm } from "@/components/providers/confirm-provider";
import { cn } from "@/lib/utils";
import type { CampaignTemplateRow, CampaignTemplateCategory } from "@/lib/supabase/database.types";
import {
  useCampaignTemplates, useSaveTemplate, useDeleteTemplate,
  TEMPLATE_CATEGORIES, previewTemplate, unknownVariables,
} from "@/lib/queries/campaign-templates";

type Editing = { id?: string; from?: CampaignTemplateRow } | null;

const catLabel = (c: string) => TEMPLATE_CATEGORIES.find((x) => x.value === c)?.label ?? c;

export default function TemplatesPage() {
  const q = useCampaignTemplates();
  const del = useDeleteTemplate();
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<Editing>(null);
  const [viewing, setViewing] = React.useState<CampaignTemplateRow | null>(null);
  const [cat, setCat] = React.useState<string>("all");

  const all = q.data ?? [];
  const shown = all.filter((t) => cat === "all" || t.category === cat);
  const mine = shown.filter((t) => !t.is_system);
  const system = shown.filter((t) => t.is_system);

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Email templates</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            These appear under &ldquo;Start from a template&rdquo; when sending a campaign. System templates cannot be changed —
            use &ldquo;Copy and edit&rdquo; to make your own copy.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/campaigns"><Button variant="outline" size="sm">Campaigns</Button></Link>
          <Button size="sm" icon="plus" onClick={() => setEditing({})}>New template</Button>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {[{ value: "all", label: "All" }, ...TEMPLATE_CATEGORIES].map((c) => (
          <button key={c.value} type="button" onClick={() => setCat(c.value)}
            className={cn("rounded-full border px-3 py-1 text-xs", cat === c.value ? "border-amber bg-amber-soft/40 text-ink" : "border-hairline text-ink-2 hover:border-amber/60")}>
            {c.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : q.error ? (
        <Card className="p-4 text-sm text-red-600">{(q.error as Error).message}</Card>
      ) : (
        <>
          <Section title={`Your templates (${mine.length})`}>
            {mine.length === 0 ? (
              <p className="text-sm text-ink-3">None yet. Create one with &ldquo;New template&rdquo;, or copy a system template below.</p>
            ) : mine.map((t) => (
              <TemplateCard key={t.id} t={t}
                onView={() => setViewing(t)}
                actions={<>
                  <Button variant="outline" size="sm" onClick={() => setEditing({ id: t.id, from: t })}>Edit</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing({ from: { ...t, name: `${t.name} (copy)` } })}>Copy</Button>
                  <Button variant="ghost" size="sm" onClick={async () => {
                    const ok = await confirm({ title: "Delete template?", body: `"${t.name}" will be removed. Campaigns already sent are not affected.`, danger: true, confirmLabel: "Delete", cancelLabel: "Cancel" });
                    if (ok) del.mutate(t.id);
                  }}>Delete</Button>
                </>} />
            ))}
          </Section>
          <Section title={`System templates (${system.length})`}>
            {system.map((t) => (
              <TemplateCard key={t.id} t={t}
                onView={() => setViewing(t)}
                actions={<Button variant="outline" size="sm" onClick={() => setEditing({ from: { ...t, name: `${t.name} (copy)` } })}>Copy and edit</Button>} />
            ))}
          </Section>
        </>
      )}

      {viewing && <PreviewDialog t={viewing} onClose={() => setViewing(null)} />}
      {editing && <EditDialog editing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/**
 * Template HTML in a sandboxed iframe, never in this page's DOM. Any team member can save a
 * template (ctmpl_insert), so a template is untrusted HTML: an owner previewing one with a
 * <script> in it would have run it in their own session. `sandbox` with no allowances
 * blocks scripts, forms and same-origin access; the mail client the template is for
 * blocks scripts too, so the preview stays faithful.
 */
function HtmlPreview({ html, title, className }: { html: string; title: string; className?: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#222;background:#fff}
    p{margin:0 0 12px} ul{padding-left:20px} ol{padding-left:20px} a{color:#c2410c}
  </style></head><body>${html}</body></html>`;
  return (
    <iframe sandbox="" srcDoc={doc} title={title}
      className={cn("w-full rounded-lg border border-hairline bg-white", className)} />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-ink border-b border-hairline pb-1.5">{title}</h2>
      <div className="grid gap-3 md:grid-cols-2">{children}</div>
    </section>
  );
}

function TemplateCard({ t, onView, actions }: { t: CampaignTemplateRow; onView: () => void; actions: React.ReactNode }) {
  return (
    <Card className="p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onView} className="text-left font-medium text-ink hover:underline">{t.name}</button>
        <Badge kind={t.is_system ? "muted" : "info"} size="sm">{catLabel(t.category)}</Badge>
      </div>
      <p className="text-xs text-ink-2"><span className="text-ink-3">Subject:</span> {t.subject}</p>
      {t.description && <p className="text-xs text-ink-3">{t.description}</p>}
      <div className="flex flex-wrap gap-1.5 pt-1">
        <Button variant="ghost" size="sm" onClick={onView}>Preview</Button>
        {actions}
      </div>
    </Card>
  );
}

function PreviewDialog({ t, onClose }: { t: CampaignTemplateRow; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.name}</DialogTitle>
          <DialogDescription>Shown with a sample name and company. Each lead sees their own name in the real email.</DialogDescription>
        </DialogHeader>
        <p className="text-sm"><span className="text-ink-3">Subject:</span> <b>{previewTemplate(t.subject)}</b></p>
        <HtmlPreview html={previewTemplate(t.body_html)} title={`Preview: ${t.name}`} className="h-[55vh]" />
        <p className="text-xs text-ink-3">The unsubscribe link is added at the bottom automatically when sending.</p>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ editing, onClose }: { editing: NonNullable<Editing>; onClose: () => void }) {
  const save = useSaveTemplate();
  const f = editing.from;
  const [name, setName] = React.useState(f?.name ?? "");
  const [category, setCategory] = React.useState<CampaignTemplateCategory>(f?.category ?? "custom");
  const [description, setDescription] = React.useState(f?.description ?? "");
  const [subject, setSubject] = React.useState(f?.subject ?? "");
  const [html, setHtml] = React.useState(f?.body_html ?? "<p>Hi {{name}},</p>\n<p></p>\n<p>Regards,<br>{{sender}}</p>");
  const [text, setText] = React.useState(f?.body_text ?? "");
  const [tab, setTab] = React.useState<"edit" | "preview">("edit");

  const unknown = unknownVariables(subject, html, text);
  const valid = name.trim().length >= 2 && subject.trim().length >= 2 && html.trim().length >= 10;

  async function submit() {
    if (!valid) return;
    await save.mutateAsync({
      id: editing.id, name: name.trim(), category, subject: subject.trim(),
      body_html: html, body_text: text.trim() || null, description: description.trim() || null,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing.id ? "Edit template" : "New template"}</DialogTitle>
          <DialogDescription>
            Variables: <code>{"{{name}}"}</code> <code>{"{{company}}"}</code> <code>{"{{sender}}"}</code> · for offers <code>{"{{offer_code}}"}</code> <code>{"{{discount}}"}</code> <code>{"{{expires}}"}</code>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[62vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Name" required htmlFor="tp_name">
              <Input id="tp_name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali offer 2026" />
            </FormField>
            <FormField label="Type" htmlFor="tp_cat">
              <Select value={category} onValueChange={(v) => setCategory(v as CampaignTemplateCategory)}>
                <SelectTrigger id="tp_cat"><SelectValue /></SelectTrigger>
                <SelectContent>{TEMPLATE_CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
              </Select>
            </FormField>
          </div>
          <FormField label="When to use (note)" htmlFor="tp_desc">
            <Input id="tp_desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Lost leads after 2 months" />
          </FormField>
          <FormField label="Subject" required htmlFor="tp_subject">
            <Input id="tp_subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="e.g. Special offer for {{company}}" />
          </FormField>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-ink">Mail (HTML)</span>
              <div className="flex gap-1 text-xs">
                {(["edit", "preview"] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setTab(k)}
                    className={cn("rounded px-2 py-0.5", tab === k ? "bg-paper-2 text-ink" : "text-ink-3")}>{k === "edit" ? "Write" : "Preview"}</button>
                ))}
              </div>
            </div>
            {tab === "edit" ? (
              <textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={12}
                className="w-full rounded-md border border-hairline bg-paper p-2 font-mono text-xs" aria-label="Mail HTML" />
            ) : (
              <HtmlPreview html={previewTemplate(html)} title="Template preview" className="h-[20rem]" />
            )}
          </div>
          <FormField label="Plain text (optional)" htmlFor="tp_text">
            <textarea id="tp_text" value={text} onChange={(e) => setText(e.target.value)} rows={4}
              className="w-full rounded-md border border-hairline bg-paper p-2 text-xs" placeholder="For mail apps that do not show HTML" />
          </FormField>
          {unknown.length > 0 && (
            <p className="text-xs text-red-600">
              These variables will not be filled and will go out as typed: {unknown.map((u) => `{{${u}}}`).join(", ")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || unknown.length > 0 || save.isPending}>{save.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
