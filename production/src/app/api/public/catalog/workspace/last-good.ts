/**
 * R-703: the catalog endpoint keeps the last price list it read successfully and serves it
 * when the database cannot be reached, instead of 503.
 *
 * Live 9–10 Oct 2026: 847 × 503 from this route — every one a `ConnectTimeoutError
 * api.anutech.in:443`. Each took ~40 s to fail (postgrest-js retries a read 3 times, 10 s
 * connect timeout each) while the website gives up after 6 s (site/lib/live-catalog.ts), so
 * the website showed its typed fallback prices and Cloud Run logged a 503 for nothing.
 *
 * Now:
 *   · the read gets READ_BUDGET_MS; past that, a remembered list is served at once (the read
 *     keeps going and refreshes the memory if it finally answers);
 *   · a remembered list older than MAX_STALE_MS is not served — prices that old may have
 *     been edited, and 503 tells the website "use your fallback", which is the honest answer;
 *   · no remembered list (fresh instance + DB down) → 503 as before.
 * Per instance memory only: nothing new to store, nothing to invalidate on a price edit (a
 * successful read always replaces it).
 */

export const READ_BUDGET_MS = 5_000;
export const MAX_STALE_MS = 24 * 60 * 60 * 1000;

export interface Remembered<T> {
  value: T;
  at: number;
}

let memory: Remembered<unknown> | null = null;

export function remember<T>(value: T, now = Date.now()): void {
  memory = { value, at: now };
}

/** The remembered list if it is young enough to serve, else null. */
export function recall<T>(now = Date.now()): Remembered<T> | null {
  if (!memory) return null;
  if (now - memory.at > MAX_STALE_MS) return null;
  return memory as Remembered<T>;
}

export function forgetForTests(): void {
  memory = null;
}

export const TIMED_OUT = Symbol("timed-out");

/** Resolve with the promise, or TIMED_OUT after `ms` — the promise itself keeps running. */
export function withBudget<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, budget]).finally(() => clearTimeout(timer));
}
