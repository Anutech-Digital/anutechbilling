/**
 * R-2607 — the FY read (fy-import/scan.ts) runs on the SERVER, not in an open browser tab.
 *
 * Before: the dialog called "read" in a loop (20 Zoho calls, wait, again) — a 2,576-payment year
 * took ~35 min with the tab open and in front; a frozen / replaced tab stopped it at 87/2,576.
 * Now: the dialog ASKS for the read (request) and only shows progress; a server pass
 * (runBackgroundRead) — from the cron "zoho-fy-read" every minute, and from the open dialog — takes
 * the run's LEASE, calls scanStep again and again under Zoho's pace until the year is read or its
 * time is up, and lets go. Progress is the stored scan (saved after every Zoho call), so a crash or
 * restart carries on from the last saved page / detail.
 *
 *   - one pass per company + list + year: the lease is a conditional update (two passes → one wins);
 *     every step renews it (LEASE_EXTRA_MS ahead) only while it is still ours, so a slow step never
 *     lets a second pass in; a crashed pass's lease runs out and the next pass carries on;
 *   - Zoho's pace (80 calls / min) holds ACROSS passes: the last minute's calls are saved with the
 *     run (bg_pace) and the next pass — cron or dialog — starts from them;
 *   - Zoho busy / rate limit (429) → the pass stops, a full minute is marked as used (the next pass
 *     waits it out), the request stays;
 *   - access token (R-1757 cache) asked for before every step, so one that expires mid-run is
 *     re-minted; a 401 drops it and retries once; a second 401 in a row stops with "reconnect";
 *   - Zoho down / slow / network / token endpoint busy (5xx, network, token_error) → kept, retried;
 *     any other Zoho refusal stops the read with Zoho's message (the owner must act);
 *   - a server error is logged and retried by the next pass — but a read that has not moved for
 *     STUCK_MS stops with the reason (never an endless silent loop).
 * Zoho is only READ. Nothing is imported here — Check + Import stay the owner's buttons (R-2501).
 * The store (bg-store.ts) filters every read / write by tenant + kind + FY (CLAUDE.md §17c).
 */
import { ZohoApiError } from "../api";
import { FY_CALLS_PER_REQUEST } from "../config";
import type { FyReadKind, ZohoFyDocDetail } from "../fy-fetch";
import { PACE_WINDOW_MS, ZOHO_CALLS_PER_MIN, type PaceEntry } from "../zoho-pace";
import { scanStep, type ScanFacts, type ScanStore } from "./scan";

/** The lease always reaches this far past the pass's last step (a slow step + pace wait fit in it). */
export const LEASE_EXTRA_MS = 150_000;
/** A read whose last progress is older than this, with errors since, stops (with the reason). */
export const STUCK_MS = 30 * 60_000;

export const RECONNECT_MESSAGE = "Zoho Books did not let ResellerOS read customer payments — Settings → Integrations → Zoho Books → Reconnect, then Allow. Then press Read from Zoho again.";
export const RETRY_MESSAGE = "The read paused on an error; it carries on by itself in a minute.";

export interface BgState {
  requestedAt: string | null;
  leaseUntil: string | null;
  error: string | null;
  finishedAt: string | null;
  lastStepAt: string | null;
  /** The last minute's Zoho calls of this run (pace across passes). */
  pace?: PaceEntry[] | null;
}

/** The background fields of ONE company's run (tenant + kind are bound by the store). */
export interface BgStore {
  /** Ask for the read (keeps what is already read — resumes). Clears an old error / finish. */
  request(fy: string, userId: string): Promise<void>;
  readBg(fy: string): Promise<BgState | null>;
  /** Take the lease if nobody holds it (or theirs ran out). True = this pass runs. */
  takeLease(fy: string, untilMs: number, nowMs: number): Promise<boolean>;
  /** The pass moved: lastStepAt + pace saved, lease `fromMs` renewed to `toMs` — only while it is still
   *  ours (false = another pass holds it now: stop, write nothing more). */
  touch(fy: string, step: { nowMs: number; pace: PaceEntry[]; fromMs: number; toMs: number }): Promise<boolean>;
  /** Let go of OUR lease (leaseUntilMs = what we last set; a pass whose lease was taken over writes nothing). finished → the request ends. */
  release(fy: string, end: { finished: boolean; error: string | null; nowMs: number; leaseUntilMs: number; pace: PaceEntry[] }): Promise<void>;
}

/** What a pass needs to reach Zoho for this company. `error` = not connected / no org (the owner must act). */
export type ZohoAccess =
  | { orgId: string; token: () => Promise<string>; dropToken: () => Promise<void> }
  | { error: string };

export type PassOutcome = "complete" | "busy" | "time" | "stopped" | "retry" | "locked" | "lost" | "not-requested";

export interface PassResult { outcome: PassOutcome; listed: number; detailed: number; calls: number; error: string | null }

export interface PassDeps<F extends ScanFacts> {
  store: ScanStore<F>;
  bg: BgStore;
  kind: FyReadKind;
  toFacts: (d: ZohoFyDocDetail) => F;
  fy: string;
  access: () => Promise<ZohoAccess>;
  /** How long this pass may START new steps (the route's own time limit, minus a margin). */
  budgetMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  /** Only run a pass when the read was asked for (cron). The dialog's own pass asks first. */
  requireRequest?: boolean;
  log?: (msg: string) => void;
}

/** Zoho trouble that passes by itself (down, slow, network, token endpoint busy): retry, keep the request. */
export function isTransientZoho(e: ZohoApiError): boolean {
  return e.code === "network" || e.code === "token_error" || (e.status ?? 0) >= 500;
}

/** The last minute's entries only (what the pace looks at). */
export function recentPace(p: PaceEntry[] | null | undefined, nowMs: number): PaceEntry[] {
  return (Array.isArray(p) ? p : [])
    .filter((x) => x && Number.isFinite(x.at) && Number.isFinite(x.calls) && x.at > nowMs - PACE_WINDOW_MS && x.at <= nowMs + PACE_WINDOW_MS)
    .map((x) => ({ at: x.at, calls: Math.max(0, Math.min(ZOHO_CALLS_PER_MIN, Math.floor(x.calls))) }));
}

export async function runBackgroundRead<F extends ScanFacts>(d: PassDeps<F>): Promise<PassResult> {
  const now = d.now ?? Date.now;
  const log = d.log ?? ((m: string) => console.error(m));
  const counted = async (outcome: PassOutcome, calls: number, error: string | null): Promise<PassResult> => {
    const c = await d.store.counts(d.fy);
    return { outcome, ...c, calls, error };
  };

  const before = await d.bg.readBg(d.fy);
  if (d.requireRequest !== false && !before?.requestedAt) return counted("not-requested", 0, before?.error ?? null);
  const start = now();
  const deadline = start + Math.max(1_000, d.budgetMs);
  let lease = start + Math.max(1_000, d.budgetMs) + LEASE_EXTRA_MS;
  if (!(await d.bg.takeLease(d.fy, lease, start))) return counted("locked", 0, null);

  let calls = 0;
  let outcome: PassOutcome = "time";
  let error: string | null = null;
  let finished = false;
  let lost = false;
  const history: PaceEntry[] = recentPace(before?.pace, start);
  try {
    const z = await d.access();
    if ("error" in z) {
      outcome = "stopped"; error = z.error; finished = true;
    } else {
      let retried401 = false;
      while (now() < deadline) {
        let r;
        try {
          const token = await z.token();
          /* Fewer calls near the deadline, so the last step ends close to it. */
          const maxCalls = Math.max(1, Math.min(FY_CALLS_PER_REQUEST, Math.floor((deadline - now()) / 1_000)));
          r = await scanStep(d.store, d.kind, d.toFacts, z.orgId, token, d.fy,
            { history, maxCalls, now: d.now, sleep: d.sleep }, d.fetch ?? fetch);
        } catch (e) {
          if (e instanceof ZohoApiError && e.status === 401 && !retried401) {
            /* R-1757: the cached token was refused — drop it; the next step mints a fresh one. */
            retried401 = true;
            await z.dropToken();
            continue;
          }
          throw e;
        }
        retried401 = false;
        calls += r.calls;
        const t = now();
        if (r.busy) history.push({ at: t, calls: ZOHO_CALLS_PER_MIN }); /* Zoho said slow down: the next pass waits a full minute */
        const next = t + LEASE_EXTRA_MS;
        if (!(await d.bg.touch(d.fy, { nowMs: t, pace: recentPace(history, t), fromMs: lease, toMs: next }))) { lost = true; outcome = "lost"; break; }
        lease = next;
        if (r.complete) { outcome = "complete"; finished = true; break; }
        if (r.busy) { outcome = "busy"; break; }
      }
    }
  } catch (e) {
    if (e instanceof ZohoApiError && !isTransientZoho(e)) {
      /* The owner must act (reconnect, scope, Zoho refused): stop the read with the reason. */
      outcome = "stopped"; finished = true;
      error = e.status === 401 || e.code === "reconnect" ? RECONNECT_MESSAGE : (e.message || "Zoho Books refused the read.").slice(0, 400);
    } else {
      /* Zoho down / network / a server error: log it, keep the request — the next pass carries on.
         A read that has not moved for STUCK_MS stops with the reason instead of looping silently. */
      const why = (e as Error)?.message ?? String(e);
      log(`[zoho-fy-read] ${d.kind} ${d.fy}: ${why}`);
      outcome = "retry";
      error = RETRY_MESSAGE;
      const movedAt = Date.parse(before?.lastStepAt ?? before?.requestedAt ?? "");
      if (calls === 0 && Number.isFinite(movedAt) && now() - movedAt > STUCK_MS) {
        outcome = "stopped"; finished = true;
        error = `The read stopped: no progress for 30 minutes (${why.slice(0, 200)}). Press Read from Zoho to try again.`;
      }
    }
  } finally {
    if (!lost) await d.bg.release(d.fy, { finished, error, nowMs: now(), leaseUntilMs: lease, pace: recentPace(history, now()) });
  }
  return counted(outcome, calls, error);
}
