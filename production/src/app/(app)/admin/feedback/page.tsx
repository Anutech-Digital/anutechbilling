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
 *
 * ─── R-2726 (13 Nov 2026): SEARCH, FILTERS, SORTING, COMPACT ROWS ───────────
 * Pardeep: "isme bug search ka option hona chahiye, saare filter hona chahiye, sorting honi
 * chahiye". The page was one endless list of 290 long report bodies and a real user's report
 * was missed in it. Now: a search box, filters, sort, one line per report (opens to the full
 * report and its buttons), 50 a page — all done by the database, and kept in the address so a
 * reload or a shared link shows the same list. The default view is every status, newest
 * first: a new report must be the first thing on the page whatever state it is in.
 *
 * Access did not change: "This workspace" reads through the browser client under RLS;
 * "All workspaces" is drawn only for the platform owner and its route re-checks that on the
 * server before it reads anything (see /api/admin/feedback/platform).
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { loadErrorBody } from "@/components/shared/load-error";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { FeedbackAutoSendToggle } from "@/components/feedback/auto-send-toggle";
import {
  useFeedbackPage,
  useFeedbackFacets,
  useFeedbackStatuses,
  usePlatformFeedbackPage,
  usePlatformFeedbackFacets,
} from "@/lib/queries/feedback";
import { parseFixedNote, newlyFixedIds } from "@/lib/feedback/fixed-note";
import {
  DEFAULT_FEEDBACK_FILTERS,
  STATUS_FILTERS,
  STATUS_FILTER_LABEL,
  feedbackFiltersToParams,
  hasAnyFilter,
  nextVisitMemory,
  parseFeedbackFilters,
  type FeedbackFilters,
  type FeedbackScope,
  type StatusFilter,
  type VisitMemory,
} from "@/lib/feedback/list-filters";
import { mayMarkUrgent } from "@/lib/feedback/urgent";
import { SendAllOpenButton } from "./platform-ai";
import { FeedbackFilterBar } from "./feedback-filter-bar";
import { FeedbackRowItem, whenIst, type FeedbackListRow } from "./feedback-row";

/**
 * The filters and the scope, held in the address (R-272 mechanics, same as useUrlState): read
 * from `window` after mount — not useSearchParams(), which fails the build without a Suspense
 * boundary — and written with history.replaceState, so there is no page load and Back still
 * leaves the page. `ready` is false until the address was read, so the list is not fetched
 * once for the default view and again for the real one.
 */
function useFeedbackUrl() {
  const [state, setState] = React.useState<{ filters: FeedbackFilters; scope: FeedbackScope; ready: boolean }>(
    { filters: DEFAULT_FEEDBACK_FILTERS, scope: "mine", ready: false },
  );

  React.useEffect(() => {
    const read = () => {
      const p = new URLSearchParams(window.location.search);
      setState({ filters: parseFeedbackFilters(p), scope: p.get("scope") === "all" ? "all" : "mine", ready: true });
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  const write = React.useCallback((filters: FeedbackFilters, scope: FeedbackScope) => {
    setState({ filters, scope, ready: true });
    const p = feedbackFiltersToParams(filters);
    if (scope === "all") p.set("scope", "all");
    const qs = p.toString();
    /* `null`, not window.history.state: Next's router skips a replaceState that carries its own
       state object (it treats it as its own call) and would later write its remembered address
       back — seen in the card test: reporter + status vanished from the address after a re-render.
       With null it records the new address, so a reload or a shared link shows this list. */
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
  }, []);

  return { ...state, write };
}

/**
 * "New since my last visit" — per viewer and per browser (localStorage). Returns the time
 * this viewer last opened the page before the current visit, or null on a first visit.
 */
function useLastVisit(userId: string | null | undefined): string | null {
  const [since, setSince] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!userId) return;
    const key = `feedback:last-visit:${userId}`;
    try {
      const prev = JSON.parse(window.localStorage.getItem(key) ?? "null") as VisitMemory | null;
      const next = nextVisitMemory(prev, new Date());
      window.localStorage.setItem(key, JSON.stringify(next));
      setSince(next.since);
    } catch {
      /* Storage blocked or a damaged value: the chip simply stays off. */
      setSince(null);
    }
  }, [userId]);
  return since;
}

export default function AdminFeedbackPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();
  const { filters, scope: urlScope, ready, write } = useFeedbackUrl();
  const since = useLastVisit(me?.userId);

  /* ── Every workspace, for the platform owner ───────────────────────────────
     A tester with his own tenant filed a bug on 22 Aug and nobody could read it:
     feedback is RLS-scoped to the signed-in workspace, so this page could only ever
     show ANUTECH's own reports. Reporting worked, reading did not.

     The flag here only decides whether the toggle is DRAWN and whether the request is
     made. The route re-checks the authenticated email against the same founder allowlist
     before it touches the service role, so ?scope=all typed by anyone else changes nothing:
     they keep their own workspace's list. */
  const isPlatform = Boolean(me?.isPlatformAdmin);
  const scope: FeedbackScope = isPlatform && urlScope === "all" ? "all" : "mine";

  const mine = useFeedbackPage(filters, since, ready && !meLoading && scope === "mine");
  const platform = usePlatformFeedbackPage(filters, since, ready && scope === "all");
  const mineFacets = useFeedbackFacets(ready && !meLoading && scope === "mine");
  const platformFacets = usePlatformFeedbackFacets(ready && scope === "all");
  const { data: statuses } = useFeedbackStatuses();

  const active = scope === "all" ? platform : mine;
  const data = active.data;
  const rows: FeedbackListRow[] = data?.rows ?? [];
  const facets = scope === "all" ? platformFacets.data?.facets : mineFacets.data;
  const isLoading = !ready || meLoading || active.isLoading;
  const error = active.error as Error | null;

  const setFilters = (next: FeedbackFilters) => write(next, urlScope);
  const setStatus = (status: StatusFilter) => write({ ...filters, status, pageNo: 1 }, urlScope);

  /* R-356: the AI marks a report fixed from outside this page. When a poll (every 30 s,
     visible tab only) or coming back to the tab sees a report turn fixed WITH an AI note,
     say so — the row changes on its own, and the toast says where it went. A note-less
     fix is the owner's own "Mark fixed", which already has its own toast. */
  const prevStatuses = React.useRef<Record<string, string> | null>(null);
  const [justFixed, setJustFixed] = React.useState<Set<string>>(() => new Set());
  const showFixed = React.useRef<() => void>(() => undefined);
  showFixed.current = () => setStatus("fixed");
  React.useEffect(() => {
    if (!statuses) return;
    const next: Record<string, string> = {};
    for (const [id, r] of Object.entries(statuses)) next[id] = r.status;
    const fresh = newlyFixedIds(prevStatuses.current, next).filter((id) => Boolean(statuses[id]?.resolution_note));
    prevStatuses.current = next;
    if (fresh.length === 0) return;
    const first = parseFixedNote(statuses[fresh[0]].resolution_note);
    toast.success(fresh.length === 1 ? "Fixed by AI — moved to Fixed" : `${fresh.length} reports fixed by AI — moved to Fixed`, {
      description: [first.card, first.commit, first.text].filter(Boolean).join(" · ").slice(0, 200),
      action: { label: "Show", onClick: () => showFixed.current() },
      duration: 10_000,
    });
    setJustFixed(new Set(fresh));
  }, [statuses]);
  /* The green ring is a flash, not a state: gone after 8 s. */
  React.useEffect(() => {
    if (justFixed.size === 0) return;
    const t = setTimeout(() => setJustFixed(new Set()), 8_000);
    return () => clearTimeout(t);
  }, [justFixed]);

  const untriagedCount = rows.filter((r) => r.isOwnWorkspace !== false && r.triage_status !== "triaged").length;
  const total = data?.total;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const firstShown = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const lastShown = data ? Math.min(data.total, (data.page - 1) * data.pageSize + rows.length) : 0;
  const filtered = hasAnyFilter(filters, scope);
  /* A page number past the end (rows were closed, or an old link): go to the last page. */
  const pastEnd = Boolean(data) && rows.length === 0 && (data?.total ?? 0) > 0 && filters.pageNo > pageCount;
  React.useEffect(() => {
    if (pastEnd) write({ ...filters, pageNo: pageCount }, urlScope);
  }, [pastEnd, pageCount, filters, urlScope, write]);
  /* Duplicate is rare: the tab shows only when something is in it (or it is the one selected). */
  const tabs = STATUS_FILTERS.filter((s) => s !== "duplicate" || filters.status === "duplicate" || (data?.counts.duplicate ?? 0) > 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-4">
      <div>
        <h1 className="text-2xl md:text-3xl font-serif text-ink">Feedback &amp; AI Fixes</h1>
        <p className="text-sm text-ink-3 mt-1">
          Every bug report and idea the team files with <kbd className="px-1 py-0.5 rounded bg-paper-2 border border-hairline font-mono text-2xs">Ctrl</kbd>{" "}
          <kbd className="px-1 py-0.5 rounded bg-paper-2 border border-hairline font-mono text-2xs">Shift</kbd>{" "}
          <kbd className="px-1 py-0.5 rounded bg-paper-2 border border-hairline font-mono text-2xs">B</kbd>, triaged and turned into a directive for a coding agent.
        </p>
      </div>

      <FeedbackAutoSendToggle />

      {/* Only the platform owner sees this. Everyone else gets their own workspace's list. */}
      {isPlatform && (
        <div className="flex flex-wrap items-center gap-2">
          {(["mine", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => write({ ...filters, workspace: "", pageNo: 1 }, s)}
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
          {scope === "all" && (
            <span className="ml-auto"><SendAllOpenButton rows={[]} count={platformFacets.data?.openToSend ?? 0} /></span>
          )}
        </div>
      )}

      {/* Said once, at the top, rather than left for someone to infer from a status chip. */}
      <div className="rounded-lg border border-hairline bg-paper-2 p-3 flex gap-2.5">
        <Icon name="info" size={16} className="text-ink-3 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-ink-2 leading-relaxed">
          <b>Run AI Auto-Fix</b> writes the directive, copies it to your clipboard and marks the report queued.
          It does <b>not</b> change any code by itself — this app runs on a server with no access to the
          repository. The AI worker picks up queued reports (urgent: in a few minutes; others: within 30 min) and puts each one on the
          work board as a card; the fix is made from there. You can also paste the directive into
          Claude Code yourself. Click a row to open the full report and its buttons.
        </p>
      </div>

      <FeedbackFilterBar
        filters={filters}
        onChange={setFilters}
        onClear={() => write({ ...DEFAULT_FEEDBACK_FILTERS, sort: filters.sort }, urlScope)}
        scope={scope}
        facets={facets}
        total={isLoading ? undefined : total}
        sinceLabel={since ? whenIst(since) : null}
      />

      <TabBar
        value={filters.status}
        onChange={(id) => setStatus(id as StatusFilter)}
        items={tabs.map((s) => ({ id: s, label: STATUS_FILTER_LABEL[s], count: data?.counts[s] }))}
      />

      {untriagedCount > 0 && (
        <p className="text-xs text-amber-ink bg-amber-soft border border-amber/30 rounded-md px-3 py-2">
          {untriagedCount} report(s) on this page have no directive yet. Open the row and press <b>Re-check type &amp; score</b>, or{" "}
          <b>Run AI Auto-Fix</b>, which triages first.
        </p>
      )}

      {isLoading && (
        <div className="space-y-1.5">
          {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9 w-full rounded-md" />)}
        </div>
      )}

      {/* An error must not read as "no reports". */}
      {error && scope === "all" && (
        <Card className="p-4 text-[13px] text-ink-2">
          <b className="text-ink">Could not load other workspaces.</b> {loadErrorBody(error)}
        </Card>
      )}
      {error && scope === "mine" && (
        <Card className="p-6">
          <EmptyState
            icon="alert"
            title="Could not load the feedback queue"
            body={
              <>
                {loadErrorBody(error)}
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
            title={filtered ? (filters.status === "open" && !filters.q ? "Nothing open" : "No reports match") : "No reports yet"}
            body={
              filtered ? (
                <>
                  Nothing matches this search and these filters.{" "}
                  {(data?.counts.all ?? 0) > 0 && filters.status !== "all"
                    ? `The All tab has ${data?.counts.all} with the same search.`
                    : "Change or clear the filters to see more."}
                </>
              ) : "Anyone on the team can file one from any screen with Ctrl + Shift + B."
            }
          />
        </Card>
      )}

      {!isLoading && !error && rows.length > 0 && (
        <Card className="p-0 overflow-hidden">
          {/* Column names for the one-line rows (laptop and wider; a phone wraps the row). */}
          <div aria-hidden className="hidden md:flex items-center gap-x-3 px-3 py-1.5 border-b border-hairline bg-paper-2/60 text-2xs font-semibold uppercase tracking-wide text-ink-3">
            <span className="w-[7.5rem] flex-shrink-0">Filed (IST)</span>
            <span className="w-32 flex-shrink-0">Reporter</span>
            {scope === "all" && <span className="w-32 flex-shrink-0">Workspace</span>}
            <span className="w-40 flex-shrink-0">Page</span>
            <span className="flex-1 min-w-0">Report</span>
            <span className="w-9 flex-shrink-0 text-right" title="Severity score, 0–100">Sev</span>
            <span className="w-[7.5rem] flex-shrink-0">Status</span>
            <span className="w-14 flex-shrink-0">Card</span>
            <span className="w-[4.25rem] flex-shrink-0" />
          </div>
          <ul className="divide-y divide-hairline" data-testid="feedback-rows">
            {rows.map((row) => (
              <FeedbackRowItem
                key={row.id}
                row={row}
                userId={me?.userId ?? null}
                meName={me?.fullName ?? "Owner"}
                showWorkspace={scope === "all"}
                justFixed={justFixed.has(row.id)}
                canUrgent={isPlatform || mayMarkUrgent(me?.role)}
              />
            ))}
          </ul>
        </Card>
      )}

      {!isLoading && !error && data && data.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
          <span data-testid="feedback-page-range" className="tabular-nums">
            {rows.length > 0 ? `Showing ${firstShown}–${lastShown} of ${data.total}` : `Page ${data.page} is past the end — ${data.total} in all`}
          </span>
          {pageCount > 1 && (
            <span className="inline-flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={data.page <= 1} onClick={() => write({ ...filters, pageNo: Math.max(1, data.page - 1) }, urlScope)}>
                Previous
              </Button>
              <span className="tabular-nums">Page {data.page} of {pageCount}</span>
              <Button size="sm" variant="outline" disabled={data.page >= pageCount} onClick={() => write({ ...filters, pageNo: Math.min(pageCount, data.page + 1) }, urlScope)}>
                Next
              </Button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
