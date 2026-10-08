/**
 * R-366 — "Send to AI" for another workspace's report, from /admin/feedback → All workspaces.
 *
 * Pardeep, 7 Oct 2026: a tester's reports (his own workspace) were read-only in the platform
 * view — only "Copy directive", so the report reached the AI by copy-paste. The fix is ONE
 * server route (/api/admin/feedback/platform/dispatch), gated exactly like the platform list
 * route (isPlatformAdmin on the authenticated email, checked before the service role exists).
 *
 * The write is the same conditional update R-357's auto-send uses — `status = 'open' AND
 * dispatched_at IS NULL` — so a second press, a double click or a race with the auto-send
 * changes nothing and is reported as "already with the AI", never as an error.
 *
 * The client sends report ids only. The tenant of each row is READ from the row with the
 * service role and the update is pinned to it; a tenant id in the body is never looked at.
 */
import { z } from "zod";

/** One id, or every open report across workspaces. Anything else in the body is ignored. */
export const platformDispatchBody = z.union([
  z.object({ id: z.string().uuid() }),
  z.object({ all: z.literal(true) }),
]);
export type PlatformDispatchBody = z.infer<typeof platformDispatchBody>;

/** Cap on "Send all open to AI" — the platform list route itself shows at most 500 rows. */
export const PLATFORM_DISPATCH_MAX = 500;

export const PLATFORM_DISPATCH_FORBIDDEN = {
  error: "Only the platform owner can send other workspaces' reports to the AI.",
  nextStep: "Your own workspace's reports have Run AI Auto-Fix on their own cards.",
} as const;

/** A row as read before the write — only what the decision needs. */
export interface DispatchCandidate {
  id: string;
  tenant_id: string;
  status: string;
  dispatched_at: string | null;
}

/** May this row go to the AI queue? Same rule as the R-357 conditional update. */
export function canQueue(row: Pick<DispatchCandidate, "status" | "dispatched_at"> | null | undefined): boolean {
  return Boolean(row && row.status === "open" && !row.dispatched_at);
}

/**
 * The columns the route writes — and nothing else. Identical to R-357's auto-send patch
 * except `dispatched_by`, which names the platform owner who pressed the button.
 */
export function queuePatch(callerId: string, now: string) {
  return { status: "agent_queued" as const, dispatched_at: now, dispatched_by: callerId, updated_at: now };
}

/** Toast text for the result: how many went, and how many were already taken. */
export function dispatchSummary(queued: number, skipped: number): string {
  if (queued === 0 && skipped === 0) return "No open reports to send.";
  if (queued === 0) return skipped === 1 ? "Already with the AI — nothing to send." : `All ${skipped} were already with the AI.`;
  const sent = queued === 1 ? "1 report sent to the AI worker" : `${queued} reports sent to the AI worker`;
  return skipped > 0 ? `${sent} · ${skipped} already with the AI` : sent;
}
