/**
 * R-1656 — §24 ratchet for IN-PAGE error panels: a screen must never print the raw
 * `error.message` (Postgres / RPC / fetch text) as its body. R-1137 covers toasts; this
 * covers the panels — `{error.message}`, `body={error.message}`, `{(q.error as Error).message}`.
 *
 * The fix is `<LoadError>` / `<LoadErrorInline>` (components/shared/load-error.tsx), which
 * maps the error to plain words with a next step and keeps the raw text in the console.
 *
 * The count can only go DOWN: fix an old site → lower BASELINE by the same number.
 */
import { describe, it, expect } from "vitest";
import { join, relative } from "path";
import { readdirSync, readFileSync } from "fs";

/** `{x.message}` where x's name says it is an error — but not `${…}` inside a template string. */
const RAW_RENDER = /(?<!\$)\{\s*\(?\s*[\w.?!]*(?:error|err|Error|Err)\b[\w.?!]*\s*(?:as\s+(?:Error|any)\s*)?\)?\s*\??!?\.message\s*\}/g;

function countRawRenders(source: string): number {
  const noJsxComments = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  return noJsxComments.match(RAW_RENDER)?.length ?? 0;
}

function scan(root: string): { files: number; perFile: Record<string, number>; total: number } {
  const perFile: Record<string, number> = {};
  let files = 0;
  let total = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsx") && !/\.test\./.test(e.name)) {
        files++;
        const n = countRawRenders(readFileSync(p, "utf8"));
        if (n) { perFile[relative(root, p).replace(/\\/g, "/")] = n; total += n; }
      }
    }
  };
  walk(root);
  return { files, perFile, total };
}

/** Measured 24 Oct 2026 (R-1656): 39 before batch 1; batch 1 (6 sites on the 8 money screens — payments and quotes were already clean) → 33. */
const BASELINE = 33;

/** Batch 1 — the money screens. Each stays at zero. */
const BATCH_1 = [
  "app/(app)/accounting/day-book/page.tsx",
  "app/(app)/accounting/trial-balance/page.tsx",
  "app/(app)/accounting/cash-flow/page.tsx",
  "app/(app)/accounting/google-bill-check/page.tsx",
  "app/(app)/invoices/page.tsx",
  "app/(app)/payments/page.tsx",
  "app/(app)/quotes/page.tsx",
  "app/(app)/subscriptions/page.tsx",
] as const;

describe("R-1656 — the matcher", () => {
  it("catches the raw shapes", () => {
    expect(countRawRenders(`<p>Could not: {(q.error as Error).message}</p>`)).toBe(1);
    expect(countRawRenders(`<EmptyState body={error.message} />`)).toBe(1);
    expect(countRawRenders(`<p>{err?.message}</p>`)).toBe(1);
  });
  it("leaves alone the safe shapes", () => {
    expect(countRawRenders("toast.error(`${describeError(error).message} Open it.`)")).toBe(0);
    expect(countRawRenders("title={`Failed: ${error.message}`}")).toBe(0);
    expect(countRawRenders(`<td title={leak.message} />`)).toBe(0);
    expect(countRawRenders(`<LoadErrorInline what="Day Book" error={q.error} onRetry={r} />`)).toBe(0);
  });
});

describe("R-1656 — raw error.message on the page can only go down", () => {
  const { files, perFile, total } = scan(join(process.cwd(), "src"));

  it(`at most ${BASELINE} raw renders across src/**/*.tsx`, () => {
    expect(files).toBeGreaterThan(300); // an empty scan must not pass quietly
    expect(
      total,
      `Raw error.message renders: ${total} (limit ${BASELINE}). Use <LoadError>/<LoadErrorInline error={…}> ` +
      `instead. Files: ${JSON.stringify(perFile, null, 1)}`,
    ).toBeLessThanOrEqual(BASELINE);
  });

  it.each(BATCH_1)("%s has none", (file) => {
    expect(perFile[file] ?? 0).toBe(0);
  });
});
