/**
 * Feedback — TanStack Query hooks (migration 20260819120000).
 *
 * ─── THE BUG THIS REPLACES ──────────────────────────────────────────────────
 * The previous submit path did this:
 *
 *     const { error } = await supabase.from("support_tickets").insert({ … });
 *     if (error) console.warn("Supabase ticket error, saving to local feedback store:", error);
 *     toast.success("Thank you! Your testing report … have been submitted.");
 *
 * There was no local feedback store. On any insert failure — an RLS refusal, a network
 * drop, a constraint — the report was gone and the reporter was thanked for it. That is
 * the worst failure a feedback box can have: the person believes the problem is now
 * known, so they never mention it again, and nobody is looking. Every write here throws,
 * and the dialog only clears itself after the promise resolves.
 *
 * ─── SCREENSHOTS ────────────────────────────────────────────────────────────
 * Uploaded to the `documents` bucket under `<tenant_id>/feedback/<id>/`, which is the
 * shape the bucket's existing tenant policies match on. Previously they were base64
 * data: URLs concatenated into the ticket body; the largest such row on prod is 214,531
 * characters for one PNG.
 *
 * A failed screenshot upload does NOT fail the report. The words are the valuable part
 * and they are already saved by then — losing a bug report because an image did not
 * upload trades the thing that matters for the thing that decorates it. What must not
 * happen is silence, so the caller is told exactly how many did not make it.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { forgetBrowserSession } from "@/lib/auth/browser-auth";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { FeedbackSeverity, FeedbackType } from "@/lib/feedback/triage";
import {
  FACET_COLUMNS,
  FEEDBACK_PAGE_SIZE,
  buildFacets,
  feedbackFiltersToParams,
  feedbackPageQueries,
  looseFeedbackQuery,
  tallyStatuses,
  type FacetSourceRow,
  type FeedbackFacets,
  type FeedbackFilters,
  type StatusCounts,
} from "@/lib/feedback/list-filters";

export type FeedbackRow = Database["public"]["Tables"]["feedback"]["Row"];
export type FeedbackScreenshotRow = Database["public"]["Tables"]["feedback_screenshots"]["Row"];
export type FeedbackStatus = FeedbackRow["status"];

/** The bucket the screenshots live in — an existing one, deliberately. See the migration. */
const SCREENSHOT_BUCKET = "documents";

export interface FeedbackWithShots extends FeedbackRow {
  screenshots: FeedbackScreenshotRow[];
}

/** One page of the list, with the tab counts for the same search/filters (R-2726). */
export interface FeedbackPage<R> {
  rows: R[];
  /** Rows matching every filter, across all pages. */
  total: number;
  /** Per status tab, for the filters WITHOUT the status. */
  counts: StatusCounts;
  page: number;
  pageSize: number;
}

/**
 * R-356 (7 Oct 2026): an open page went stale. The AI marked a report fixed at 05:47Z
 * (/api/agent/feedback-fixed), but Pardeep's open tab still showed it under Open with
 * "Run AI Auto-Fix" until he reloaded. The queue now refetches every 30 s while the tab
 * is visible (never in a background tab) and again when he comes back to the tab.
 */
export const FEEDBACK_REFETCH_MS = 30_000;
const LIVE = {
  refetchInterval: FEEDBACK_REFETCH_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
} as const;

/** One cheap read (id, status, AI note) shared by the tab counts and the "just fixed" notice. */
const STATUS_KEY = ["feedback", "statuses"] as const;
export interface FeedbackStatusRow { id: string; status: string; resolution_note: string | null }
async function fetchStatuses(): Promise<FeedbackStatusRow[]> {
  return fetchFeedbackStatuses(createClient());
}

/**
 * R-1588: every report's status. The old `.limit(5000)` came back as 1000 rows (the gateway
 * caps every answer), so the tab counts stopped at 1000. Paged, ordered on `id`.
 */
export async function fetchFeedbackStatuses(supabase: SupabaseClient<Database>): Promise<FeedbackStatusRow[]> {
  const data = await fetchAllRows((from, to) => supabase.from("feedback").select("id, status, resolution_note")
    .order("id", { ascending: true }).range(from, to));
  return data as FeedbackStatusRow[];
}

/** id → {status, AI note} for every report in the workspace (R-356: the "Fixed by AI" notice). */
export function useFeedbackStatuses() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: fetchStatuses,
    select: (rows): Record<string, FeedbackStatusRow> => Object.fromEntries(rows.map((r) => [r.id, r])),
    staleTime: 15_000,
    ...LIVE,
  });
}

/**
 * R-2726 — one page of THIS workspace's reports: searched, filtered, sorted and paged by the
 * database (50 a page), plus the tab counts for the same filters.
 *
 * Access is what it always was: the browser client under the RLS policy `feedback_select`
 * (tenant_id = current_tenant_id()). The filters only narrow that; in this scope no tenant
 * step is ever built (lib/feedback/list-filters), so ?ws= in the address does nothing here.
 * `since` is the viewer's own "last visit" time, read only when the "New" chip is on.
 */
export function useFeedbackPage(filters: FeedbackFilters, since: string | null, enabled = true) {
  return useQuery({
    queryKey: ["feedback", "page", "mine", feedbackFiltersToParams({ ...filters, workspace: "" }).toString(), filters.fresh ? since : null],
    enabled,
    queryFn: async (): Promise<FeedbackPage<FeedbackWithShots>> => {
      const supabase = createClient();
      const queries = feedbackPageQueries((cols) => supabase.from("feedback").select(cols), filters, { scope: "mine", since });

      const [pageRes, countRows] = await Promise.all([
        queries.page(),
        fetchAllRows<{ status: string; agent_claimed_at: string | null }>((a, b) => queries.counts(a, b) as never),
      ]);
      if (pageRes.error) throw pageRes.error;
      const rows = (pageRes.data ?? []) as FeedbackRow[];
      const counts = tallyStatuses(countRows);
      const paging = { total: counts[filters.status], counts, page: filters.pageNo, pageSize: FEEDBACK_PAGE_SIZE };
      if (rows.length === 0) return { rows: [], ...paging };

      // One follow-up query rather than an embed — this codebase has been bitten by
      // PostgREST relationship ambiguity (PGRST201) turning a working page into an
      // empty one, so joins are done explicitly.
      const { data: shots, error: shotErr } = await supabase
        .from("feedback_screenshots")
        .select("*")
        .in("feedback_id", rows.map((r) => r.id));
      if (shotErr) throw shotErr;

      const byParent = new Map<string, FeedbackScreenshotRow[]>();
      for (const s of (shots ?? []) as FeedbackScreenshotRow[]) {
        const list = byParent.get(s.feedback_id) ?? [];
        list.push(s);
        byParent.set(s.feedback_id, list);
      }

      return { rows: rows.map((r) => ({ ...r, screenshots: byParent.get(r.id) ?? [] })), ...paging };
    },
    staleTime: 15_000,
    placeholderData: (prev) => prev,
    ...LIVE,
  });
}

/** The Reporter / Page picker choices for this workspace — every report RLS lets the viewer read. */
export function useFeedbackFacets(enabled = true) {
  return useQuery({
    queryKey: ["feedback", "facets", "mine"],
    enabled,
    queryFn: async (): Promise<FeedbackFacets> => {
      const supabase = createClient();
      const rows = await fetchAllRows<FacetSourceRow>((a, b) =>
        looseFeedbackQuery(supabase.from("feedback").select(FACET_COLUMNS)).order("id", { ascending: true }).range(a, b) as never);
      return buildFacets(rows);
    },
    staleTime: 60_000,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["feedback"] });
}

/** Decode a `data:image/png;base64,…` URL into bytes. */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const isBase64 = header.includes(";base64");
  if (!isBase64) return null;
  const mime = header.slice(header.indexOf(":") + 1, header.indexOf(";")) || "image/png";
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

export interface SubmitFeedbackInput {
  tenantId: string;
  reportedType: FeedbackType;
  reportedSeverity: FeedbackSeverity;
  /** The whole free-text box. First line becomes the title. */
  text: string;
  pagePath: string | null;
  reporterId: string | null;
  reporterName: string | null;
  reporterEmail: string | null;
  screenshots: { name: string; dataUrl: string }[];
  /** R-158: "ai-chat" when the in-app AI Help drafted it after a chat; default "form". */
  filedVia?: "form" | "ai-chat";
  /** ai-chat only: two or three lines on the chat it came out of. */
  aiChatSummary?: string | null;
}

export interface SubmitFeedbackResult {
  id: string;
  uploaded: number;
  /** Screenshots that did not make it. Surfaced, never swallowed. */
  failedUploads: string[];
  /** False when the triage call failed — the report is still safely saved. */
  triaged: boolean;
}

/**
 * File a report.
 *
 * Order matters and is deliberate: the ROW is written first and its failure is fatal,
 * then screenshots, then triage. Everything after the row is an enhancement, and an
 * enhancement must never be able to lose the report.
 */
export function useSubmitFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: submitFeedback,
    onSuccess: () => invalidate(qc),
  });
}

/** The database said "not allowed" (RLS / privilege), in whatever shape the error came. */
function isNoAccess(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === "42501" || /row-level security|permission denied/i.test(error.message ?? "");
}

export async function submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
  const supabase = createClient();

  const cleaned = input.text.trim();
  if (!cleaned) throw new Error("Please describe what happened before submitting.");
  if (!input.tenantId) {
    // Previously this defaulted to Anutech's tenant id, which filed one tenant's bug
    // report into another tenant's books.
    throw new Error("Your workspace is still loading — please try again in a moment.");
  }

  const firstLine = cleaned.split("\n").map((l) => l.trim()).find(Boolean) ?? cleaned;
  const id = crypto.randomUUID();

  const row = {
    id,
    tenant_id: input.tenantId,
    reported_type: input.reportedType,
    reported_severity: input.reportedSeverity,
    title: firstLine.slice(0, 200),
    body: cleaned,
    page_path: input.pagePath,
    reported_by: input.reporterId,
    reporter_name: input.reporterName,
    reporter_email: input.reporterEmail,
    filed_via: input.filedVia ?? "form",
    ai_chat_summary: input.filedVia === "ai-chat" ? (input.aiChatSummary ?? null)?.slice(0, 1000) ?? null : null,
  };
  let { error } = await supabase.from("feedback").insert(row);
  /* R-1501: "not allowed" for a report into the person's OWN workspace means the request did not
     carry their sign-in (a failed token refresh sent it as a visitor — Pawan, 17 Oct). Drop the
     remembered token, fetch a fresh one and try once more. Same client-made id, so a retry can
     never file the report twice. */
  if (error && isNoAccess(error)) {
    forgetBrowserSession();
    ({ error } = await supabase.from("feedback").insert(row));
  }
  // Fatal on purpose. The old code logged this and thanked the reporter anyway.
  /* As an Error with the real message (5 Oct 2026): a PostgrestError is a plain object, so
     both callers' `err instanceof Error` fell through to "Could not submit the report." —
     on staging that hid "Could not find the 'filed_via' column … in the schema cache". */
  if (error) throw new Error(`Report not saved: ${error.message}${error.code ? ` (${error.code})` : ""}`);

  const failedUploads: string[] = [];
  let uploaded = 0;

  for (const shot of input.screenshots) {
    const blob = dataUrlToBlob(shot.dataUrl);
    if (!blob) { failedUploads.push(shot.name); continue; }

    // The leading tenant segment is what the bucket policy matches on.
    const safeName = shot.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80) || "screenshot.png";
    const path = `${input.tenantId}/feedback/${id}/${crypto.randomUUID()}-${safeName}`;

    const up = await supabase.storage.from(SCREENSHOT_BUCKET).upload(path, blob, {
      contentType: blob.type || "image/png",
      upsert: false,
    });
    if (up.error) { failedUploads.push(shot.name); continue; }

    const link = await supabase.from("feedback_screenshots").insert({
      feedback_id: id,
      tenant_id: input.tenantId,
      file_path: path,
      file_name: safeName,
      byte_size: blob.size,
    });
    if (link.error) { failedUploads.push(shot.name); continue; }

    uploaded++;
  }

  // Triage last, and never fatal — an unreachable API must not cost us the report.
  // The row stays `triage_status: 'pending'` and the admin page can retry it.
  let triaged = false;
  try {
    const res = await fetch("/api/feedback/triage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ feedbackId: id }),
    });
    triaged = res.ok;
  } catch {
    triaged = false;
  }

  return { id, uploaded, failedUploads, triaged };
}

/** Run (or re-run) the triage for one report. */
export function useTriageFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (feedbackId: string): Promise<{ mode: "gemini" | "stub" }> => {
      const res = await fetch("/api/feedback/triage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedbackId }),
      });
      const payload = (await res.json().catch(() => ({}))) as { mode?: "gemini" | "stub"; error?: string };
      if (!res.ok) throw new Error(payload.error || "Could not triage this report.");
      return { mode: payload.mode ?? "stub" };
    },
    onSuccess: () => invalidate(qc),
  });
}

/**
 * Hand the directive to an agent.
 *
 * This stamps `dispatched_at` and moves the row to `agent_queued`. It records that a
 * directive was HANDED OUT — nothing more. This app runs on Cloud Run and cannot edit
 * the repository, so a status of "queued" must never be read as "being fixed"; the UI
 * says so in as many words.
 */
export function useDispatchFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, userId }: { id: string; userId: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("feedback")
        .update({
          status: "agent_queued",
          dispatched_at: new Date().toISOString(),
          dispatched_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateFeedbackStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, note }: { id: string; status: FeedbackStatus; note?: string }) => {
      const supabase = createClient();
      const terminal = status === "fixed" || status === "wont_fix" || status === "duplicate";
      const { error } = await supabase
        .from("feedback")
        .update({
          status,
          resolution_note: note ?? null,
          // Only a terminal status sets a resolution time; reopening clears it, so a
          // reopened report cannot claim to have been resolved.
          resolved_at: terminal ? new Date().toISOString() : null,
          // R-188: a reopened report has not been checked any more.
          ...(status === "open" ? { checked_at: null, checked_by_name: null } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(qc),
  });
}

/**
 * R-188: "I checked this fixed report in a browser and it is fine." Stamps who and when, so
 * nobody has to remember. The AI check session sets the same fields through
 * /api/agent/feedback-checked.
 */
export function useMarkFeedbackChecked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, byName }: { id: string; byName: string }) => {
      const supabase = createClient();
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("feedback")
        .update({ checked_at: now, checked_by_name: byName.slice(0, 200), updated_at: now })
        .eq("id", id)
        .eq("status", "fixed");
      if (error) throw error;
    },
    onSuccess: () => invalidate(qc),
  });
}

/** R-188: take a "checked" back (pressed by mistake). */
export function useUnmarkFeedbackChecked() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("feedback")
        .update({ checked_at: null, checked_by_name: null, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidate(qc),
  });
}

/** A short-lived signed URL for one screenshot. Same pattern as documents/receipts. */
export async function feedbackScreenshotUrl(path: string): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.storage.from(SCREENSHOT_BUCKET).createSignedUrl(path, 60 * 10);
  return data?.signedUrl ?? null;
}

/* ────────────────────────────────────────────────────────────────────────────
   Platform view — every workspace's feedback, for the platform owner only.

   WHY IT GOES THROUGH A ROUTE. `feedback` is RLS-scoped to the signed-in tenant, and
   that stays true: widening the policy would make every existing query silently
   cross-tenant, including ones written later by someone who never knew. The single
   place allowed to cross is /api/admin/feedback/platform, server-side and gated on
   owner-of-the-distributor. See that file for the full argument.

   This exists because a tester on his own tenant filed a bug on 22 Aug and nobody could
   read it — reporting worked, reading did not.
   ──────────────────────────────────────────────────────────────────────────── */

export interface PlatformFeedbackRow extends FeedbackRow {
  tenantName: string;
  isOwnWorkspace: boolean;
  screenshots: { id: string; fileName: string; url: string | null }[];
}

async function platformGet<T>(qs: string): Promise<T> {
  const res = await fetch(`/api/admin/feedback/platform${qs ? `?${qs}` : ""}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    /* The route writes its own next step; showing it beats a bare status code. */
    throw new Error([json.error, json.nextStep].filter(Boolean).join(" ") || "Could not load");
  }
  return json as T;
}

/**
 * R-2726 — one page of EVERY workspace's reports, filtered/sorted/paged by the route.
 * `enabled` is the caller's job: the toggle that turns this on is only rendered for a
 * platform owner, so a reseller never fires a request that can only 403 (and the 403 is
 * the same whatever the filters say).
 */
export function usePlatformFeedbackPage(filters: FeedbackFilters, since: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["feedback", "platform", "page", feedbackFiltersToParams(filters).toString(), filters.fresh ? since : null],
    enabled,
    queryFn: async (): Promise<FeedbackPage<PlatformFeedbackRow>> => {
      const params = feedbackFiltersToParams(filters);
      if (filters.fresh && since) params.set("since", since);
      const json = await platformGet<Partial<FeedbackPage<PlatformFeedbackRow>>>(params.toString());
      const rows = json.rows ?? [];
      return {
        rows,
        total: json.total ?? rows.length,
        counts: json.counts ?? tallyStatuses(rows),
        page: json.page ?? filters.pageNo,
        pageSize: json.pageSize ?? FEEDBACK_PAGE_SIZE,
      };
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export interface PlatformFeedbackFacets { facets: FeedbackFacets; openToSend: number }

/** Picker choices across workspaces + how many open reports "Send all open to AI" would send. */
export function usePlatformFeedbackFacets(enabled: boolean) {
  return useQuery({
    queryKey: ["feedback", "platform", "facets"],
    enabled,
    queryFn: async (): Promise<PlatformFeedbackFacets> => {
      const json = await platformGet<Partial<PlatformFeedbackFacets>>("facets=1");
      return { facets: json.facets ?? { reporters: [], pages: [], workspaces: [] }, openToSend: json.openToSend ?? 0 };
    },
    staleTime: 60_000,
  });
}
