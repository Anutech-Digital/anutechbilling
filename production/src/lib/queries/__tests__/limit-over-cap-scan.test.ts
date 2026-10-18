/**
 * R-1588 — no `.limit(n)` above the gateway's cap ANYWHERE in src/.
 *
 * The data gateway answers at most MAX_ROWS (1000) rows a request — src/server/postgrest/
 * build.ts does `limit = min(limit, MAX_ROWS)` — and says nothing when it cut the answer
 * short. So `.limit(50000)` is a promise the code cannot keep: Ads spend, Google Business
 * metrics, Feedback counts, the AI performance panel, the UX analysis and the Razorpay fee
 * booking all read 1000 rows while their code said 5,000–50,000. money-read-scan.test.ts
 * covers the money files; this covers every file.
 *
 * Page instead: fetchAllRows / fetchAllRowsIn (@/lib/ops/fetch-all) with `.range()` and an
 * order that ends on a unique column, and `{ maxRows }` when a sample cap is the intent.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ROWS } from "@/server/postgrest/build";

/**
 * Over-cap limits that are allowed, each with the reason the read cannot reach the cap.
 * `file` → the exact `.limit(n)` text it may carry. Empty when R-1588 landed — a bounded
 * read needs no `.limit()` above 1000 to begin with.
 */
const ALLOWED: Record<string, { limit: string; why: string }[]> = {};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.posix.join(dir, d.name);
    if (d.isDirectory()) return d.name === "generated" || d.name === "node_modules" ? [] : walk(p);
    return /\.(tsx?|mjs|js)$/.test(d.name) && !/\.test\.|\.spec\./.test(d.name) ? [p] : [];
  });

/** Comments stripped (prose about the old `.limit(5000)` is not a read); line numbers kept. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/^\s*\/\/.*$/gm, "");

/** Every numeric `.limit(n)` (also `1_000`, `.limit(\n 5000 )`) above `cap`. */
function overCapLimits(src: string, cap: number): { line: number; text: string; n: number }[] {
  const out: { line: number; text: string; n: number }[] = [];
  for (const m of strip(src).matchAll(/\.limit\(\s*(\d[\d_]*)\s*[,)]/g)) {
    const n = Number(m[1].replace(/_/g, ""));
    if (n > cap) out.push({ line: src.slice(0, m.index).split("\n").length, text: `.limit(${m[1]})`, n });
  }
  return out;
}

describe(".limit() above the gateway cap (R-1588)", () => {
  it("the cap is the gateway's", () => {
    expect(MAX_ROWS).toBe(1000);
  });

  it("the scan catches the shapes the bug took", () => {
    const src = [
      'supabase.from("ad_spend_daily").select("*").order("day").limit(50000),',
      "  .limit(20_000);",
      "  .limit(\n    5000\n  );",
      "/* the old .limit(9000) */ .limit(1000).limit(25)",
      "// .limit(7000) in a comment",
      "q.limit(LIMIT)",
    ].join("\n");
    expect(overCapLimits(src, MAX_ROWS).map((x) => x.n)).toEqual([50000, 20000, 5000]);
  });

  it("src/: no .limit() above 1000 outside ALLOWED", () => {
    const bad: string[] = [];
    for (const file of walk("src")) {
      const allowed = ALLOWED[file] ?? [];
      for (const hit of overCapLimits(readFileSync(file, "utf8"), MAX_ROWS)) {
        if (allowed.some((a) => a.limit === hit.text)) continue;
        bad.push(`${file}:${hit.line} ${hit.text}`);
      }
    }
    expect(bad, "the gateway returns at most 1000 rows and says nothing — page with fetchAllRows (lib/ops/fetch-all)").toEqual([]);
  });

  it("ALLOWED has no stale entries", () => {
    for (const [file, list] of Object.entries(ALLOWED)) {
      const hits = overCapLimits(readFileSync(file, "utf8"), MAX_ROWS).map((h) => h.text);
      for (const a of list) expect(hits, `${file} no longer has ${a.limit} — drop it from ALLOWED`).toContain(a.limit);
    }
  });
});
