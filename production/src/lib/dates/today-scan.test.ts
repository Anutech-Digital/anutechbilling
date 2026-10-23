/**
 * R-1653 — "today" must be the IST day, written one way: `istToday()` from @/lib/dates/ist.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day. IST is UTC+5:30, so anything saved
 * between 00:00 and 05:30 IST got YESTERDAY'S date — a TDS certificate marked received, an
 * expense row, a vault "expires today" check. On the 1st of a month that is the wrong month,
 * and on 1 April the wrong financial year. The ESLint rule (.eslintrc.json, S21) only covers
 * some folders; this scan covers all of src/, so a new one cannot creep in anywhere.
 *
 * Ratchet: the files below still carry one for a reason written next to them. The count may
 * only go DOWN — fixing one means lowering (or deleting) its entry here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");

/** "now" turned into a UTC calendar day: .slice(0,10) / .substring(0,10) / .split("T")[0]. */
const UTC_TODAY = /new Date\(\)\.toISOString\(\)\s*\.\s*(?:slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\)|split\(\s*["'`]T["'`]\s*\)\s*\[\s*0\s*\])/g;

const KNOWN: Record<string, { count: number; why: string }> = {
  "src/app/(app)/payments/page.tsx": { count: 1, why: "CSV file name only; payments page held by another card's lock (R-1634) — next one to fix." },
  "src/app/(app)/subscriptions/page.tsx": { count: 2, why: "CSV file names only, no stored date." },
  "src/components/features/settings/two-factor-card.tsx": { count: 1, why: "Label on the authenticator entry, not a business date." },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "generated") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Code lines only — a comment that explains the bug quotes the pattern on purpose. */
function codeHits(text: string): number {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
    n += (line.match(UTC_TODAY) ?? []).length;
  }
  return n;
}

const hits = new Map<string, number>();
for (const f of walk(SRC)) {
  const n = codeHits(readFileSync(f, "utf8"));
  if (n > 0) hits.set(relative(process.cwd(), f).split(sep).join("/"), n);
}

describe("'today' is istToday(), never the UTC day (R-1653)", () => {
  it("no new `new Date().toISOString().slice(0, 10)` anywhere in src/", () => {
    const over = [...hits].filter(([f, n]) => n > (KNOWN[f]?.count ?? 0)).map(([f, n]) => `${f}: ${n}`);
    expect(over, "Use istToday() from @/lib/dates/ist for today's date (IST), not the UTC day").toEqual([]);
  });

  it("money/accounting code (src/lib/queries, src/app/api) has none at all", () => {
    const money = [...hits.keys()].filter((f) => f.startsWith("src/lib/queries/") || f.startsWith("src/app/api/"));
    expect(money).toEqual([]);
  });

  it("the ratchet only goes down — a fixed file must leave KNOWN", () => {
    const stale = Object.entries(KNOWN).filter(([f, k]) => (hits.get(f) ?? 0) < k.count).map(([f]) => f);
    expect(stale, "lower or delete these KNOWN entries").toEqual([]);
  });

  it("catches the shapes it should, and skips comments", () => {
    expect(codeHits("const d = new Date().toISOString().slice(0, 10);")).toBe(1);
    expect(codeHits("const d = new Date().toISOString().split('T')[0];")).toBe(1);
    expect(codeHits("const d = new Date().toISOString().substring(0,10);")).toBe(1);
    expect(codeHits(" * was `new Date().toISOString().slice(0, 10)` before")).toBe(0);
    expect(codeHits("const d = istToday();")).toBe(0);
  });
});

/* R-1652: the subscription importers write start / renewal dates from a CSV's calendar dates. */
describe("subscription import never turns a calendar date into a UTC day (R-1652)", () => {
  it("components/features/subscriptions has no toISOString().slice(0, 10)", () => {
    const dir = join(SRC, "components", "features", "subscriptions");
    const bad = walk(dir).filter((f) => readFileSync(f, "utf8").split(/\r?\n/).some((l) => {
      const t = l.trim();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) && /toISOString\(\)\.slice\(0,\s*10\)/.test(l);
    }));
    expect(bad.map((f) => relative(process.cwd(), f).split(sep).join("/"))).toEqual([]);
  });
});
