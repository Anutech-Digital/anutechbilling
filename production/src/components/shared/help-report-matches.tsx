"use client";

/**
 * R-1417 (16 Oct 2026) — "already reported?" under the Report a problem box.
 *
 * While someone types, up to five of their OWN company's still-open reports with a similar
 * title are listed, so a known problem is seen before it is filed a second time. Own company
 * only (Pardeep's decision, 12 Oct): the read below is pinned to the caller's tenant on top of
 * RLS, and only id/title/status/date are read — never a report body.
 *
 * R-1466 — each match carries a "+1 · I have this too" toggle with its count. The vote lives in
 * `feedback_votes` (one row per report + user, migration 20261016150000), never as a new report
 * row; pressing again takes the vote back. Reads/writes are pinned to the caller's tenant and the
 * write to the caller's own user id (lib/feedback/report-votes.ts). The count changes at once and
 * is put back if the save fails, with a plain "not saved — try again" and a retry button (§24).
 *
 * Why useEffect and not TanStack Query: the Help panel is also mounted bare in many tests
 * (no QueryClientProvider), and this is a single read per opening of the tab.
 */
import * as React from "react";
import { createClient } from "@/lib/supabase/client";
import { findSimilarReports, matchWords, type ReportTitle } from "@/lib/feedback/similar-reports";
import {
  EMPTY_TALLY, fetchReportVotes, saveReportVote, tallyVotes, toggleTally,
  type SaveVoteArgs, type VoteRow, type VoteTally,
} from "@/lib/feedback/report-votes";

/** How long typing must pause before the list updates. */
export const MATCH_DEBOUNCE_MS = 300;
/** Newest open reports the matcher looks through. */
const READ_LIMIT = 300;
/** A closed report (fixed / won't fix / duplicate) is not something to wait on. */
const OPEN_STATUSES = ["open", "agent_queued"] as const;
const STATUS_LABEL: Record<string, string> = { open: "Open", agent_queued: "Being fixed" };

/** This tenant's open reports, titles only. Throws on a failed read. */
export async function fetchOpenReportTitles(tenantId: string): Promise<ReportTitle[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("feedback")
    .select("id, title, status, created_at")
    .eq("tenant_id", tenantId)
    .in("status", [...OPEN_STATUSES])
    .order("created_at", { ascending: false })
    .limit(READ_LIMIT);
  if (error) throw error;
  return (data ?? []) as ReportTitle[];
}

export function HelpReportMatches({
  text, tenantId, userId = null,
  load = fetchOpenReportTitles, loadVotes = fetchReportVotes, saveVote = saveReportVote,
}: {
  text: string;
  tenantId: string | null | undefined;
  /** The signed-in user (public.users.id). No user → no +1 button. */
  userId?: string | null;
  /** Injected in tests; the app uses fetchOpenReportTitles. */
  load?: (tenantId: string) => Promise<ReportTitle[]>;
  /** Injected in tests; the app uses fetchReportVotes. */
  loadVotes?: (tenantId: string, feedbackIds: readonly string[]) => Promise<VoteRow[]>;
  /** Injected in tests; the app uses saveReportVote. */
  saveVote?: (args: SaveVoteArgs) => Promise<void>;
}) {
  const [reports, setReports] = React.useState<ReportTitle[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [settled, setSettled] = React.useState("");
  const [votes, setVotes] = React.useState<Map<string, VoteTally>>(() => new Map());
  const [saving, setSaving] = React.useState<ReadonlySet<string>>(() => new Set());
  const [voteError, setVoteError] = React.useState<{ id: string; title: string } | null>(null);

  React.useEffect(() => {
    if (!tenantId) return;
    let live = true;
    load(tenantId).then(
      (rows) => { if (live) { setReports(rows); setFailed(false); } },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [tenantId, load]);

  React.useEffect(() => {
    const t = setTimeout(() => setSettled(text), MATCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);

  const matches = React.useMemo(() => (reports ? findSimilarReports(settled, reports) : []), [reports, settled]);
  const typedEnough = matchWords(settled).length >= 2;
  const canVote = !!tenantId && !!userId;

  // Votes for the reports on screen — re-read only when the set of matched reports changes.
  const matchKey = matches.map((m) => m.id).join(",");
  React.useEffect(() => {
    if (!canVote || !tenantId || !matchKey) return;
    let live = true;
    loadVotes(tenantId, matchKey.split(",")).then(
      (rows) => { if (live) setVotes(tallyVotes(rows, userId)); },
      () => { /* counts start at zero; the list itself still helps */ },
    );
    return () => { live = false; };
  }, [canVote, tenantId, userId, matchKey, loadVotes]);

  async function toggle(id: string, title: string) {
    if (!tenantId || !userId || saving.has(id)) return;
    const before = votes.get(id) ?? EMPTY_TALLY;
    const after = toggleTally(before);
    setVoteError(null);
    setVotes((m) => new Map(m).set(id, after));
    setSaving((s) => new Set(s).add(id));
    try {
      await saveVote({ tenantId, userId, feedbackId: id, on: after.mine });
    } catch {
      setVotes((m) => new Map(m).set(id, before));
      setVoteError({ id, title });
    } finally {
      setSaving((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  }

  return (
    <div aria-live="polite">
      {failed && typedEnough && (
        <p role="status" className="text-2xs text-ink-3">
          Could not check for similar reports right now — you can still submit yours.
        </p>
      )}
      {matches.length > 0 && (
        <div data-testid="help-report-matches" className="rounded-lg border border-hairline bg-paper-2 px-2.5 py-2">
          <p className="text-xs font-semibold text-ink">
            {matches.length} similar report{matches.length === 1 ? "" : "s"} already filed by your company
          </p>
          <p className="text-2xs text-ink-3 mb-1">
            If one of these is your problem, it is already known — no need to file it again
            {canVote ? ". Press +1 so the team sees how many people it affects." : "."}
          </p>
          <ul className="space-y-1">
            {matches.map((m) => {
              const t = votes.get(m.id) ?? EMPTY_TALLY;
              return (
                <li key={m.id} className="flex items-start justify-between gap-2 text-xs text-ink-2">
                  <span className="min-w-0 break-words">{m.title}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="rounded-full border border-hairline bg-paper px-1.5 text-2xs text-ink-3">
                      {STATUS_LABEL[m.status] ?? m.status}
                    </span>
                    {canVote && (
                      <button
                        type="button"
                        aria-pressed={t.mine}
                        aria-label={`+1, I have this too: ${m.title}. ${t.count} ${t.count === 1 ? "person has" : "people have"} this.`}
                        title={t.mine ? "You said you have this too — press again to take it back" : "I have this too"}
                        disabled={saving.has(m.id)}
                        onClick={() => void toggle(m.id, m.title)}
                        className={`inline-flex min-h-6 items-center gap-1 rounded-full border px-2 text-2xs font-semibold tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-amber disabled:opacity-60 ${
                          t.mine ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-paper text-ink-2 hover:text-ink"
                        }`}
                      >
                        <span aria-hidden="true">+1</span>
                        <span aria-hidden="true">· {t.count}</span>
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {voteError && (
            <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-rose-ink">
              <span>
                Your +1 on &ldquo;{voteError.title}&rdquo; was not saved — the connection or your sign-in may have dropped.
                Try again; if it keeps failing, just submit your report below.
              </span>
              <button
                type="button"
                onClick={() => void toggle(voteError.id, voteError.title)}
                className="rounded border border-hairline bg-paper px-1.5 font-semibold text-ink hover:bg-paper-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
