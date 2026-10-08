import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/* R-292 (after R-273): My attendance (/attendance/me) and Assessments still showed Hinglish
   labels, hints and toasts. App UI copy is short plain English. Same checker as R-273: comments,
   imports and console lines are out of scope; a string the CUSTOMER receives may stay in their
   language when its line says `customer-language`. */
const FILES = ["src/app/(app)/attendance/me", "src/app/(app)/assessments"].flatMap((d) => walk(join(process.cwd(), d)));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p);
    return /.tsx?$/.test(n) && !/.test.tsx?$/.test(n) ? [p] : [];
  });
}

const HINGLISH = /\b(nahi|nahin|karo|karein|kar do|kijiye|dabao|dabaiye|chuno|likho|bhejo|kholo|dekho|banao|jodo|hatao|daalo|bharo|tarikh|mahin[ae]|hai|hain|ho gaya|ho gayi|abhi|baaki|Baaki|wala|wale|wali|kuch|Koi|koi|sab|Sab|aapka|aapke|Aapka|apne aap|pehle|Pehle|phir|mein|chahiye|naya|Naya|nayi|Nayi|yahan|wahan|kaise|kya|Kya|ek baar|saath|liye|ka|ki|ke|se|par|tak|ko|aur|jab|raha|rahi|rahe|hota|hoti|hoga|jaata|jaati|jaayega|jaayegi|wajah|Wajah|Farq|farq|pichhle|Khatam|kitna|kitne|Kitne|sirf|Sirf|bhi|gaya|gaye|mat|Haan|haan|dobara|neeche|upar|Upar|Chal|Jaise|jaise|Har|har|Kab|kab|Kis|kis|Jo|jo|Jis|jis|Ye|ye|uska|unka|apna|Apna)\b/;

/** Source without comments, imports and console lines — what can reach the screen. */
function uiLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(import|export \* from)\b/.test(l) && !/console\.(log|warn|error)/.test(l))
    .filter((l) => !/customer-language/.test(l));
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

describe("R-292 attendance + assessments UI copy is English", () => {
  const files = FILES;

  it("finds both pages", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
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
