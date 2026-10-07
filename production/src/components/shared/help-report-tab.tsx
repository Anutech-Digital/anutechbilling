"use client";

/**
 * R-383 (7 Oct 2026) — the "Report a problem" tab of the one Help panel.
 *
 * Replaces the separate header "Report Bug" button: one text box, an optional screenshot, and
 * the page, the last recorded steps and the API/console errors (the AI Help trail, R-162)
 * attached on their own. If AI is available, "Write it up with AI" turns the words (or, with an
 * empty box, the caught error) into a draft the person edits. If AI is NOT available — no key,
 * a failed call, no network — nothing changes: the plain text still submits. Reporting is never
 * blocked on AI.
 *
 * Submit goes through the SAME path as the old dialog: useSubmitFeedback (insert into
 * `feedback`, screenshots, then /api/feedback/triage, which auto-sends to the AI queue — R-357).
 * Same payload keys as FeedbackDialog; no new table, no new route.
 */
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { describeError } from "@/lib/errors/toast-error";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useSubmitFeedback } from "@/lib/queries/feedback";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { trailForPrompt, type TrailEvent } from "@/lib/ai/test-trail";
import type { BugDraft } from "@/lib/ai/app-help";
import type { FeedbackSeverity, FeedbackType } from "@/lib/feedback/triage";
import { CropOverlay, captureViewport, toShot } from "@/components/shared/help-shot";

/** Recorded steps attached to a report — the same window AI Help sends with a draft. */
const RECORDED_STEPS = 15;
const MAX_SHOTS = 3;

/** The row's text: the person's words first (the first line is the title), then what the app recorded. */
export function reportTextWithContext(typed: string, trail: readonly TrailEvent[], now = Date.now()): string {
  const words = typed.trim();
  if (!trail.length) return words;
  return `${words}\n\nWhat the app recorded (last steps):\n${trailForPrompt(trail.slice(-RECORDED_STEPS), now).slice(0, 2500)}`;
}

/** An AI draft as editable text — title on the first line, like a typed report. */
export function draftToText(d: BugDraft): string {
  const lines = [d.title, "", d.actual];
  if (d.expected) lines.push("", `Expected: ${d.expected}`);
  if (d.steps.length) lines.push("", "Steps:", ...d.steps.map((s, i) => `${i + 1}. ${s}`));
  return lines.join("\n");
}

const KIND_LABEL: Record<FeedbackType, string> = { bug: "Something is broken", feature: "Idea / new feature", ui_improvement: "Looks wrong (UI)" };

interface ReportShot { id: string; name: string; dataUrl: string }

export function HelpReportTab({ pathname, getTrail, caughtError, onCaughtErrorUsed, onFiled }: {
  pathname: string;
  /** The live trail (AI Help's recorder) — read at submit time, never copied into state. */
  getTrail: () => readonly TrailEvent[];
  /** The error that turned the Help button red, if any. */
  caughtError: string | null;
  onCaughtErrorUsed: () => void;
  onFiled: () => void;
}) {
  const { data: currentUser } = useCurrentUser();
  const submit = useSubmitFeedback();
  const [text, setText] = React.useState("");
  const [type, setType] = React.useState<FeedbackType>("bug");
  const [severity, setSeverity] = React.useState<FeedbackSeverity>("medium");
  const [shots, setShots] = React.useState<ReportShot[]>([]);
  const [capturing, setCapturing] = React.useState(false);
  const [cropSrc, setCropSrc] = React.useState<HTMLCanvasElement | null>(null);
  const [drafting, setDrafting] = React.useState(false);
  const boxRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => { const t = setTimeout(() => boxRef.current?.focus(), 50); return () => clearTimeout(t); }, []);

  const addShot = (dataUrl: string, name: string) =>
    setShots((s) => (s.length >= MAX_SHOTS ? s : [...s, { id: crypto.randomUUID(), name, dataUrl }]));

  async function capture() {
    if (capturing) return;
    setCapturing(true);
    const canvas = await captureViewport();
    setCapturing(false);
    if (canvas) setCropSrc(canvas);
    else toast.warning("Could not take a screenshot.", { description: "Paste one with Ctrl+V instead (Win+Shift+S takes one)." });
  }
  async function finishCrop(c: HTMLCanvasElement) {
    setCropSrc(null);
    const s = await toShot(c);
    if (s) addShot(s.dataUrl, `help_report_screen_${shots.length + 1}.jpg`);
    else toast.warning("Screenshot is too large.", { description: "Choose a smaller part." });
  }
  async function addFile(file: File | undefined | null) {
    if (!file || !file.type.startsWith("image/")) return false;
    const s = await toShot(file).catch(() => null);
    if (s) addShot(s.dataUrl, file.name || `pasted_screen_${shots.length + 1}.jpg`);
    else toast.warning("Could not read that image.", { description: "Try another screenshot." });
    return true;
  }
  async function onPaste(e: React.ClipboardEvent) {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    await addFile(file);
  }

  /* Optional. Any failure leaves the box as it was — the plain report still submits. */
  async function draftWithAi() {
    if (drafting) return;
    setDrafting(true);
    const words = text.trim();
    try {
      const res = await fetch("/api/ai/help", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: words ? [{ role: "user", text: `Is problem ki bug report banao: ${words}`.slice(0, 1500) }] : [],
          pagePath: pathname,
          mode: words ? "chat" : "error",
          trail: getTrail(),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { bugDraft?: BugDraft | null };
      if (res.ok && j.bugDraft) {
        setText(draftToText(j.bugDraft));
        setType(j.bugDraft.type);
        setSeverity(j.bugDraft.severity);
        toast.success("Draft ready.", { description: "Read it, change anything, then press Submit." });
      } else {
        toast.warning("AI could not write it up.", { description: "No problem — press Submit and your own words are sent as they are." });
      }
    } catch {
      toast.warning("AI is not reachable right now.", { description: "Press Submit — your own words are sent as they are." });
    } finally {
      setDrafting(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const words = text.trim() || (caughtError ? `Error: ${caughtError}` : "");
    if (!words) {
      toast.error("Report box is empty", { description: "Write what happened and what you expected, then submit." });
      return;
    }
    try {
      /* Same keys as the old Report Bug dialog (FeedbackDialog) — the triage and the AI queue read them unchanged. */
      const result = await submit.mutateAsync({
        tenantId: currentUser?.tenantId ?? "",
        reportedType: type,
        reportedSeverity: severity,
        text: reportTextWithContext(words, getTrail()),
        pagePath: pathname,
        reporterId: currentUser?.userId ?? null,
        reporterName: currentUser?.fullName ?? null,
        reporterEmail: currentUser?.authEmail ?? null,
        screenshots: shots.map((s) => ({ name: s.name, dataUrl: s.dataUrl })),
      });
      if (result.failedUploads.length > 0) {
        toast.warning(`Report saved — but ${result.failedUploads.length} screenshot(s) did not upload.`, {
          description: `Not attached: ${result.failedUploads.join(", ")}. The report itself is safe.`,
          duration: 10_000,
        });
      } else {
        toast.success("Report submitted — thank you.", { description: result.triaged ? "It is now in the triage queue." : "AI triage will run when /admin/feedback is opened." });
      }
      setText(""); setShots([]); setType("bug"); setSeverity("medium");
      if (caughtError) onCaughtErrorUsed();
      onFiled();
    } catch (err: unknown) {
      /* Nothing is cleared: the words stay on screen, so a retry is one click. */
      toast.error(describeError(err, "Could not submit the report.").message, {
        description: "Your report was NOT saved. The text is still here — try again in a moment.",
        duration: 10_000,
      });
    }
  }

  const canSeeAll = currentUser?.role === "owner" || currentUser?.role === "manager";

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex-1 min-h-0 flex flex-col" data-testid="help-report-form">
      {cropSrc && <CropOverlay src={cropSrc} onDone={(c) => void finishCrop(c)} onCancel={() => setCropSrc(null)} />}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {caughtError && (
          <div className="rounded-lg bg-red-50 text-red-900 text-xs px-2.5 py-2 flex items-start gap-2">
            <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0 break-words"><b>Error caught:</b> {caughtError} — it goes with this report.</div>
          </div>
        )}
        <div>
          <label htmlFor="help-report-text" className="block text-xs font-semibold text-ink mb-1">What went wrong?</label>
          <textarea
            id="help-report-text"
            name="help-report-text"
            ref={boxRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => void onPaste(e)}
            rows={6}
            maxLength={4000}
            placeholder="What you did, what happened, what you expected. Paste a screenshot with Ctrl+V."
            className="block w-full resize-y rounded-lg border border-hairline bg-paper px-3 py-2 text-sm text-ink leading-relaxed focus:outline-none focus:ring-2 focus:ring-amber"
          />
        </div>

        {shots.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label={`${shots.length} screenshot(s) attached`}>
            {shots.map((s, i) => (
              <li key={s.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={s.dataUrl} alt={`Screenshot ${i + 1}`} className="w-20 h-16 object-cover rounded-md border border-hairline" />
                <button type="button" aria-label={`Remove screenshot ${i + 1}`} onClick={() => setShots((all) => all.filter((x) => x.id !== s.id))}
                  className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-ink text-paper flex items-center justify-center ring-2 ring-paper hover:bg-rose">
                  <Icon name="x" size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <IconButton type="button" icon="camera" aria-label="Take a screenshot of this page" title="Screenshot this page — or paste one into the box"
            onClick={() => void capture()} disabled={capturing || shots.length >= MAX_SHOTS} />
          <IconButton type="button" icon="upload" aria-label="Attach an image" title="Attach an image"
            onClick={() => fileRef.current?.click()} disabled={shots.length >= MAX_SHOTS} />
          <input ref={fileRef} type="file" accept="image/*" name="help-report-image" aria-label="Attach an image file" className="hidden"
            onChange={(e) => { void addFile(e.target.files?.[0]); e.target.value = ""; }} />
          <label htmlFor="help-report-kind" className="sr-only">Kind of report</label>
          <select id="help-report-kind" name="help-report-kind" value={type} onChange={(e) => setType(e.target.value as FeedbackType)}
            className="h-9 rounded-md border border-hairline bg-paper px-2 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber">
            {(Object.keys(KIND_LABEL) as FeedbackType[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <Button type="button" size="sm" variant="outline" icon="sparkles" loading={drafting} disabled={drafting || submit.isPending}
            onClick={() => void draftWithAi()} title="Optional — AI writes a title and steps from your words and the recorded steps; you edit before sending">
            Write it up with AI
          </Button>
        </div>

        <div className="text-2xs text-ink-3 space-y-0.5" data-testid="help-report-attached">
          <div>Attached on its own: page <span className="font-mono text-ink-2">{pathname}</span>, your last steps and any API/console errors the app recorded.</div>
          <div>Goes to Admin → Feedback in your name ({currentUser?.fullName ?? "—"}); AI triage picks it up from there.</div>
          {canSeeAll && <Link href="/admin/feedback" onClick={onFiled} className="font-semibold text-primary hover:underline">See all reports →</Link>}
        </div>
      </div>

      <div className="border-t border-hairline p-2 flex justify-end gap-2">
        <Button type="submit" size="sm" variant="primary" loading={submit.isPending} disabled={submit.isPending}>Submit report</Button>
      </div>
    </form>
  );
}
