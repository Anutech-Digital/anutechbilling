import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/* R-306 (after R-292 / R-296): two Hinglish strings sat outside those cards' locks — the Prepaid
   channel picker ("Channel nahi chuna") and the My attendance toast ("Aaj ki attendance already
   complete hai"). App UI copy is short plain English. Same checker as R-292: comments, imports and
   console lines are out of scope; a `customer-language` line may stay in the customer's language. */
const FILES = ["src/app/(app)/accounting/prepaid/page.tsx", "src/lib/queries/my-attendance.ts"].map((f) => join(process.cwd(), f));

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

describe("R-306 prepaid + my-attendance UI copy is English", () => {
  const files = FILES;

  it("shows the two strings in plain English", () => {
    expect(readFileSync(files[0], "utf8")).toContain(">No channel<");
    expect(readFileSync(files[1], "utf8")).toContain("Today's attendance is already complete.");
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
