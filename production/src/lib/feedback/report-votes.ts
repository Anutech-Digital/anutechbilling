/**
 * R-1466 (16 Oct 2026) — "+1 / I have this too" on a report someone in the same company
 * already filed (the rest of R-1417).
 *
 * A vote is a row in `feedback_votes` (migration 20261016150000), not a new report: one row
 * per (report, user), unique, so the same person cannot inflate a count. RLS lets a user read
 * their own company's votes and add / take back only their OWN vote; every read and write
 * below is ALSO pinned to the caller's tenant (CLAUDE.md §4), and a write to the caller's
 * own user id — a missing tenant or user refuses before anything is sent (§17c, fail closed).
 */
import { createClient } from "@/lib/supabase/client";

export interface VoteRow { feedback_id: string; user_id: string }
export interface VoteTally { count: number; mine: boolean }
export interface SaveVoteArgs { tenantId: string; userId: string; feedbackId: string; on: boolean }

export const EMPTY_TALLY: VoteTally = { count: 0, mine: false };

/** Votes per report; `mine` = the caller voted. */
export function tallyVotes(rows: readonly VoteRow[], userId: string | null | undefined): Map<string, VoteTally> {
  const out = new Map<string, VoteTally>();
  for (const r of rows) {
    const t = out.get(r.feedback_id) ?? { count: 0, mine: false };
    out.set(r.feedback_id, { count: t.count + 1, mine: t.mine || (!!userId && r.user_id === userId) });
  }
  return out;
}

/** The tally after the caller presses +1: adds their vote, or takes it back. Never below zero. */
export function toggleTally(t: VoteTally): VoteTally {
  return t.mine ? { count: Math.max(0, t.count - 1), mine: false } : { count: t.count + 1, mine: true };
}

/** This tenant's votes on the listed reports. Throws on a failed read. */
export async function fetchReportVotes(tenantId: string, feedbackIds: readonly string[]): Promise<VoteRow[]> {
  if (!tenantId || feedbackIds.length === 0) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from("feedback_votes" as never)
    .select("feedback_id, user_id")
    .eq("tenant_id" as never, tenantId as never)
    .in("feedback_id" as never, [...feedbackIds] as never);
  if (error) throw error;
  return (data ?? []) as unknown as VoteRow[];
}

/** Adds (on) or takes back (off) the caller's own vote. Throws on failure. */
export async function saveReportVote({ tenantId, userId, feedbackId, on }: SaveVoteArgs): Promise<void> {
  if (!tenantId || !userId || !feedbackId) throw new Error("Not signed in to a company — cannot record a vote.");
  const supabase = createClient();
  if (on) {
    const { error } = await supabase
      .from("feedback_votes" as never)
      .insert({ tenant_id: tenantId, feedback_id: feedbackId, user_id: userId } as never);
    // 23505 = unique(feedback_id, user_id): already voted (e.g. from another tab) — the goal holds.
    if (error && (error as { code?: string }).code !== "23505") throw error;
    return;
  }
  const { error } = await supabase
    .from("feedback_votes" as never)
    .delete()
    .eq("tenant_id" as never, tenantId as never)
    .eq("feedback_id" as never, feedbackId as never)
    .eq("user_id" as never, userId as never);
  if (error) throw error;
}
