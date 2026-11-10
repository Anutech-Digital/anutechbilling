/**
 * R-2607 — the background fields of zoho_fy_scan_runs (migration 20261108100000) through the
 * server's admin client. The admin client bypasses RLS, so EVERY read and write is filtered by
 * `tenantId` + `kind` + `fy` (CLAUDE.md §17c); the tenant comes from the signed-in user's own row
 * (dialog) or from the run row itself (cron) — never from a browser.
 */
import type { FyReadKind } from "../fy-fetch";
import type { PaceEntry } from "../zoho-pace";
import type { BgState, BgStore } from "./background-read";
import { must, type FyImportDb } from "./store";

type Res<T = unknown> = PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>;

const iso = (ms: number) => new Date(ms).toISOString();

export function supabaseBgStore(db: FyImportDb, tenantId: string, kind: FyReadKind): BgStore {
  const runs = () => db.from("zoho_fy_scan_runs");
  const mine = (q: ReturnType<typeof runs>, fy: string) => q.eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy);
  return {
    async request(fy, userId) {
      /* Upsert only the background columns: a run already part-read keeps next_page / list_done (resume). */
      const r = await (runs().upsert(
        { tenant_id: tenantId, kind, fy, bg_requested_at: new Date().toISOString(), bg_requested_by: userId, bg_error: null, bg_finished_at: null },
        { onConflict: "tenant_id,kind,fy" }) as Res);
      if (r.error) throw new Error("Could not start the Zoho read.");
    },
    async readBg(fy) {
      const r = await (mine(runs().select("bg_requested_at, bg_lease_until, bg_error, bg_finished_at, bg_last_step_at, bg_pace"), fy).limit(1) as Res<Array<Record<string, string | null> & { bg_pace?: PaceEntry[] | null }>>);
      const row = must(r, "the Zoho read")[0];
      if (!row) return null;
      return {
        requestedAt: row.bg_requested_at ?? null, leaseUntil: row.bg_lease_until ?? null, error: row.bg_error ?? null,
        finishedAt: row.bg_finished_at ?? null, lastStepAt: row.bg_last_step_at ?? null, pace: row.bg_pace ?? null,
      } satisfies BgState;
    },
    async takeLease(fy, untilMs, nowMs) {
      /* One UPDATE with the condition in its WHERE: Postgres re-checks it on the locked row, so of two
         passes at once only one gets a row back. */
      const r = await (mine(runs().update({ bg_lease_until: iso(untilMs) }), fy)
        .or(`bg_lease_until.is.null,bg_lease_until.lt."${iso(nowMs)}"`)
        .select("tenant_id") as Res<Array<{ tenant_id: string }>>);
      return must(r, "the Zoho read").length === 1;
    },
    async touch(fy, step) {
      /* Renew only OUR lease (same value we set): 0 rows back = another pass holds it now. */
      const r = await (mine(runs().update({ bg_last_step_at: iso(step.nowMs), bg_pace: step.pace, bg_lease_until: iso(step.toMs) }), fy)
        .eq("bg_lease_until", iso(step.fromMs)).select("tenant_id") as Res<Array<{ tenant_id: string }>>);
      return must(r, "the Zoho read").length === 1;
    },
    async release(fy, end) {
      const patch: Record<string, unknown> = { bg_lease_until: null, bg_error: end.error, bg_pace: end.pace };
      if (end.finished) { patch.bg_requested_at = null; patch.bg_finished_at = iso(end.nowMs); }
      const r = await (mine(runs().update(patch), fy).eq("bg_lease_until", iso(end.leaseUntilMs)) as Res);
      if (r.error) throw new Error("Could not save the Zoho read.");
    },
  };
}

export interface RequestedRead { tenantId: string; kind: FyReadKind; fy: string }

/** Cron: every company's asked-for reads, oldest ask first (the cron filters by its gate). */
export async function listRequestedReads(db: FyImportDb, limit = 50): Promise<RequestedRead[]> {
  const r = await (db.from("zoho_fy_scan_runs").select("tenant_id, kind, fy")
    .not("bg_requested_at", "is", null).order("bg_requested_at", { ascending: true }).limit(limit) as Res<Array<{ tenant_id: string; kind: FyReadKind; fy: string }>>);
  return must(r, "the asked-for Zoho reads").map((x) => ({ tenantId: x.tenant_id, kind: x.kind, fy: x.fy }));
}
