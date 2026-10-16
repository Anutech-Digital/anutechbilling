"use client";

/**
 * R-1417 (16 Oct 2026) — "already reported?" under the Report a problem box.
 *
 * While someone types, up to five of their OWN company's still-open reports with a similar
 * title are listed, so a known problem is seen before it is filed a second time. Own company
 * only (Pardeep's decision, 12 Oct): the read below is pinned to the caller's tenant on top of
 * RLS, and only id/title/status/date are read — never a report body.
 *
 * Read-only for now. A "+1 / I have this too" button needs somewhere to store the vote that is
 * not a new report row (a votes table = a migration); that is the rest of R-1417.
 *
 * Why useEffect and not TanStack Query: the Help panel is also mounted bare in many tests
 * (no QueryClientProvider), and this is a single read per opening of the tab.
 */
import * as React from "react";
import { createClient } from "@/lib/supabase/client";
import { findSimilarReports, matchWords, type ReportTitle } from "@/lib/feedback/similar-reports";

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

export function HelpReportMatches({ text, tenantId, load = fetchOpenReportTitles }: {
  text: string;
  tenantId: string | null | undefined;
  /** Injected in tests; the app uses fetchOpenReportTitles. */
  load?: (tenantId: string) => Promise<ReportTitle[]>;
}) {
  const [reports, setReports] = React.useState<ReportTitle[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [settled, setSettled] = React.useState("");

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
          <p className="text-2xs text-ink-3 mb-1">If one of these is your problem, it is already known — no need to file it again.</p>
          <ul className="space-y-1">
            {matches.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-2 text-xs text-ink-2">
                <span className="min-w-0 break-words">{m.title}</span>
                <span className="shrink-0 rounded-full border border-hairline bg-paper px-1.5 text-2xs text-ink-3">
                  {STATUS_LABEL[m.status] ?? m.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
