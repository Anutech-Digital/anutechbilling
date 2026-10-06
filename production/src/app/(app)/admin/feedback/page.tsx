/**
 * /admin/feedback — the triage queue for bug reports the team files with Ctrl+Shift+B.
 *
 * ─── WHAT "RUN AI AUTO-FIX" HONESTLY DOES ───────────────────────────────────
 * It makes sure a directive exists, copies it to the clipboard, and marks the report
 * `agent_queued` with who queued it and when. That is the whole of it.
 *
 * It does NOT edit code, and the button does not pretend to. This app is a Next.js
 * server on Cloud Run; it has no checkout of the repository, no git credentials and no
 * shell, and any design where a web button could rewrite source would be a remote code
 * execution feature with a friendly label. The value here is real but narrower than the
 * name suggests: the hard part of handing work to a coding agent is writing a directive
 * that names the right files and carries the repo's rules, and that is what this
 * generates. The button is the last 5%, not the first 95%.
 *
 * The screen says this in as many words, because a status of "queued" that an owner
 * reads as "being fixed" is worse than no status at all — they would stop chasing it.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDate } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  useFeedbackList,
  useFeedbackCounts,
  usePlatformFeedbackList,
  useTriageFeedback,
  useDispatchFeedback,
  useUpdateFeedbackStatus,
  useMarkFeedbackChecked,
  useUnmarkFeedbackChecked,
  feedbackScreenshotUrl,
  type FeedbackWithShots,
  type FeedbackStatus,
} from "@/lib/queries/feedback";

const STATUS_TABS: { id: string; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "agent_queued", label: "Queued for agent" },
  { id: "fixed", label: "Fixed" },
  { id: "all", label: "All" },
];

const TYPE_BADGE: Record<string, { kind: "danger" | "info" | "warning"; label: string }> = {
  bug: { kind: "danger", label: "Bug" },
  feature: { kind: "info", label: "Feature" },
  ui_improvement: { kind: "warning", label: "UI polish" },
};

/** What the buttons on a report do, by status — shown under them. */
const ACTION_HELP: Record<string, string> = {
  open: "Run AI Auto-Fix sends it to the AI worker — it becomes a card on the work board within the hour. Copy Directive gives you the fix instructions to paste into Claude Code yourself. Mark fixed or Won't fix closes it.",
  agent_queued: "Waiting for the AI worker — it becomes a card on the work board within the hour, and the fix is made from there. Reopen takes it back to Open.",
  fixed: "Done, waiting for a browser test? Check in browser copies a prompt — open a new Claude Code session and paste it. It re-tests this screen, marks it ✓ checked here when it works (or fixes it), notes the result on the work board, then archives itself. Saw it working yourself? Press ✓ Mark checked (Undo check takes it back). Reopen sends it back to Open.",
  wont_fix: "Closed without a fix. Reopen if it matters again.",
  duplicate: "Closed as a duplicate of another report. Reopen if it is different.",
};

/** Severity band → colour. Bands, not a gradient: an operator reads three groups, not 100 shades. */
function severityKind(score: number | null): "danger" | "warning" | "muted" {
  if (score === null) return "muted";
  if (score >= 60) return "danger";
  if (score >= 36) return "warning";
  return "muted";
}

/**
 * 6 Oct 2026: "Could not reach the clipboard" on Copy Directive — some browsers and embedded
 * views refuse navigator.clipboard (no permission, not focused). The old textarea +
 * execCommand("copy") path still works in most of them, so try it before giving up; when both
 * fail the caller opens the directive and selects it, so Ctrl+C is all that is left.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Fixed reports (Pardeep, 6 Oct 2026: "copy directive ke jagah check in browser AI instruction
 * do, saath me problem ko thik karne ka instruction bhi"). One prompt to paste into a new
 * Claude Code session: re-run the report in a browser first, and only if it still fails, fix
 * it from the original directive. Nothing is stored — it is built from the row on screen.
 */
function buildCheckPrompt(row: FeedbackWithShots, appUrl: string): string {
  const page = row.route_pattern ?? row.page_path ?? "(page not recorded)";
  const lines = [
    'Ye bug report app me "fixed" mark hai. Pehle browser me jaancho ki sach me theek hua ya nahi; theek na ho to theek karo. (Ye prompt ek NAYE Claude Code session me chalana hai.)',
    "",
    "CLOUD CHECK: ye kaam sirf Pardeep ke computer par chalne wale LOCAL session me ho sakta hai (localhost:3001 aur browser pane wahin hain). Agar tum cloud container me ho (path /home/user/..., localhost:3001 nahi khulta, ya browser pane nahi hai) to kuch mat karo — turant bolo: \"Ye cloud session hai — Claude app me naya session LOCAL chun kar chalaiye.\" Aur ruk jao.",
    "0. FOLDER: agar ye session kisi folder me nahi hai (\"No folder\" / scratch workspace), to sabse pehle change_directory tool se C:\\Users\\mso50\\new-reselleros par jao (owner Allow dabayega), phir aage badho.",
    "Repo: C:\\Users\\mso50\\new-reselleros (app production/ me). AGENTS.md aur production/CLAUDE.md ke niyam maano.",
    "Asli repo SIRF Anutech-Digital/anutechbilling hai (`git remote -v` me jo remote wahan point kare — Pardeep ke computer par `anutech`). Branch manager-pardeep. Abhicode0to1/new-reselleros PUBLIC purana repo hai — wahan kabhi push mat karo; cloud session usi ko clone kiye ho to ruko aur owner ko batao. staging/deploy mat chhuo (staging shaam 5 baje owner ka session karta hai).",
    `App: ${appUrl}${appUrl.includes("localhost") ? "" : " (ya local http://localhost:3001)"}. Jaanch browser pane me dikha kar karo.`,
    "",
    `Report: ${row.title}`,
    `Page: ${page}`,
    `Kya hua tha: ${row.problem_summary || row.title}`,
  ];
  if (row.body) lines.push(`Reporter ne likha:\n${row.body}`);
  lines.push(
    "",
    "1. JAANCH: report ke kadam browser me chalao. Screenshot ke saath batao ki ab kya hota hai.",
    '2. Theek hai → bas batao "✓ browser me theek hai" aur kya dekha. Kuch mat badlo. Phir app me report par "✓ Checked" lagao (token kabhi print mat karo):',
    `   curl -s -X POST -H "Authorization: Bearer $(cat ~/.claude/secrets/agent-queue-token)" -H "content-type: application/json" -d '{"id":"${row.id}"}' ${appUrl}/api/agent/feedback-checked`,
    "   (200 = lag gaya. 401/404/503 = nahi laga — bas nateeja me likh do, owner haath se \"Mark checked\" daba dega.)",
    "3. Bug abhi bhi hai → pehle board par card banao, phir neeche ki directive se theek karo: ek test jo pehle fail ho, fix, poori test suite, local par browser me dikhao, commit me card ka number.",
    "",
    '4. NATEEJA BOARD PAR: kaam ke ant me nateeja "Kaam ki list" board (https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n, collection cards) par likho — theek tha to ek card status "done" aur title "Jaanch: <report>", fix kiya to wahi card review me. Taaki session band hone ke baad bhi nateeja dikhe.',
    '5. SESSION ARCHIVE: board par likhne ke baad ye session archive kar do (mcp__ccd_session_mgmt__archive_session, session_id "self"). Archive, delete nahi. SIRF tab jab ye session ISI prompt se shuru hua ho — agar is session me pehle se koi aur baatcheet/kaam hai (galti se purane session me paste hua), to archive MAT karo, bas nateeja batao.',
    "",
    "Directive (fix ke liye):",
    row.directive || "(directive nahi hai — problem dekh kar khud tay karo)",
  );
  return lines.join("\n");
}

/** Selects an element's text so the user only has to press Ctrl+C. */
function selectText(el: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function ScreenshotThumb({ path, name }: { path: string; name: string | null }) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    feedbackScreenshotUrl(path)
      .then((u) => { if (alive) { if (u) setUrl(u); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [path]);

  if (failed) {
    // Says what is wrong rather than showing a broken image frame.
    return (
      <div className="w-24 h-16 rounded border border-hairline bg-paper-2 flex items-center justify-center text-3xs text-ink-4 text-center px-1">
        Could not load
      </div>
    );
  }
  if (!url) return <Skeleton className="w-24 h-16 rounded" />;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={name ?? "Screenshot"}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name ?? "Reported screen"}
        className="w-24 h-16 object-cover rounded border border-hairline hover:border-primary transition-colors"
      />
    </a>
  );
}

function FeedbackCard({ row, userId, meName }: { row: FeedbackWithShots; userId: string | null; meName: string }) {
  const [open, setOpen] = React.useState(false);
  const directiveRef = React.useRef<HTMLPreElement>(null);
  /* Copy failed: open the details and select the directive, after the panel has rendered. */
  const showForManualCopy = () => {
    setOpen(true);
    setTimeout(() => selectText(directiveRef.current), 50);
  };

  const triage = useTriageFeedback();
  const dispatch = useDispatchFeedback();
  const setStatus = useUpdateFeedbackStatus();
  const markChecked = useMarkFeedbackChecked();
  const unmarkChecked = useUnmarkFeedbackChecked();

  const type = row.inferred_type ?? row.reported_type;
  const badge = TYPE_BADGE[type] ?? TYPE_BADGE.bug;
  const untriaged = row.triage_status !== "triaged" || !row.directive;

  const handleCopy = async () => {
    if (!row.directive) {
      toast.error("There is no directive yet.", { description: "Run triage on this report first." });
      return;
    }
    const ok = await copyToClipboard(row.directive);
    if (ok) toast.success("Directive copied — paste it into Claude Code.");
    else {
      showForManualCopy();
      toast.warning("Browser blocked copying.", { description: "The directive is open and selected below — press Ctrl+C." });
    }
  };

  /* R-188: "I saw it working" — so a second visit does not have to remember. */
  const handleMarkChecked = async () => {
    try {
      await markChecked.mutateAsync({ id: row.id, byName: meName });
      toast.success("Marked as checked.", {
        description: "The report now shows who checked it and when.",
        action: { label: "Undo", onClick: () => void handleUnmarkChecked() },
        duration: 10_000,
      });
    } catch (err) {
      toast.error("Could not mark it checked.", {
        description: `${err instanceof Error ? err.message : "Unknown error"} — reload the page and try again.`,
      });
    }
  };

  const handleUnmarkChecked = async () => {
    try {
      await unmarkChecked.mutateAsync({ id: row.id });
      toast.success("Check removed.", { description: "It shows \"waiting for browser test\" again." });
    } catch (err) {
      toast.error("Could not remove the check.", {
        description: `${err instanceof Error ? err.message : "Unknown error"} — reload the page and try again.`,
      });
    }
  };

  const handleCopyCheck = async () => {
    const ok = await copyToClipboard(buildCheckPrompt(row, window.location.origin));
    if (ok) toast.success("Check + fix prompt copied.", { description: "Open a new Claude Code session and paste it — it checks in a browser, fixes it if still broken, writes the result on the board and archives itself." });
    else toast.warning("Browser blocked copying.", { description: "Press Copy again, or ask Claude in chat to check this report." });
  };

  const handleRunTriage = async () => {
    try {
      const { mode } = await triage.mutateAsync(row.id);
      toast.success(
        mode === "gemini" ? "Triaged with Gemini." : "Triaged with the built-in engine.",
        { description: mode === "stub" ? "No Gemini key is configured, so the deterministic engine ran." : undefined },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Triage failed.");
    }
  };

  /**
   * The 1-click path: make sure a directive exists, put it on the clipboard, and record
   * that it was handed out. Deliberately does not claim a fix is underway.
   */
  const handleAutoFix = async () => {
    try {
      if (untriaged) await triage.mutateAsync(row.id);

      // Re-read from the row we have; after a triage the list refetches, but the copy
      // must not depend on that race. Fall back to triggering a copy of what we hold.
      const directive = row.directive;
      const copied = directive ? await copyToClipboard(directive) : false;

      await dispatch.mutateAsync({ id: row.id, userId });

      /* Says where the report went: it leaves the Open tab, and on 5 Oct three reports
         "vanished" for the person who pressed it. */
      if (!copied && directive) showForManualCopy();
      toast.success(copied ? "Moved to Queued for agent — directive copied." : "Moved to Queued for agent.", {
        description: copied
          ? "Not fixed yet: paste it into Claude Code to make the fix. The report waits in the Queued for agent tab."
          : "Not fixed yet. The browser blocked copying — the AI worker will still put it on the board within the hour.",
        duration: 10_000,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not queue this report.");
    }
  };

  const handleStatus = async (status: FeedbackStatus) => {
    try {
      await setStatus.mutateAsync({ id: row.id, status });
      toast.success(status === "fixed" ? "Marked fixed." : status === "wont_fix" ? "Marked won't fix." : "Reopened.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the status.");
    }
  };

  const busy = triage.isPending || dispatch.isPending || setStatus.isPending || markChecked.isPending || unmarkChecked.isPending;

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div
          className="flex-shrink-0 w-11 h-11 rounded-lg bg-paper-2 border border-hairline flex flex-col items-center justify-center"
          title={row.severity_score === null ? "Not triaged yet" : `Severity ${row.severity_score} of 100`}
        >
          <span className="text-sm font-bold leading-none text-ink">{row.severity_score ?? "—"}</span>
          <span className="text-3xs uppercase tracking-wide text-ink-4 mt-0.5">sev</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge kind={badge.kind} size="sm">{badge.label}</Badge>
            {row.inferred_type && row.inferred_type !== row.reported_type && (
              <Badge kind="outline" size="sm" title={`The reporter filed this as "${row.reported_type}"`}>
                filed as {row.reported_type}
              </Badge>
            )}
            <Badge kind={severityKind(row.severity_score)} size="sm">
              {row.reported_severity}
            </Badge>
            {row.triage_mode && (
              <Badge kind="muted" size="sm" title={row.triage_mode === "stub" ? "No Gemini key configured — the built-in engine ran" : "Triaged by Gemini"}>
                {row.triage_mode}
              </Badge>
            )}
            {row.status === "agent_queued" && <Badge kind="info" size="sm">queued for agent</Badge>}
            {row.status === "fixed" && <Badge kind="success" size="sm">fixed</Badge>}
            {row.status === "fixed" && (row.checked_at
              ? <Badge kind="success" size="sm">✓ checked {formatDate(row.checked_at)}{row.checked_by_name ? ` · ${row.checked_by_name}` : ""}</Badge>
              : <Badge kind="warning" size="sm">done · waiting for browser test</Badge>)}
            {row.status === "wont_fix" && <Badge kind="muted" size="sm">won&apos;t fix</Badge>}
          </div>

          <p className="mt-1.5 text-sm font-medium text-ink">
            {row.problem_summary || row.title}
          </p>

          <p className="mt-1 text-xs text-ink-3 flex items-center gap-2 flex-wrap">
            <span className="font-mono">{row.route_pattern ?? row.page_path ?? "screen unknown"}</span>
            <span className="text-ink-4">·</span>
            <span>{row.reporter_name ?? "Unknown reporter"}</span>
            {row.filed_via === "ai-chat" && <Badge kind="info" size="sm">🤖 AI-drafted after chat</Badge>}
            <span className="text-ink-4">·</span>
            <span>{formatDate(row.created_at)}</span>
            {row.status === "fixed" && row.resolved_at && (
              <>
                <span className="text-ink-4">·</span>
                <span className="text-emerald">fixed {formatDate(row.resolved_at)}</span>
              </>
            )}
            {row.screenshots.length > 0 && (
              <>
                <span className="text-ink-4">·</span>
                <span className="inline-flex items-center gap-1"><Icon name="camera" size={12} />{row.screenshots.length}</span>
              </>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-shrink-0 text-xs font-medium text-ink-3 hover:text-ink inline-flex items-center gap-1"
          aria-expanded={open}
        >
          {open ? "Hide" : "Details"}
          <Icon name={open ? "chevron_up" : "chevron_down"} size={14} />
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {/* 6 Oct 2026 (Pardeep, Fixed tab): Auto-Fix on a fixed / won't-fix / already queued
            report only re-queued it. It is for open reports; Reopen first to send one again. */}
        {row.status === "open" && (
          <Button variant="primary" size="sm" onClick={handleAutoFix} disabled={busy} title="Send to the AI worker — it becomes a card on the work board within the hour">
            <Icon name="sparkles" size={14} className="mr-1.5" />
            Run AI Auto-Fix
          </Button>
        )}
        {row.status === "fixed" ? (
          <Button size="sm" variant="outline" onClick={handleCopyCheck} disabled={busy} title="Copies a prompt: re-test this in a browser, fix it if still broken">
            <Icon name="copy" size={14} className="mr-1.5" />
            Check in browser
          </Button>
        ) : null}
        {row.status === "fixed" && !row.checked_at ? (
          <Button size="sm" variant="ghost" onClick={handleMarkChecked} disabled={busy} title="You saw it working — mark it so you do not check it again">
            ✓ Mark checked
          </Button>
        ) : null}
        {row.status === "fixed" && row.checked_at ? (
          <Button size="sm" variant="ghost" onClick={handleUnmarkChecked} disabled={busy} title="Pressed by mistake? Take the check back">
            Undo check
          </Button>
        ) : null}
        {row.status === "fixed" ? null : (
          <Button size="sm" variant="outline" onClick={handleCopy} disabled={busy || !row.directive} title="Copies the fix instructions to paste into Claude Code yourself">
            <Icon name="copy" size={14} className="mr-1.5" />
            Copy Directive
          </Button>
        )}
        {(row.status === "open" || row.status === "agent_queued") && (
          <Button size="sm" variant="ghost" onClick={handleRunTriage} disabled={busy}>
            <Icon name="refresh" size={14} className="mr-1.5" />
            {untriaged ? "Triage" : "Re-triage"}
          </Button>
        )}
        <span className="flex-1" />
        {row.status !== "fixed" && (
          <Button size="sm" variant="ghost" onClick={() => handleStatus("fixed")} disabled={busy}>
            Mark fixed
          </Button>
        )}
        {/* Offered from EVERY non-open state, not just "fixed". A report that was queued
            for an agent which then failed, stalled, or was never actually run has to be
            able to come back — otherwise the only exits from `agent_queued` are "fixed"
            and "won't fix", and somebody eventually picks one of those to clear the row.
            A queue you can only leave by lying about the outcome stops being a queue. */}
        {row.status !== "open" && (
          <Button size="sm" variant="ghost" onClick={() => handleStatus("open")} disabled={busy} title="Send it back to Open">
            Reopen
          </Button>
        )}
        {row.status !== "wont_fix" && (
          <Button size="sm" variant="ghost" onClick={() => handleStatus("wont_fix")} disabled={busy} title="Close it without a fix">
            Won&apos;t fix
          </Button>
        )}
      </div>

      {/* Pardeep, 6 Oct 2026: "isko aur badiya informatic banao jisse user ko sab kuch clear ho
          sake wo kya kar sakta hai" — one line per state saying what the buttons do. */}
      <p className="flex gap-1.5 text-xs text-ink-3 leading-relaxed">
        <Icon name="info" size={13} className="flex-shrink-0 mt-0.5" />
        <span>{ACTION_HELP[row.status] ?? ""}</span>
      </p>

      {open && (
        <div className="pt-3 border-t border-hairline space-y-4">
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">{row.filed_via === "ai-chat" ? "What the AI wrote (after the chat), filed by the reporter" : "What the reporter wrote"}</h4>
            {row.filed_via === "ai-chat" && row.ai_chat_summary && (
              <p className="text-xs text-ink-2 mb-1.5"><b>Chat:</b> {row.ai_chat_summary}</p>
            )}
            <pre className="text-xs text-ink whitespace-pre-wrap font-mono bg-paper-2 border border-hairline rounded-md p-3 max-h-56 overflow-y-auto">
              {row.body}
            </pre>
          </div>

          {row.screenshots.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">Screenshots</h4>
              <div className="flex gap-2 flex-wrap">
                {row.screenshots.map((s) => (
                  <ScreenshotThumb key={s.id} path={s.file_path} name={s.file_name} />
                ))}
              </div>
            </div>
          )}

          {row.triage_notes.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">What the triage noticed</h4>
              <ul className="space-y-1">
                {row.triage_notes.map((n, i) => (
                  <li key={i} className="text-xs text-ink-2 flex gap-2">
                    <span className="text-ink-4 flex-shrink-0">•</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {row.target_files.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">Target files</h4>
              <ul className="space-y-0.5">
                {row.target_files.map((f) => (
                  <li key={f} className="text-xs font-mono text-ink-2">{f}</li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3">AI agent directive</h4>
              {row.directive && (
                <button type="button" onClick={handleCopy} className="text-xs font-medium text-primary hover:underline">
                  Copy
                </button>
              )}
            </div>
            {row.directive ? (
              <pre ref={directiveRef} className="text-2xs leading-relaxed text-ink whitespace-pre-wrap font-mono bg-paper-2 border border-hairline rounded-md p-3 max-h-96 overflow-y-auto">
                {row.directive}
              </pre>
            ) : (
              <p className="text-xs text-ink-3">
                No directive yet — press <b>Triage</b> above to generate one.
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function AdminFeedbackPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const [tab, setTab] = React.useState("open");

  const filter = tab === "all" ? {} : { status: tab as FeedbackStatus };
  const { data, isLoading, error } = useFeedbackList(filter);
  const { data: counts } = useFeedbackCounts();

  /* ── Every workspace, for the platform owner ───────────────────────────────
     A tester with his own tenant filed a bug on 22 Aug and nobody could read it:
     feedback is RLS-scoped to the signed-in workspace, so this page could only ever
     show ANUTECH's own reports. Reporting worked, reading did not.

     The flag here only decides whether the toggle is DRAWN. The route re-checks the
     authenticated email against the same founder allowlist before it touches the
     service role, so flipping this in a browser gets you a 403 and nothing else. */
  const [scope, setScope] = React.useState<"mine" | "all">("mine");
  const platform = usePlatformFeedbackList(Boolean(me?.isPlatformAdmin) && scope === "all");

  const rows = data ?? [];
  const untriagedCount = rows.filter((r) => r.triage_status !== "triaged").length;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-5">
      <div>
        <h1 className="text-2xl md:text-3xl font-serif text-ink">Feedback &amp; AI Fixes</h1>
        <p className="text-sm text-ink-3 mt-1">
          Every bug report and idea the team files with <kbd className="px-1 py-0.5 rounded bg-paper-2 border border-hairline font-mono text-2xs">Ctrl</kbd>{" "}
          <kbd className="px-1 py-0.5 rounded bg-paper-2 border border-hairline font-mono text-2xs">Shift</kbd>{" "}
          <kbd className="px-1 py-0.5 rounded bg-paper-2 border border-hairline font-mono text-2xs">B</kbd>, triaged and turned into a directive for a coding agent.
        </p>
      </div>

      {/* Only the platform owner sees this. Everyone else gets the page exactly as before. */}
      {me?.isPlatformAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          {(["mine", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={
                "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors " +
                (scope === s
                  ? "border-amber bg-amber-soft text-amber-ink"
                  : "border-hairline text-ink-2 hover:bg-paper-2")
              }
            >
              {s === "mine" ? "This workspace" : "All workspaces"}
            </button>
          ))}
          <span className="text-2xs text-ink-3">
            Testers on their own workspace file reports here too — they are invisible on
            &ldquo;This workspace&rdquo;.
          </span>
        </div>
      )}

      {scope === "all" && me?.isPlatformAdmin && (
        <PlatformFeedbackList
          rows={platform.data ?? []}
          isLoading={platform.isLoading}
          error={platform.error as Error | null}
        />
      )}

      {/* Said once, at the top, rather than left for someone to infer from a status chip. */}
      <div className="rounded-lg border border-hairline bg-paper-2 p-3 flex gap-2.5">
        <Icon name="info" size={16} className="text-ink-3 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-ink-2 leading-relaxed">
          <b>Run AI Auto-Fix</b> writes the directive, copies it to your clipboard and marks the report queued.
          It does <b>not</b> change any code by itself — this app runs on a server with no access to the
          repository. The AI worker picks up queued reports within the hour and puts each one on the
          work board as a card; the fix is made from there. You can also paste the directive into
          Claude Code yourself.
        </p>
      </div>

      <TabBar
        value={tab}
        onChange={setTab}
        items={STATUS_TABS.map((t) => ({
          ...t,
          count: t.id === tab ? rows.length : counts?.[t.id],
        }))}
      />

      {untriagedCount > 0 && (
        <p className="text-xs text-amber-ink bg-amber-soft border border-amber/30 rounded-md px-3 py-2">
          {untriagedCount} report(s) in this view have no directive yet. Press <b>Triage</b> on each, or{" "}
          <b>Run AI Auto-Fix</b>, which triages first.
        </p>
      )}

      {(isLoading || meLoading) && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-lg" />)}
        </div>
      )}

      {error && (
        <Card className="p-6">
          <EmptyState
            icon="alert"
            title="Could not load the feedback queue"
            body={
              <>
                {error instanceof Error ? error.message : "Unknown error."}
                <br />
                If this says the table does not exist, migration{" "}
                <code className="font-mono text-2xs">20260819120000_feedback_triage</code> has not been applied yet.
              </>
            }
          />
        </Card>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <Card className="p-6">
          <EmptyState
            icon="bug"
            title={tab === "open" ? "Nothing open" : "Nothing here"}
            body={
              tab === "open"
                ? "No open reports. Anyone on the team can file one from any screen with Ctrl + Shift + B."
                : "No reports with this status."
            }
          />
        </Card>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((row) => (
            <FeedbackCard key={row.id} row={row} userId={me?.userId ?? null} meName={me?.fullName ?? "Owner"} />
          ))}
        </div>
      )}
    </div>
  );
}


/**
 * Other workspaces' reports — READ ONLY, and it says so.
 *
 * Every mutation on this page (triage, auto-fix, mark fixed) goes through the browser
 * client, so RLS would refuse a row belonging to another tenant. Rather than render
 * buttons that fail, this list offers the two things that genuinely work across a tenant
 * boundary: reading the report, and copying the directive that was already generated for
 * it. Showing an action that cannot succeed is worse than not showing it.
 */
function PlatformFeedbackList({
  rows, isLoading, error,
}: {
  rows: import("@/lib/queries/feedback").PlatformFeedbackRow[];
  isLoading: boolean;
  error: Error | null;
}) {
  if (isLoading) return <Card className="p-4 text-[13px] text-ink-3">Loading every workspace…</Card>;

  /* An error must not read as "no reports". */
  if (error) {
    return (
      <Card className="p-4 text-[13px] text-ink-2">
        <b className="text-ink">Could not load other workspaces.</b> {error.message}
      </Card>
    );
  }

  const others = rows.filter((r) => !r.isOwnWorkspace);
  if (others.length === 0) {
    return (
      <Card className="p-4 text-[13px] text-ink-2">
        No reports from other workspaces yet.
      </Card>
    );
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-hairline bg-paper-2/50">
        <p className="text-[12px] text-ink-2">
          <b className="text-ink">{others.length} report{others.length === 1 ? "" : "s"} from other workspaces.</b>{" "}
          Read-only here — triage and Auto-Fix act on your own workspace, so those buttons
          would fail on these rows rather than do nothing.
        </p>
      </div>
      <ul className="divide-y divide-hairline">
        {others.map((r) => (
          <li key={r.id} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="rounded bg-paper-2 border border-hairline px-1.5 py-0.5 text-3xs font-medium text-ink-2">
                {r.tenantName}
              </span>
              <span className="text-[13px] font-medium text-ink">{r.title ?? "(no title)"}</span>
              {r.severity_score != null && (
                <span className="text-2xs text-ink-3 tabular-nums">{r.severity_score}/100</span>
              )}
            </div>
            <p className="mt-1 text-[12px] text-ink-2 leading-snug">{r.body}</p>
            <p className="mt-1 text-2xs text-ink-3">
              {r.reporter_name ?? "someone"} &middot; {r.reporter_email ?? "no email"}
              {r.filed_via === "ai-chat" ? " · 🤖 AI-drafted after chat" : ""}
              {r.page_path ? ` · ${r.page_path}` : ""} &middot; {new Date(r.created_at).toLocaleString("en-IN")}
            </p>
            {r.screenshots.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {r.screenshots.map((sh) =>
                  sh.url ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <a key={sh.id} href={sh.url} target="_blank" rel="noopener noreferrer">
                      <img src={sh.url} alt={sh.fileName} className="h-20 rounded border border-hairline" />
                    </a>
                  ) : (
                    <span key={sh.id} className="text-2xs text-ink-3">
                      {sh.fileName} — could not be loaded
                    </span>
                  ),
                )}
              </div>
            )}
            {r.directive && (
              <button
                type="button"
                onClick={async () => {
                  if (await copyToClipboard(r.directive!)) toast.success("Directive copied — paste it into Claude Code.");
                  else toast.warning("Browser blocked copying.", { description: "Select the directive text and press Ctrl+C." });
                }}
                className="mt-2 rounded border border-hairline px-2 py-0.5 text-2xs text-ink-2 hover:bg-paper-2"
              >
                Copy directive
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
