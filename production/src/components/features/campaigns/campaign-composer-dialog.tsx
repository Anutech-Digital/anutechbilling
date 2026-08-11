/**
 * CampaignComposerDialog — compose + send a bulk email to leads.
 *
 * Now supports:
 *   • Reusable templates (system + tenant-owned) — load with one click
 *   • HTML + plain-text body (toggle Visual / HTML / Text)
 *   • Live HTML preview pane
 *   • AI generation via Gemini (POST /api/campaigns/ai-generate)
 *   • Time-bound offer block
 *   • Live recipient count from audience filter
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { CampaignTemplateRow } from "@/lib/supabase/database.types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Hand-picked recipients (e.g. from the Contacts page). When set, the
   *  stage-audience picker is replaced by "sending to these N contacts". */
  recipients?: { email: string; name?: string; company?: string }[];
  /** Total contacts the operator selected (incl. ones without an email) — used
   *  to explain the "N selected → M emailable" gap. */
  totalSelected?: number;
}

const STAGE_OPTIONS: { id: string; label: string }[] = [
  { id: "new",     label: "New (raw inbox)" },
  { id: "contact", label: "Contacted" },
  { id: "demo",    label: "Demo done" },
  { id: "trial",   label: "Trial active" },
  { id: "quote",   label: "Quote sent" },
  { id: "won",     label: "Won (customers)" },
  { id: "lost",    label: "Lost (re-engage)" },
];

type BodyMode = "preview" | "html" | "text";

export default function CampaignComposerDialog({ open, onOpenChange, recipients, totalSelected }: Props) {
  const presetRecipients = React.useMemo(
    () => (recipients ?? []).filter((r) => r.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)),
    [recipients],
  );
  const hasPreset = presetRecipients.length > 0;
  const [stages, setStages]   = React.useState<string[]>(["new", "contact"]);
  const [search, setSearch]   = React.useState("");
  const [name, setName]       = React.useState("");
  const [subject, setSubject] = React.useState("");
  const [bodyText, setBodyText] = React.useState("");
  const [bodyHtml, setBodyHtml] = React.useState("");
  const [bodyMode, setBodyMode] = React.useState<BodyMode>("preview");

  const [offerEnabled, setOfferEnabled]   = React.useState(false);
  const [offerCode, setOfferCode]         = React.useState("");
  const [offerDiscount, setOfferDiscount] = React.useState("10");
  const [offerExpires, setOfferExpires]   = React.useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });

  // AI generator state
  const [aiOpen, setAiOpen]       = React.useState(false);
  const [aiPrompt, setAiPrompt]   = React.useState("");
  const [aiCategory, setAiCategory] = React.useState<"newsletter"|"offer"|"winback"|"onboarding"|"custom">("newsletter");
  const [aiRunning, setAiRunning] = React.useState(false);

  const [submitting, setSubmitting] = React.useState(false);

  // Tracks which template the user picked. Without this, the <select> reset
  // itself to "— Pick a template —" after every load — confusing because
  // the form fields would update but the dropdown wouldn't show what's loaded.
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<string>("");

  // ── Templates from DB ──────────────────────────────────────────
  const templatesQ = useQuery({
    queryKey: ["campaign_templates"],
    enabled:  open,
    queryFn: async (): Promise<CampaignTemplateRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("campaign_templates")
        .select("*")
        .order("is_system", { ascending: false })
        .order("name");
      if (error) throw error;
      return (data ?? []) as CampaignTemplateRow[];
    },
  });

  // ── Live recipient count ───────────────────────────────────────
  const recipientsQuery = useQuery({
    queryKey: ["campaigns", "recipient-count", stages, search],
    enabled:  open && !hasPreset && stages.length > 0,
    queryFn:  async () => {
      const supabase = createClient();
      let q = supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .not("contact_email", "is", null)
        .in("stage", stages as ("new"|"contact"|"demo"|"trial"|"quote"|"won"|"lost")[]);
      if (search.trim()) {
        const s = search.trim();
        q = q.or(`company.ilike.%${s}%,contact_name.ilike.%${s}%`);
      }
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
  });

  const recipientCount = hasPreset ? presetRecipients.length : (recipientsQuery.data ?? 0);

  // ── Live preview HTML (replace template vars with sample values) ─
  const previewHtml = React.useMemo(() => {
    if (!bodyHtml) return "";
    return bodyHtml
      .replace(/\{\{name\}\}/g, "Ramesh")
      .replace(/\{\{company\}\}/g, "Acme Pvt Ltd")
      .replace(/\{\{sender\}\}/g, "Anutech Digital")
      .replace(/\{\{offer_code\}\}/g, offerEnabled ? (offerCode || "SAMPLE") : "SAMPLE")
      .replace(/\{\{discount\}\}/g, offerEnabled ? String(offerDiscount || "10") : "10")
      .replace(/\{\{expires\}\}/g, offerEnabled ? new Date(offerExpires).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "31 May 2026");
  }, [bodyHtml, offerCode, offerDiscount, offerExpires, offerEnabled]);

  function loadTemplate(t: CampaignTemplateRow) {
    setName(t.name);
    setSubject(t.subject);
    setBodyHtml(t.body_html);
    setBodyText(t.body_text ?? "");
    if (t.category === "offer") setOfferEnabled(true);
    setBodyMode("preview");
    toast.success(`Loaded template: ${t.name}`);
  }

  async function runAi() {
    if (!aiPrompt.trim()) {
      toast.error("Tell the AI what you want — e.g., 'Diwali offer for SMBs, 20% off Workspace Starter'");
      return;
    }
    setAiRunning(true);
    try {
      const res = await fetch("/api/campaigns/ai-generate", {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt:       aiPrompt.trim(),
          category:     aiCategory,
          includeOffer: offerEnabled,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "AI generation failed");
        return;
      }
      setName(json.name);
      setSubject(json.subject);
      setBodyHtml(json.body_html);
      setBodyText(json.body_text);
      setBodyMode("preview");
      // AI generated fresh content — no template is loaded anymore.
      setSelectedTemplateId("");
      setAiOpen(false);
      setAiPrompt("");
      toast.success(
        json.mode === "gemini"
          ? "AI draft ready — review + tweak before sending"
          : "Stub draft created — add a Gemini key in Settings → Integrations for real AI",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setAiRunning(false);
    }
  }

  function toggleStage(id: string) {
    setStages((cur) => cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id]);
  }

  async function onSubmit() {
    if (!name.trim() || !subject.trim() || (!bodyText.trim() && !bodyHtml.trim())) {
      toast.error("Name, subject and a body (text or HTML) are required");
      return;
    }
    if (!hasPreset && stages.length === 0) { toast.error("Pick at least one stage"); return; }
    if (recipientCount === 0) { toast.error(hasPreset ? "No selected contacts have a valid email" : "No leads match — adjust filter"); return; }
    if (offerEnabled && (!offerCode.trim() || !offerDiscount || !offerExpires)) {
      toast.error("Offer code, discount % and expiry are required when offer is on");
      return;
    }

    setSubmitting(true);
    try {
      // If we have HTML but no plain text, derive a quick plain version
      const fallbackText = bodyText.trim() || bodyHtml.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

      const res = await fetch("/api/campaigns/send", {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name:      name.trim(),
          subject:   subject.trim(),
          body:      fallbackText,
          body_html: bodyHtml.trim() || undefined,
          audience:  hasPreset ? {} : { stages, search: search.trim() || undefined },
          recipients: hasPreset ? presetRecipients : undefined,
          offer:     offerEnabled ? {
            code:         offerCode.trim(),
            discount_pct: Number(offerDiscount) || 0,
            expires_at:   offerExpires,
          } : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not send");
        return;
      }
      const modeNote = json.mode === "stub" ? " (stub mode)" : "";
      toast.success(
        `${json.campaignId} sent · ${json.sentCount}/${json.recipientsCount} delivered${
          json.failedCount > 0 ? ` · ${json.failedCount} failed` : ""
        }${modeNote}`
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-4xl">
        <DialogHeader>
          <DialogTitle>Send campaign</DialogTitle>
          <DialogDescription>
            Bulk email to leads. Per-recipient personalization is automatic — use{" "}
            <code className="text-amber-ink">{`{{name}}`}</code> /{" "}
            <code className="text-amber-ink">{`{{company}}`}</code> in subject/body.
          </DialogDescription>
        </DialogHeader>

        {/* Top row: Template picker + AI button */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2 items-end">
          <div>
            <Label>Start from a template</Label>
            <select
              value={selectedTemplateId}
              onChange={(e) => {
                const id = e.target.value;
                setSelectedTemplateId(id);
                // Empty id means "— Pick a template —" picked back. We don't
                // wipe the form fields on this — the user might want to keep
                // their edits and just dismiss the "loaded from" label.
                if (!id) return;
                const t = (templatesQ.data ?? []).find((x) => x.id === id);
                if (t) loadTemplate(t);
              }}
              className="w-full text-sm bg-paper border border-hairline rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber"
            >
              <option value="">— Pick a template —</option>
              <optgroup label="System templates">
                {(templatesQ.data ?? []).filter((t) => t.is_system).map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.category})</option>
                ))}
              </optgroup>
              {(templatesQ.data ?? []).some((t) => !t.is_system) && (
                <optgroup label="Your saved templates">
                  {(templatesQ.data ?? []).filter((t) => !t.is_system).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>
          <Button variant="primary" icon="sparkles" onClick={() => setAiOpen((v) => !v)}>
            ✨ Generate with AI
          </Button>
        </div>

        {/* AI prompt strip */}
        {aiOpen && (
          <div className="border border-amber/40 bg-amber-soft/40 rounded-md p-3 space-y-2">
            <p className="text-xs font-semibold text-amber-ink">Tell the AI what you want</p>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-2">
              <Input
                placeholder="e.g., Diwali special — 25% off Workspace Standard for SMBs, expiry 5 Nov"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
              />
              <select
                value={aiCategory}
                onChange={(e) => setAiCategory(e.target.value as typeof aiCategory)}
                className="text-sm bg-paper border border-hairline rounded px-3 py-2 focus:outline-none focus:ring-1 focus:ring-amber"
              >
                <option value="newsletter">Newsletter</option>
                <option value="offer">Offer</option>
                <option value="winback">Win-back</option>
                <option value="onboarding">Onboarding</option>
                <option value="custom">Custom</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAiOpen(false)} disabled={aiRunning}>Cancel</Button>
              <Button size="sm" variant="primary" icon="sparkles" onClick={runAi} disabled={aiRunning || !aiPrompt.trim()}>
                {aiRunning ? "Drafting…" : "Generate"}
              </Button>
            </div>
            <p className="text-[10px] text-ink-3">
              Powered by Gemini. The AI returns HTML + text + subject. You can edit anything before sending.
            </p>
          </div>
        )}

        {/* Audience */}
        {hasPreset ? (
          <div className="border-t border-hairline pt-3">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Audience — selected contacts</p>
              <Badge kind="info" dot>Sending to {recipientCount} selected contact{recipientCount === 1 ? "" : "s"}</Badge>
            </div>
            <p className="text-[11px] text-ink-3 mt-1.5">
              You hand-picked these on the Contacts page.
              {typeof totalSelected === "number" && totalSelected > recipientCount ? (
                <> <b className="text-amber-ink">{totalSelected - recipientCount} of your {totalSelected} skipped</b> — no email address (reach them via WhatsApp/phone).</>
              ) : (
                <> Contacts without a valid email are skipped automatically.</>
              )}
            </p>
          </div>
        ) : (
          <div className="border-t border-hairline pt-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Audience — pick stages</p>
              <Badge kind={recipientCount > 0 ? "info" : "muted"} dot>
                {recipientsQuery.isLoading ? "counting…" : `Sending to ${recipientCount} lead${recipientCount === 1 ? "" : "s"}`}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {STAGE_OPTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleStage(s.id)}
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-full border transition-colors",
                    stages.includes(s.id)
                      ? "border-amber bg-amber-soft text-amber-ink"
                      : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <Input
              placeholder="Optional: filter by company or contact name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="text-sm"
            />
          </div>
        )}

        {/* Compose */}
        <div className="border-t border-hairline pt-3 space-y-2">
          <div>
            <Label>Campaign name (internal)</Label>
            <Input placeholder="e.g. May month-end sale" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Subject *</Label>
            <Input placeholder="🎉 Special offer for {{company}}" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>

          {/* Body mode toggle */}
          <div className="flex items-center justify-between">
            <Label>Body</Label>
            <div className="inline-flex gap-1 bg-paper-2 rounded-md p-0.5">
              {(["preview","html","text"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setBodyMode(m)}
                  className={cn(
                    "px-2.5 py-0.5 text-[11px] font-medium rounded transition-colors",
                    bodyMode === m ? "bg-paper text-ink shadow-sm" : "text-ink-3 hover:text-ink",
                  )}
                >
                  {m === "preview" ? "Preview" : m === "html" ? "HTML source" : "Plain text"}
                </button>
              ))}
            </div>
          </div>

          {bodyMode === "preview" && (
            previewHtml ? (
              <div className="border border-hairline rounded-md overflow-hidden bg-paper-2">
                <iframe
                  srcDoc={previewHtml}
                  className="w-full h-[380px] bg-white"
                  sandbox=""
                  title="Email preview"
                />
                <p className="text-[10px] text-ink-3 px-3 py-1.5 border-t border-hairline">
                  Live preview · sample vars filled (name=Ramesh, company=Acme)
                </p>
              </div>
            ) : (
              <div className="border border-dashed border-hairline rounded-md p-6 text-center text-xs text-ink-3 bg-paper-2/30">
                No HTML body yet. Switch to <b>HTML source</b> to write, or use a template / AI.
              </div>
            )
          )}

          {bodyMode === "html" && (
            <textarea
              rows={14}
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              placeholder='<!DOCTYPE html>\n<html><body>...{{name}}...</body></html>'
              className="w-full text-xs bg-paper border border-hairline rounded px-3 py-2 resize-y font-mono focus:outline-none focus:ring-1 focus:ring-amber"
            />
          )}

          {bodyMode === "text" && (
            <textarea
              rows={10}
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              placeholder="Hi {{name}}, ..."
              className="w-full text-sm bg-paper border border-hairline rounded px-3 py-2 resize-y focus:outline-none focus:ring-1 focus:ring-amber"
            />
          )}

          <p className="text-[10px] text-ink-3">
            Variables: <code>{`{{name}}`}</code> · <code>{`{{company}}`}</code> · <code>{`{{sender}}`}</code>
            {offerEnabled && (
              <> · <code>{`{{offer_code}}`}</code> · <code>{`{{discount}}`}</code> · <code>{`{{expires}}`}</code></>
            )}
            {bodyHtml && !bodyText && (
              <span className="ml-2 text-amber-ink">· Plain-text fallback auto-derived from HTML</span>
            )}
          </p>
        </div>

        {/* Offer block */}
        <div className="border-t border-hairline pt-3">
          <label className="flex items-center gap-2 mb-2 cursor-pointer">
            <input
              type="checkbox"
              checked={offerEnabled}
              onChange={(e) => setOfferEnabled(e.target.checked)}
              className="accent-amber"
            />
            <span className="text-sm font-medium text-ink">Attach a time-bound offer</span>
            <span className="text-[11px] text-ink-3">(month-end sale / discount code / etc.)</span>
          </label>
          {offerEnabled && (
            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label>Promo code *</Label>
                <Input
                  value={offerCode}
                  onChange={(e) => setOfferCode(e.target.value.toUpperCase())}
                  placeholder="e.g. MAY25"
                  className={cn("font-mono", !offerCode.trim() && "border-amber/60")}
                />
                {!offerCode.trim() && (
                  <p className="mt-1 text-[10px] text-amber-ink">Type your code — this shows in the email as {`{{offer_code}}`}.</p>
                )}
              </div>
              <div>
                <Label>Discount %</Label>
                <Input type="number" min={0} max={100} value={offerDiscount} onChange={(e) => setOfferDiscount(e.target.value)} className="font-mono" />
              </div>
              <div>
                <Label>Expires on</Label>
                <Input type="date" value={offerExpires} onChange={(e) => setOfferExpires(e.target.value)} />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button
            variant="primary"
            icon="send"
            onClick={onSubmit}
            disabled={submitting || recipientCount === 0}
          >
            {submitting ? "Sending…" : `Send to ${recipientCount} ${hasPreset ? "contact" : "lead"}${recipientCount === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
