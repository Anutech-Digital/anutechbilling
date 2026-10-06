import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* R-261 (after R-216 / R-246): the accounting pages still showed Hinglish ("Farq hai",
   "11 tarikh tak", "Koi bank account nahi") and developer words ("Phase 2", "Stub",
   "Mock fallback"), and printed raw ISO dates ("As of 2026-10-06"). App UI copy is short
   plain English; dates go through formatDate. Comments are out of scope. Only text changes —
   no sums or rules. */
const FILES = [
  "src/lib/accounting/month-close.ts",
  "src/app/(app)/accounting/close/page.tsx",
  "src/app/(app)/accounting/banking/page.tsx",
  "src/app/(app)/accounting/banking/brs/page.tsx",
  "src/app/(app)/accounting/pnl/page.tsx",
  "src/app/(app)/accounting/day-book/page.tsx",
  "src/app/(app)/accounting/trial-balance/page.tsx",
  "src/app/(app)/accounting/tds-receivable/page.tsx",
];

const HINGLISH = /\b(nahi|karo|karein|kar do|tarikh|mahin[ae]|Farq|hai|hain|ho gaya|ho chuki|abhi|baaki|Baaki|bharo|banao|dekho|wala|wale|kuch|Koi|sab|Sab|tum|aakhir|apne aap|saabit|kharch[ea]|kharcho|judi|bani|bhi|warna|pehle|phir|jodo|mein|ka|ki|ke|se|par|tak)\b/;
const DEV_WORDS = /\b(Phase 2|Stub|Mock fallback|mock fallback|TODO)\b/;

/** Source without comments, imports and console lines — what can reach the screen. */
function uiLines(file: string): string[] {
  return readFileSync(join(process.cwd(), file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(import|export \* from)\b/.test(l) && !/console\.(log|warn|error)/.test(l));
}

/** Only the quoted strings and JSX text on a line — never identifiers like `ka` in code. */
function textOf(line: string): string {
  const parts: string[] = [];
  for (const m of line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`|'([^'\\]*(?:\\.[^'\\]*)*)'|>([^<>{}]+)</g)) {
    parts.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
  }
  /* A JSX text line on its own (no quotes, no code). */
  if (parts.length === 0 && /^\s*[A-Za-z][^=;(){}]*$/.test(line) && !/^\s*(return|const|let|if|else|case|default)\b/.test(line)) parts.push(line);
  return parts.join(" | ");
}

describe("R-261 accounting UI copy is English", () => {
  for (const f of FILES) {
    it(`${f} has no Hinglish or developer words on screen`, () => {
      const hits = uiLines(f)
        .map((l) => textOf(l))
        .filter((t) => HINGLISH.test(t) || DEV_WORDS.test(t))
        .map((t) => t.trim());
      expect(hits).toEqual([]);
    });
  }

  it("no raw ISO date is printed (As of / up to / tak + yyyy-mm-dd value)", () => {
    for (const f of FILES) {
      const src = uiLines(f).join("\n");
      expect(src, f).not.toMatch(/(As of|as of|up to|until)\s*\{(?!formatDate)[^}]*\}/);
    }
  });
});
