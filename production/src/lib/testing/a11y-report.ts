/**
 * R-2564 (7 Nov 2026) — the a11y counter's `--json` report for the a11y guard tests, in-process.
 *
 * a11y-ratchet, a11y-r303, a11y-r309, billing-screens-a11y and ink4-contrast-ratchet each spawned
 * `node scripts/a11y-count.mjs --json` — a fresh node process walking and reading every .tsx — so a
 * push built the same report five times (ink4 alone 12 s in the loaded pool). Same function, same
 * walk and scan, now read through the shared always-fresh cache (source-cache.ts). Test-only.
 */
// @ts-expect-error — plain .mjs ops script, no types
import { a11yReportJson } from "../../../scripts/a11y-count.mjs";
import { readSource } from "./source-cache";

export type A11yHit = { file: string; kind: string; lines: number[] };
export type A11yReport = { totals: Record<string, Record<string, number>>; detail: Record<string, A11yHit[]> };

/** The working tree's report, exactly what `node scripts/a11y-count.mjs --json` prints (parsed). */
export function a11yReport(): A11yReport {
  return a11yReportJson({ read: readSource }) as A11yReport;
}
