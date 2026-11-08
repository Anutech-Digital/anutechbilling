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
 *     a crashed pass's lease runs out (LEASE_EXTRA_MS after its budget) and the next pass carries on;
 *   - Zoho busy / rate limit (429) → the pass stops, the request stays — the next tick carries on;
 *   - access token (R-1757 cache) asked for before every step, so one that expires mid-run is
 *     re-minted; a 401 drops it and retries once; a second 401 in a row stops with "reconnect";
 *   - any other Zoho refusal stops the read with Zoho's message (the owner must act);
 *   - a database / network hiccup is kept as the last error and retried by the next pass.
 * Zoho is only READ. Nothing is imported here — Check + Import stay the owner's buttons (R-2501).
 * The store (bg-store.ts) filters every read / write by tenant + kind + FY (CLAUDE.md §17c).
 */
import { ZohoApiError } from "../api";
import { FY_CALLS_PER_REQUEST } from "../config";
import type { FyReadKind, ZohoFyDocDetail } from "../fy-fetch";
import type { PaceEntry } from "../zoho-pace";
import { scanStep, type ScanFacts, type ScanStore } from "./scan";

/** A pass's lease outlives its budget by this much (a slow last call); after it, a dead pass's run is free. */
export const LEASE_EXTRA_MS = 90_000;

export const RECONNECT_MESSAGE = "Zoho Books did not let ResellerOS read customer payments — Settings → Integrations → Zoho Books → Reconnect, then Allow. Then press Read from Zoho again.";

export interface BgState {
  requestedAt: string | null;
  leaseUntil: string | null;
  error: string | null;
  finishedAt: string | null;
  lastStepAt: string | null;
}

/** The background fields of ONE company's run (tenant + kind are bound by the store). */
export interface BgStore {
  /** Ask for the read (keeps what is already read — resumes). Clears an old error / finish. */
  request(fy: string, userId: string): Promise<void>;
  readBg(fy: string): Promise<BgState | null>;
  /** Take the lease if nobody holds it (or theirs ran out). True = this pass runs. */
  takeLease(fy: string, untilMs: number, nowMs: number): Promise<boolean>;
  /** The pass moved (lastStepAt) — called after each scanStep. */
  touch(fy: string, nowMs: number): Promise<void>;
  /** Let go of OUR lease (leaseUntilMs = what takeLease set; a pass whose lease was taken over writes nothing). finished → the request ends. */
  release(fy: string, end: { finished: boolean; error: string | null; nowMs: number; leaseUntilMs: number }): Promise<void>;
}

/** What a pass needs to reach Zoho for this company. `error` = not connected / no org (the owner must act). */
export type ZohoAccess =
  | { orgId: string; token: () => Promise<string>; dropToken: () => Promise<void> }
  | { error: string };

export type PassOutcome = "complete" | "busy" | "time" | "stopped" | "retry" | "locked" | "not-requested";

export interface PassResult { outcome: PassOutcome; listed: number; detailed: number; calls: number; error: string | null }

export interface PassDeps<F extends ScanFacts> {
  store: ScanStore<F>;
  bg: BgStore;
  kind: FyReadKind;
  toFacts: (d: ZohoFyDocDetail) => F;
  fy: string;
  access: () => Promise<ZohoAccess>;
  /** How long this pass may read (the route's own time limit, minus a margin). */
  budgetMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  /** Only run a pass when the read was asked for (cron). The dialog's own pass asks first. */
  requireRequest?: boolean;
}

export async function runBackgroundRead<F extends ScanFacts>(d: PassDeps<F>): Promise<PassResult> {
  const now = d.now ?? Date.now;
  const empty = async (outcome: PassOutcome, error: string | null = null): Promise<PassResult> => {
    const c = await d.store.counts(d.fy);
    return { outcome, ...c, calls: 0, error };
  };

  if (d.requireRequest !== false) {
    const s = await d.bg.readBg(d.fy);
    if (!s?.requestedAt) return empty("not-requested", s?.error ?? null);
  }
  const start = now();
  const deadline = start + Math.max(1_000, d.budgetMs);
  const leaseUntilMs = deadline + LEASE_EXTRA_MS;
  if (!(await d.bg.takeLease(d.fy, leaseUntilMs, start))) return empty("locked");

  let calls = 0;
  let outcome: PassOutcome = "time";
  let error: string | null = null;
  let finished = false;
  const history: PaceEntry[] = [];
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
          r = await scanStep(d.store, d.kind, d.toFacts, z.orgId, token, d.fy,
            { history, maxCalls: FY_CALLS_PER_REQUEST, now: d.now, sleep: d.sleep }, d.fetch ?? fetch);
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
        await d.bg.touch(d.fy, now());
        if (r.complete) { outcome = "complete"; finished = true; break; }
        if (r.busy) { outcome = "busy"; break; }
      }
    }
  } catch (e) {
    if (e instanceof ZohoApiError) {
      /* The owner must act (reconnect, scope, Zoho refused): stop the read with the reason. */
      outcome = "stopped"; finished = true;
      error = e.status === 401 || e.code === "reconnect" ? RECONNECT_MESSAGE : (e.message || "Zoho Books refused the read.").slice(0, 400);
    } else {
      /* Database / network hiccup: say so, keep the request — the next pass carries on. */
      outcome = "retry";
      error = "The read paused on a server error; it carries on by itself in a minute.";
    }
  } finally {
    await d.bg.release(d.fy, { finished, error, nowMs: now(), leaseUntilMs });
  }
  const c = await d.store.counts(d.fy);
  return { outcome, ...c, calls, error };
}
