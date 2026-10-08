import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/* R-273 (after R-216 / R-246 / R-261): the marketing screens (IndiaMART, WhatsApp, Google
   Business, Ads, Lead finder, Campaigns…) still showed Hinglish labels, hints and toasts
   ("Naya campaign", "Koi lead nahi"). App UI copy is short plain English. A ratchet over the
   WHOLE folder, so a new marketing page cannot bring it back. Comments, tests and AI chat
   text are out of scope; a message template the CUSTOMER receives may stay in their language
   and is marked on its line with `customer-language`.
   R-296: src/lib/marketing too — readiness labels, skip reasons, reconcile notes and the tool
   catalog's "why" are built there and rendered by these pages. */
const ROOTS = [join(process.cwd(), "src/app/(app)/marketing"), join(process.cwd(), "src/lib/marketing")];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

const HINGLISH = /\b(nahi|nahin|karo|karein|kar do|kijiye|dabao|dabaiye|chuno|likho|bhejo|kholo|dekho|banao|jodo|hatao|daalo|bharo|tarikh|mahin[ae]|hai|hain|ho gaya|ho gayi|abhi|baaki|Baaki|wala|wale|wali|kuch|Koi|koi|sab|Sab|aapka|aapke|Aapka|apne aap|pehle|Pehle|phir|mein|chahiye|naya|Naya|nayi|Nayi|yahan|wahan|kaise|kya|Kya|ek baar|saath|liye|ka|ki|ke|se|par|tak|ko|aur|jab|raha|rahi|rahe|hota|hoti|hoga|jaata|jaati|jaayega|jaayegi|wajah|Wajah|Farq|farq|pichhle|Khatam|kitna|kitne|Kitne|sirf|Sirf|bhi|gaya|gaye|mat|Haan|haan|dobara|neeche|upar|Upar|Chal|Jaise|jaise|Har|har|Kab|kab|Kis|kis|Jo|jo|Jis|jis|Ye|ye|uska|unka|apna|Apna)\b/;

/** Source without comments, imports and console lines — what can reach the screen. */
function uiLines(file: string): string[] {
  /* The marker is read BEFORE comments are stripped, so a trailing `// customer-language`
     on a template line counts (R-296: review and unsubscribe text the customer receives). */
  return readFileSync(file, "utf8")
    .replace(/^.*customer-language.*$/gm, "")
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
  if (parts.length === 0 && /^\s*[A-Za-z][^=;(){}]*$/.test(line) && !/^\s*(return|const|let|if|else|case|default)\b/.test(line)) parts.push(line);
  return parts.join(" | ");
}

describe("R-273 marketing UI copy is English", () => {
  const files = ROOTS.flatMap((r) => walk(r));

  it("finds the marketing pages and their lib", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.includes(join("src", "lib", "marketing")))).toBe(true);
  });

  for (const f of files) {
    it(`${relative(process.cwd(), f)} has no Hinglish on screen`, () => {
      const hits = uiLines(f)
        .map((l) => textOf(l))
        .filter((t) => HINGLISH.test(t))
        .map((t) => t.trim());
      expect(hits).toEqual([]);
    });
  }
});
