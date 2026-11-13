/**
 * R-2726 — one report on /admin/feedback: a compact one-line row (when, who, workspace, page,
 * title, status, card) that opens to the full report — body, screenshots and the actions.
 *
 * 13 Nov 2026: 290 reports each took a tall card with its whole body, and a real user's
 * report was scrolled past. A closed row is one line; everything that was on the old card
 * (and its buttons) is inside the opened row, unchanged.
 *
 * ─── WHAT "RUN AI AUTO-FIX" HONESTLY DOES ───────────────────────────────────
 * It makes sure a directive exists, copies it to the clipboard, and marks the report
 * `agent_queued` with who queued it and when. It does NOT edit code — this app runs on a
 * server with no checkout of the repository. A status of "queued" must never read as "being
 * fixed", so the opened row says so in words.
 *
 * ─── OTHER WORKSPACES' ROWS ─────────────────────────────────────────────────
 * Every mutation here goes through the browser client, so RLS would refuse a row belonging
 * to another tenant. Rather than render buttons that fail, such a row offers what genuinely
 * works across a tenant boundary: reading it, Copy Directive, Urgent, and (R-366) "Send to
 * AI" — server routes that re-check the platform allowlist.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { formatIstDate, formatIstTime } from "@/lib/dates/ist";
import {
  useTriageFeedback,
  useDispatchFeedback,
  useUpdateFeedbackStatus,
  useMarkFeedbackChecked,
  useUnmarkFeedbackChecked,
  feedbackScreenshotUrl,
  type FeedbackRow,
  type FeedbackStatus,
} from "@/lib/queries/feedback";
import { parseFixedNote } from "@/lib/feedback/fixed-note";
import { STATUS_FILTER_LABEL, statusFilterOf } from "@/lib/feedback/list-filters";
import { isUrgent } from "@/lib/feedback/urgent";
import { buildCheckPrompt, buildFixFooter } from "./feedback-prompts";
import { SendToAiButton } from "./platform-ai";
import { RecheckTypeScore } from "./recheck";
import { UrgentToggle, UrgentStrip, urgentAtOf } from "./urgent-toggle";

/** A screenshot as either list hands it over: a storage path (own workspace) or a signed URL (platform route). */
export type RowScreenshot =
  | { id: string; file_path: string; file_name: string | null }
  | { id: string; fileName: string; url: string | null };

export type FeedbackListRow = FeedbackRow & {
  screenshots: RowScreenshot[];
  /** Set by the platform route only. */
  tenantName?: string;
  isOwnWorkspace?: boolean;
};

const TYPE_BADGE: Record<string, { kind: "danger" | "info" | "warning"; label: string }> = {
  bug: { kind: "danger", label: "Bug" },
  feature: { kind: "info", label: "Feature" },
  ui_improvement: { kind: "warning", label: "UI polish" },
};

const STATUS_KIND: Record<string, "danger" | "info" | "warning" | "success" | "muted"> = {
  open: "warning", queued: "info", ai_working: "info", fixed: "success", wont_fix: "muted", duplicate: "muted",
};

/** What the buttons on a report do, by status — shown under them. */
const ACTION_HELP: Record<string, string> = {
  open: "Run AI Auto-Fix sends it to the AI worker — it becomes a card on the work board (urgent: in a few minutes; others: within 30 min). Copy Directive gives you the fix instructions to paste into Claude Code yourself. Mark fixed or Won't fix closes it.",
  agent_queued: "Waiting for the AI worker — it becomes a card on the work board (urgent: in a few minutes; others: within 30 min), and the fix is made from there. Reopen takes it back to Open.",
  fixed: "Done, waiting for a browser test? Check in browser copies a prompt — open a new Claude Code session and paste it. It re-tests this screen, marks it ✓ checked here when it works (or fixes it), notes the result on the work board, then archives itself. Saw it working yourself? Press ✓ Mark checked (Undo check takes it back). Reopen sends it back to Open.",
  wont_fix: "Closed without a fix. Reopen if it matters again.",
  duplicate: "Closed as a duplicate of another report. Reopen if it is different.",
};
const OTHER_WORKSPACE_HELP =
  "This report belongs to another workspace: you can read it, send it to the AI worker, mark it urgent and copy its directive. Triage and Mark fixed stay with that workspace.";

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

function ScreenshotThumb({ shot }: { shot: RowScreenshot }) {
  const signed = "url" in shot;
  const name = signed ? shot.fileName : shot.file_name;
  const path = signed ? null : shot.file_path;
  const [url, setUrl] = React.useState<string | null>(signed ? shot.url : null);
  const [failed, setFailed] = React.useState(signed && !shot.url);

  React.useEffect(() => {
    if (!path) return;
    let alive = true;
    feedbackScreenshotUrl(path)
      .then((u) => { if (alive) { if (u) setUrl(u); else setFailed(true); } })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [path]);

  if (failed) {
    // Says what is wrong rather than showing a broken image frame.
    return (
      <div className="w-24 h-16 rounded border border-hairline bg-paper-2 flex items-center justify-center text-3xs text-ink-3 text-center px-1">
        Could not load
      </div>
    );
  }
  if (!url) return <Skeleton className="w-24 h-16 rounded" />;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={name ?? "Screenshot"}>
      {/* eslint-disable-next-line @next/next/no-img-element -- next.config images.unoptimized: next/image would serve it unchanged */}
      <img
        src={url}
        alt={name ?? "Reported screen"}
        className="w-24 h-16 object-cover rounded border border-hairline hover:border-primary transition-colors"
      />
    </a>
  );
}

/**
 * R-356: the fixed report's one-line receipt — "Fixed by AI · R-354 · 279cb0d2 · what
 * changed · when" — plus a link to the screen the bug was filed on, so the owner can look.
 */
function AiFixedStrip({ note, resolvedAt, pagePath }: { note: string; resolvedAt: string | null; pagePath: string | null }) {
  const n = parseFixedNote(note);
  const href = pagePath && pagePath.startsWith("/") && !pagePath.startsWith("//") ? pagePath : null;
  return (
    <div data-testid="ai-fixed-strip" className="mt-1 text-xs text-ink-2 bg-emerald-soft/40 border border-emerald/30 rounded-md px-2 py-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="font-semibold text-emerald-ink">🤖 Fixed by AI</span>
      {n.card && <><span aria-hidden className="text-ink-3">·</span><span className="font-mono font-semibold text-ink">{n.card}</span></>}
      {n.commit && <><span aria-hidden className="text-ink-3">·</span><span className="font-mono text-ink-3">{n.commit}</span></>}
      <span aria-hidden className="text-ink-3">·</span>
      <span className="min-w-0 break-words">{n.text}</span>
      {resolvedAt && <><span aria-hidden className="text-ink-3">·</span><span className="text-ink-3" title={formatDate(resolvedAt, "long")}>{formatDate(resolvedAt, "relative")}</span></>}
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" className="ml-auto font-medium text-primary hover:underline inline-flex items-center gap-1">
          Open the page <Icon name="external" size={12} />
        </a>
      )}
    </div>
  );
}

/** The board card of a report: the worker's claim (R-357), else the id in the AI's note. */
export function cardOf(row: Pick<FeedbackRow, "agent_card" | "resolution_note">): string | null {
  return row.agent_card ?? parseFixedNote(row.resolution_note).card;
}

/** "12 Nov, 02:30 pm" in IST — the year only when it is not this one. */
export function whenIst(at: string, now: Date = new Date()): string {
  const date = formatIstDate(at);
  const thisYear = formatIstDate(now).slice(-4);
  return `${date.endsWith(thisYear) ? date.slice(0, -5) : date}, ${formatIstTime(at)}`;
}

export interface FeedbackRowItemProps {
  row: FeedbackListRow;
  userId: string | null;
  meName: string;
  /** Show the workspace column ("All workspaces"). */
  showWorkspace: boolean;
  justFixed?: boolean;
  canUrgent?: boolean;
}

export function FeedbackRowItem({ row, userId, meName, showWorkspace, justFixed = false, canUrgent = false }: FeedbackRowItemProps) {
  const [open, setOpen] = React.useState(false);
  /* Another workspace's report (platform list): RLS refuses writes from here. */
  const foreign = row.isOwnWorkspace === false;
  const tab = statusFilterOf(row);
  const card = cardOf(row);
  const title = row.problem_summary || row.title || "(no title)";
  const page = row.route_pattern ?? row.page_path;
  const panelId = `feedback-panel-${row.id}`;

  return (
    <li
      data-testid={`feedback-card-${row.id}`}
      className={"bg-paper transition-shadow " + (justFixed ? "ring-2 ring-emerald ring-inset" : "")}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="feedback-row"
        className="w-full text-left px-3 py-2 flex items-center gap-x-3 gap-y-1 flex-wrap md:flex-nowrap text-xs hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      >
        <span className="w-[7.5rem] flex-shrink-0 tabular-nums text-ink-2 whitespace-nowrap" title={`${formatIstDate(row.created_at)} ${formatIstTime(row.created_at)} IST`}>
          {whenIst(row.created_at)}
        </span>
        <span className="w-32 flex-shrink-0 truncate text-ink-2" title={[row.reporter_name, row.reporter_email].filter(Boolean).join(" · ") || undefined}>
          {row.reporter_name ?? row.reporter_email ?? "Unknown reporter"}
        </span>
        {showWorkspace && (
          <span className="w-32 flex-shrink-0 truncate" title={row.tenantName}>
            <span className="rounded bg-paper-2 border border-hairline px-1.5 py-0.5 text-3xs font-medium text-ink-2">{row.tenantName ?? "This workspace"}</span>
          </span>
        )}
        <span className="w-40 flex-shrink-0 truncate font-mono text-2xs text-ink-3" title={page ?? undefined}>{page ?? "screen unknown"}</span>
        <span className="basis-full md:basis-0 flex-1 min-w-0 truncate text-sm font-medium text-ink" title={title}>
          {isUrgent(row) && <span aria-label="Urgent" title="Urgent">⚡ </span>}
          {title}
        </span>
        <span className="w-9 flex-shrink-0 text-right tabular-nums text-ink-3" title={row.severity_score === null ? "Not triaged yet" : `Severity ${row.severity_score} of 100`}>
          {row.severity_score ?? "—"}
        </span>
        <span className="w-[7.5rem] flex-shrink-0">
          <Badge kind={STATUS_KIND[tab]} size="sm">{STATUS_FILTER_LABEL[tab]}</Badge>
        </span>
        <span className="w-14 flex-shrink-0 font-mono text-2xs text-ink-2" title={card ? `Work board card ${card}` : "No card yet"}>{card ?? "—"}</span>
        <span className="flex-shrink-0 inline-flex items-center gap-1 text-ink-3 font-medium">
          {open ? "Hide" : "Details"}
          <Icon name={open ? "chevron_up" : "chevron_down"} size={14} />
        </span>
      </button>

      {open && (
        <div id={panelId} className="px-3 pb-4 pt-1 border-t border-hairline bg-paper">
          <RowDetails row={row} userId={userId} meName={meName} foreign={foreign} canUrgent={canUrgent} card={card} />
        </div>
      )}
    </li>
  );
}

function RowDetails({ row, userId, meName, foreign, canUrgent, card }: {
  row: FeedbackListRow; userId: string | null; meName: string; foreign: boolean; canUrgent: boolean; card: string | null;
}) {
  const directiveRef = React.useRef<HTMLPreElement>(null);
  /* Copy failed: select the directive so Ctrl+C is all that is left. */
  const showForManualCopy = () => { setTimeout(() => selectText(directiveRef.current), 50); };

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
      toast.error("There is no directive yet.", { description: "Press Re-check type & score below." });
      return;
    }
    /* R-200: the last step tells the fixing session to mark THIS report fixed in this app,
       so the person who filed it sees "done · waiting for browser test" without asking. */
    const footer = buildFixFooter(row.id, window.location.origin);
    const ok = await copyToClipboard(`${row.directive}\n${footer}`);
    if (ok) toast.success("Directive copied — paste it into Claude Code.");
    else {
      showForManualCopy();
      toast.warning("Browser blocked copying.", { description: "The directive is selected below — press Ctrl+C." });
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
      toastError(err, { fallback: "Could not mark it checked.", description: "Reload the page and try again." });
    }
  };

  const handleUnmarkChecked = async () => {
    try {
      await unmarkChecked.mutateAsync({ id: row.id });
      toast.success("Check removed.", { description: "It shows \"waiting for browser test\" again." });
    } catch (err) {
      toastError(err, { fallback: "Could not remove the check.", description: "Reload the page and try again." });
    }
  };

  const handleCopyCheck = async () => {
    const ok = await copyToClipboard(buildCheckPrompt({ ...row, screenshots: [] }, window.location.origin));
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
      toastError(err, {
        fallback: "Triage failed.",
        description: "The report is unchanged. Press Re-check type & score again in a moment.",
      });
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

      /* Says where the report went: on 5 Oct three reports "vanished" for the person who pressed it. */
      if (!copied && directive) showForManualCopy();
      toast.success(copied ? "Moved to Queued for AI — directive copied." : "Moved to Queued for AI.", {
        description: copied
          ? "Not fixed yet: paste it into Claude Code to make the fix. The report waits in the Queued for AI tab."
          : "Not fixed yet. The browser blocked copying — the AI worker will still put it on the board (urgent: in a few minutes; others: within 30 min).",
        duration: 10_000,
      });
    } catch (err) {
      toastError(err, {
        fallback: "Could not queue this report.",
        description: "It is still Open. Press the button again.",
      });
    }
  };

  const handleStatus = async (status: FeedbackStatus) => {
    try {
      await setStatus.mutateAsync({ id: row.id, status });
      toast.success(status === "fixed" ? "Marked fixed." : status === "wont_fix" ? "Marked won't fix." : "Reopened.");
    } catch (err) {
      toastError(err, {
        fallback: "Could not update the status.",
        description: "The report keeps its old status. Refresh and try again.",
      });
    }
  };

  const busy = triage.isPending || dispatch.isPending || setStatus.isPending || markChecked.isPending || unmarkChecked.isPending;
  const queuedCard = row.status === "agent_queued" ? card : null;
  const claimed = Boolean(row.agent_claimed_at);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap pt-2">
        <Badge kind={badge.kind} size="sm">{badge.label}</Badge>
        {row.inferred_type && row.inferred_type !== row.reported_type && (
          <Badge kind="outline" size="sm" title={`The reporter filed this as "${row.reported_type}"`}>
            filed as {row.reported_type}
          </Badge>
        )}
        <Badge kind={severityKind(row.severity_score)} size="sm">{row.reported_severity}</Badge>
        {row.triage_mode && (
          <Badge kind="muted" size="sm" title={row.triage_mode === "stub" ? "No Gemini key configured — the built-in engine ran" : "Triaged by Gemini"}>
            {row.triage_mode}
          </Badge>
        )}
        {row.status === "fixed" && (row.checked_at
          ? <Badge kind="success" size="sm">✓ checked {formatDate(row.checked_at)}{row.checked_by_name ? ` · ${row.checked_by_name}` : ""}</Badge>
          : <Badge kind="warning" size="sm">done · waiting for browser test</Badge>)}
        {row.filed_via === "ai-chat" && <Badge kind="info" size="sm">🤖 AI-drafted after chat</Badge>}
        <span className="text-xs text-ink-3">
          {[row.reporter_name ?? "Unknown reporter", row.reporter_email].filter(Boolean).join(" · ")}
        </span>
        {row.status === "fixed" && row.resolved_at && <span className="text-xs text-emerald">fixed {formatDate(row.resolved_at)}</span>}
      </div>

      <p className="text-sm font-medium text-ink break-words">{row.problem_summary || row.title}</p>

      {/* R-200 / R-356: what the AI did, which card + commit, and when (all from the note
          /api/agent/feedback-fixed stores — no extra columns). */}
      {row.status === "fixed" && row.resolution_note && (
        <AiFixedStrip note={row.resolution_note} resolvedAt={row.resolved_at} pagePath={row.page_path} />
      )}
      {/* R-397: an urgent report says so first — "⚡ Urgent · AI worker has it · R-xxx". */}
      {row.status === "agent_queued" && isUrgent(row) && <UrgentStrip card={queuedCard} urgentAt={urgentAtOf(row)} />}
      {/* R-356: a queued report says where it is, not just a chip. R-2726: "has it" only once the worker claimed it. */}
      {row.status === "agent_queued" && !isUrgent(row) && (
        <p data-testid="ai-queued-strip" className="mt-1 text-xs text-ink-2 bg-paper-2 border border-hairline rounded-md px-2 py-1">
          {claimed ? "🤖 AI worker has it" : "🤖 Queued for the AI worker"}
          {queuedCard ? <> · card <b className="font-mono">{queuedCard}</b></> : null}
          {row.dispatched_at ? <> · queued {formatDate(row.dispatched_at, "relative")}</> : null}
          {queuedCard ? null : <span className="text-ink-3"> · card id shows here once the worker takes it</span>}
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        {foreign ? (
          <>
            <SendToAiButton row={row} />
            {/* R-397: the platform owner may mark another workspace's report urgent. */}
            <UrgentToggle row={row} className="mt-2 mr-2 py-0.5 text-2xs" />
            {row.directive && (
              <Button size="sm" variant="outline" onClick={handleCopy} title="Copies the fix instructions to paste into Claude Code yourself">
                <Icon name="copy" size={14} className="mr-1.5" />
                Copy Directive
              </Button>
            )}
          </>
        ) : (
          <>
            {/* 6 Oct 2026 (Pardeep, Fixed tab): Auto-Fix on a fixed / won't-fix / already queued
                report only re-queued it. It is for open reports; Reopen first to send one again. */}
            {row.status === "open" && (
              <Button variant="primary" size="sm" onClick={handleAutoFix} disabled={busy} title="Send to the AI worker — it becomes a card on the work board (urgent: in a few minutes; others: within 30 min)">
                <Icon name="sparkles" size={14} className="mr-1.5" />
                Run AI Auto-Fix
              </Button>
            )}
            {/* R-397: owner/manager (or platform owner) only; hidden until the urgent migration is applied. */}
            {canUrgent && <UrgentToggle row={row} disabled={busy} />}
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
          </>
        )}
      </div>

      {/* Pardeep, 6 Oct 2026: "isko aur badiya informatic banao jisse user ko sab kuch clear ho
          sake wo kya kar sakta hai" — one line per state saying what the buttons do. */}
      <p className="flex gap-1.5 text-xs text-ink-3 leading-relaxed">
        <Icon name="info" size={13} className="flex-shrink-0 mt-0.5" />
        <span>{foreign ? OTHER_WORKSPACE_HELP : ACTION_HELP[row.status] ?? ""}</span>
      </p>

      <div className="pt-3 border-t border-hairline space-y-4">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">{row.filed_via === "ai-chat" ? "What the AI wrote (after the chat), filed by the reporter" : "What the reporter wrote"}</h4>
          {row.filed_via === "ai-chat" && row.ai_chat_summary && (
            <p className="text-xs text-ink-2 mb-1.5"><b>Chat:</b> {row.ai_chat_summary}</p>
          )}
          <pre data-testid="feedback-body" className="text-xs text-ink whitespace-pre-wrap font-mono bg-paper-2 border border-hairline rounded-md p-3 max-h-56 overflow-y-auto">
            {row.body}
          </pre>
        </div>

        {row.screenshots.length > 0 && (
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">Screenshots</h4>
            <div className="flex gap-2 flex-wrap">
              {row.screenshots.map((s) => <ScreenshotThumb key={s.id} shot={s} />)}
            </div>
          </div>
        )}

        {/* R-393: re-running triage is a rare fix-up, so it sits below the report, not with the main buttons. */}
        {!foreign && (row.status === "open" || row.status === "agent_queued") && (
          <RecheckTypeScore onRun={() => void handleRunTriage()} disabled={busy} />
        )}

        {(row.triage_notes ?? []).length > 0 && (
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-ink-3 mb-1.5">What the triage noticed</h4>
            <ul className="space-y-1">
              {row.triage_notes.map((n, i) => (
                <li key={i} className="text-xs text-ink-2 flex gap-2">
                  <span aria-hidden className="text-ink-3 flex-shrink-0">•</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(row.target_files ?? []).length > 0 && (
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
              No directive yet{foreign ? "." : <> — press <b>Re-check type &amp; score</b> above to make one.</>}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
