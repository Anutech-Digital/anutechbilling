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
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import type { FeedbackSeverity, FeedbackType } from "@/lib/feedback/triage";

export type FeedbackRow = Database["public"]["Tables"]["feedback"]["Row"];
export type FeedbackScreenshotRow = Database["public"]["Tables"]["feedback_screenshots"]["Row"];
export type FeedbackStatus = FeedbackRow["status"];

/** The bucket the screenshots live in — an existing one, deliberately. See the migration. */
const SCREENSHOT_BUCKET = "documents";

export interface FeedbackWithShots extends FeedbackRow {
  screenshots: FeedbackScreenshotRow[];
}

export interface FeedbackListFilter {
  /** Omit for everything. */
  status?: FeedbackStatus;
  /** Omit for everything. Matches the INFERRED type, not what the reporter picked. */
  type?: FeedbackType;
}

/**
 * The admin queue.
 *
 * Ordered by severity first and recency second, which is the order somebody clearing a
 * queue actually wants — newest-first buries a ₹-bearing report from Tuesday under
 * three cosmetic ones from this morning. `nullsLast` matters: an untriaged row has no
 * score yet and must not sort as if it were a zero.
 */
/**
 * How many reports sit in each status — for the tab counts (5 Oct 2026). "Run AI Auto-Fix"
 * moves a report from Open to Queued for agent, and with a count only on the open tab the
 * three queued reports looked like they had vanished. Same query-key prefix as the list, so
 * every mutation that refreshes the list refreshes these too.
 */
export function useFeedbackCounts() {
  return useQuery({
    queryKey: ["feedback", "counts"],
    queryFn: async (): Promise<Record<string, number>> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("feedback").select("status").limit(5000);
      if (error) throw error;
      const out: Record<string, number> = { all: 0 };
      for (const r of data ?? []) { out[r.status] = (out[r.status] ?? 0) + 1; out.all += 1; }
      return out;
    },
    staleTime: 15_000,
  });
}

export function useFeedbackList(filter: FeedbackListFilter = {}) {
  return useQuery({
    queryKey: ["feedback", filter.status ?? "all", filter.type ?? "all"],
    queryFn: async (): Promise<FeedbackWithShots[]> => {
      const supabase = createClient();

      let q = supabase
        .from("feedback")
        .select("*")
        .order("severity_score", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });

      if (filter.status) q = q.eq("status", filter.status);
      if (filter.type) q = q.eq("inferred_type", filter.type);

      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as FeedbackRow[];
      if (rows.length === 0) return [];

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

      return rows.map((r) => ({ ...r, screenshots: byParent.get(r.id) ?? [] }));
    },
    staleTime: 15_000,
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
    mutationFn: async (input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> => {
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

      const { error } = await supabase.from("feedback").insert({
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
      });
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
    },
    onSuccess: () => invalidate(qc),
  });
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
          updated_at: new Date().toISOString(),
        })
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

/**
 * `enabled` is the caller's job: the toggle that turns this on is only rendered for a
 * platform owner, so a reseller never fires a request that can only 403.
 */
export function usePlatformFeedbackList(enabled: boolean) {
  return useQuery({
    queryKey: ["feedback", "platform"],
    enabled,
    queryFn: async (): Promise<PlatformFeedbackRow[]> => {
      const res = await fetch("/api/admin/feedback/platform");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        /* The route writes its own next step; showing it beats a bare status code. */
        throw new Error([json.error, json.nextStep].filter(Boolean).join(" ") || "Could not load");
      }
      return (json.rows ?? []) as PlatformFeedbackRow[];
    },
    staleTime: 30_000,
  });
}
