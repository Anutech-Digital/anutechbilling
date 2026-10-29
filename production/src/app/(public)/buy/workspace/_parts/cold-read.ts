/**
 * R-2024 / R-2027 (27 Oct 2026): the buy page's server reads (the website company's brand, the
 * Google Workspace price list) on a cold start. One short read used to be the only try, so the
 * first visitor after a server start got a neutral header (R-2024) or typed fallback prices
 * (R-2027). Both reads now share these two pieces:
 *
 *   readWithRetry — tries with a growing pause between them, all inside one budget (~6 s);
 *   lastGoodCache — the last good answer per tenant id, used only when every try failed, and
 *                   only while it is young; never an entry of another tenant id.
 *
 * Server only (process memory). Nothing here knows what is read — the callers log each failed
 * try with its duration and decide what "no answer" means for them.
 */

export type ReadOutcome<T> = { ok: true; value: T } | { ok: false };

export interface RetryPlan {
  /** The timeout of each try, in order (ms). */
  tries: readonly number[];
  /** The pause before try n+1 is pauseMs × n — a backoff. */
  pauseMs: number;
}

/** Every try plus every pause — the longest the page waits for this read. */
export function retryBudgetMs(plan: RetryPlan): number {
  let total = 0;
  plan.tries.forEach((t, i) => { total += t + (i > 0 ? plan.pauseMs * i : 0); });
  return total;
}

/** A try that would get less than this is not worth starting. */
const MIN_TRY_MS = 250;

export async function readWithRetry<T>(
  attempt: (timeoutMs: number, tryNo: number) => Promise<ReadOutcome<T>>,
  plan: RetryPlan,
): Promise<ReadOutcome<T>> {
  const budget = retryBudgetMs(plan);
  const started = Date.now();
  for (let i = 0; i < plan.tries.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, plan.pauseMs * i));
    const left = budget - (Date.now() - started);
    if (i > 0 && left <= MIN_TRY_MS) break;
    const out = await attempt(i === 0 ? plan.tries[0] : Math.min(plan.tries[i], left), i + 1);
    if (out.ok) return out;
  }
  return { ok: false };
}

export interface LastGoodCache<T> {
  /** This tenant's last good value if younger than the TTL, else undefined. */
  get(tenantId: string): { value: T; ageMs: number } | undefined;
  set(tenantId: string, value: T): void;
  delete(tenantId: string): void;
  clear(): void;
}

export function lastGoodCache<T>(ttlMs: number): LastGoodCache<T> {
  const m = new Map<string, { value: T; at: number }>();
  return {
    get(tenantId) {
      const hit = m.get(tenantId);
      if (!hit) return undefined;
      const ageMs = Date.now() - hit.at;
      return ageMs <= ttlMs ? { value: hit.value, ageMs } : undefined;
    },
    set(tenantId, value) { m.set(tenantId, { value, at: Date.now() }); },
    delete(tenantId) { m.delete(tenantId); },
    clear() { m.clear(); },
  };
}
