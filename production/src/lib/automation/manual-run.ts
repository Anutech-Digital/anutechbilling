/**
 * R-1104: "Run now" / "Retry" from /automation — the in-process marker that a cron pass was
 * started by a person, for ONE company.
 *
 * Only server code can set it (an AsyncLocalStorage, not a header or a query parameter), so a
 * request from outside can never claim to be a manual run. gatedCron() reads it to work on the
 * caller's company only; recordRun() reads it to write who pressed the button into the history.
 *
 * Kept on globalThis: the /api/automation/jobs/run route loads the cron route modules itself,
 * and both must see the same store even if the bundler gives them separate module copies.
 */
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export interface ManualRun {
  tenantId: string;
  userId: string;
  trigger: "manual" | "retry";
  /** The failed run this retries (trigger "retry"). */
  retryOf: string | null;
}

const KEY = Symbol.for("resellersos.automation.manualRun");
const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<ManualRun> | undefined>;
const store: AsyncLocalStorage<ManualRun> = (g[KEY] ??= new AsyncLocalStorage<ManualRun>());

/** Runs `fn` as a manual run for one company. */
export function runManually<T>(m: ManualRun, fn: () => Promise<T>): Promise<T> {
  return store.run(m, fn);
}

/** The manual run this code is inside, or null (a scheduled run, or not a cron at all). */
export function currentManualRun(): ManualRun | null {
  return store.getStore() ?? null;
}
