/**
 * AI Entry — paste anything or add a photo/PDF; review what the AI read; save (2 Oct 2026).
 * Nothing is written until a person presses Save on a card. See lib/ai/data-entry.ts and
 * lib/compliance/entry-rules.ts.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/ui/icon";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { istToday } from "@/lib/dates/ist";
import { EntryCard } from "@/components/features/ai-entry/entry-card";
import type { ProposalWithMatches } from "@/app/api/ai/data-entry/route";
import type { AiLawNote } from "@/lib/ai/data-entry";

const EXAMPLES = [
  "Sharma Traders se Ramesh ji ka call aaya, 15 seat Google Workspace chahiye, number 98765 43210. Kal 11 baje call karna.",
  "Paid ₹12,500 cash to Gupta Electricals for office AC repair today",
  "Muskaan Dentals ne ₹31,053 UPI se bheja, UTR 4271839XXXX",
];

const MAX_FILE = 6 * 1024 * 1024;

export default function AiEntryPage() {
  const { data: me } = useCurrentUser();
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ entries: ProposalWithMatches[]; notes: AiLawNote[]; mode: string } | null>(null);
  const [gone, setGone] = React.useState<Set<number>>(new Set());
  const today = istToday();

  const read = async () => {
    if (!text.trim() && !file) { toast.error("Nothing to read yet", { description: "Paste a chat, note or email in the box, or add a photo / PDF, then press Read it." }); return; }
    if (file && file.size > MAX_FILE) { toast.error("That file is over 6 MB", { description: "Take a smaller photo, or save just the page you need as a PDF, and add it again." }); return; }
    setBusy(true);
    setResult(null);
    setGone(new Set());
    try {
      const body: Record<string, string> = {};
      if (text.trim()) body.text = text.trim();
      if (file) {
        const buf = new Uint8Array(await file.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        body.fileBase64 = btoa(bin);
        body.mimeType = file.type || "application/octet-stream";
      }
      const res = await fetch("/api/ai/data-entry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { toast.error("Could not read that", { description: data.error ?? "Try again, or type the details in the box." }); return; }
      setResult(data);
      if (data.entries.length === 0) toast.message("Nothing to enter was found in that.");
    } catch {
      toast.error("Could not reach the AI", { description: "Check the internet connection and press Read it again — nothing was saved." });
    } finally {
      setBusy(false);
    }
  };

  const us = { stateCode: me?.tenantStateCode ?? null, gstin: me?.tenantGstin ?? null };
  const visible = result?.entries.map((e, i) => ({ e, i })).filter(({ i }) => !gone.has(i)) ?? [];

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[960px] mx-auto space-y-5">
      <div>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">AI</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">AI Entry</h1>
        <p className="text-sm text-ink-3 mt-1">
          Paste a WhatsApp chat, an email or a note — or add a bill, receipt or visiting card. Check what it read, then save.
          It checks GST, TDS and cash rules as you go. Nothing is saved until you press Save.
        </p>
      </div>

      <div className="rounded-lg border border-hairline bg-paper p-4 space-y-3">
        <Textarea
          aria-label="What to enter"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Sharma ji ka call aaya, 15 seat chahiye, kal call karna — 98765 43210"
          onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") read(); }}
        />
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <label className="inline-flex items-center gap-2 text-sm text-ink-2 cursor-pointer">
            <Icon name="upload" size={14} />
            <span>{file ? file.name : "Add photo / PDF"}</span>
            <input type="file" accept="image/*,application/pdf" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file && <button type="button" onClick={(e) => { e.preventDefault(); setFile(null); }} className="text-2xs text-ink-3 hover:text-ink">remove</button>}
          </label>
          <Button variant="primary" icon="sparkles" onClick={read} loading={busy}>Read it</Button>
        </div>
        {!result && !busy && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            <span className="text-2xs text-ink-3">Try:</span>
            {EXAMPLES.map((x) => (
              <button key={x} type="button" onClick={() => setText(x)} className="rounded-full border border-hairline px-2.5 py-0.5 text-2xs text-ink-2 hover:bg-paper-2 text-left">
                {x.length > 60 ? x.slice(0, 58) + "…" : x}
              </button>
            ))}
          </div>
        )}
      </div>

      {result && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs text-ink-3">
            <span>{result.entries.length === 0 ? "Nothing to enter found." : `${result.entries.length} ${result.entries.length === 1 ? "entry" : "entries"} found`}</span>
            {result.mode === "basic" && <span className="text-amber-ink">Basic read (AI not available) — check every field.</span>}
          </div>

          {result.notes.length > 0 && (
            <div className="rounded-lg border border-indigo/30 bg-indigo/5 px-3 py-2.5 text-xs">
              <div className="font-semibold text-indigo-ink mb-1">AI notes — check with your CA</div>
              <ul className="space-y-1 text-ink-2">
                {result.notes.map((n, i) => <li key={i}><b>{n.law}:</b> {n.note}</li>)}
              </ul>
            </div>
          )}

          {me && visible.map(({ e, i }) => (
            <EntryCard
              key={i}
              initial={e}
              us={us}
              todayIST={today}
              userId={me.userId}
              role={me.role}
              onDone={(state) => { if (state === "discarded") setGone((g) => new Set(g).add(i)); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
