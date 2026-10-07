import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* R-324 (after R-273's marketing-copy-english test): the Cash Flow runway block said
   "Bank mein ₹… — kitne din chalega?", "Agar ab koi paisa na aaye", "Tight — receivables
   jaldi collect karo…". App UI copy is short plain English. A ratchet over every source
   file in this folder; comments and tests are out of scope. Text only — no calculation
   changes. */
const DIR = join(process.cwd(), "src/app/(app)/accounting/cash-flow");

const HINGLISH = /\b(nahi|nahin|karo|karein|kar do|kijiye|dabao|chuno|likho|kholo|dekho|banao|jodo|hatao|daalo|bharo|tarikh|mahin[ae]|mahina|hai|hain|ho gaya|abhi|baaki|wala|wale|wali|kuch|Koi|koi|sab|aapka|aapke|pehle|phir|mein|chahiye|naya|nayi|yahan|kaise|kya|saath|liye|ka|ki|ke|se|par|tak|ko|aur|jab|raha|rahi|rahe|hota|hoti|hoga|jaata|wajah|farq|[Pp]ichhle|kitna|kitne|[Kk]itne|sirf|bhi|gaya|mat|dobara|jaise|[Aa]gar|[Pp]aisa|aaye|chale|chalega|kharcha|badh|ghat|jaldi|roko|alag|hisaab|aksar|maangta|chhoti|ye|jo)\b/;

/** Source without comments, imports and console lines — what can reach the screen. */
function uiLines(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(import|export \* from)\b/.test(l) && !/console\.(log|warn|error)/.test(l));
}

/** Quoted strings and JSX text on a line. Simple `{expr}` holes are dropped first, so
    JSX text split by an expression ("<b>Bank mein {x}</b> — kitne…") is still seen. */
function textOf(line: string): string {
  let l = line;
  for (let prev = ""; prev !== l; ) { prev = l; l = l.replace(/\{[^{}<>]*\}/g, " "); }
  const parts: string[] = [];
  for (const m of l.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`|'([^'\\]*(?:\\.[^'\\]*)*)'|>([^<>{}]+)</g)) {
    parts.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "");
  }
  /* JSX text continuing after a tag on its own line: "</b> — kitne din chalega?" */
  const tail = l.match(/>([^<>{}]*[A-Za-z][^<>{}]*)$/);
  if (tail) parts.push(tail[1]);
  return parts.join(" | ");
}

const hitsIn = (src: string) => uiLines(src).map(textOf).filter((t) => HINGLISH.test(t)).map((t) => t.trim());

describe("R-324 Cash Flow UI copy is English", () => {
  const files = readdirSync(DIR).filter((n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n));

  it("finds the page", () => {
    expect(files).toContain("page.tsx");
  });

  it("the checker catches the old runway copy (guard against a blind test)", () => {
    const old = [
      `<b>Bank mein {rupee(currentCash)}</b> — kitne din chalega? (pichhle {runway.months} mahine ke hisaab se)`,
      `<div className="x">Agar ab koi paisa na aaye</div>`,
      `{runway.atTrend === null ? "Paisa badh raha hai" : <>≈ {fmtMonths(runway.atTrend)} mahine</>}`,
      `{tight && <p className="text-xs text-rose mt-2">Tight — receivables jaldi collect karo ya non-essential kharcha roko.</p>}`,
    ];
    for (const line of old) expect(hitsIn(line), line).not.toEqual([]);
  });

  for (const f of files) {
    it(`${f} has no Hinglish on screen`, () => {
      expect(hitsIn(readFileSync(join(DIR, f), "utf8"))).toEqual([]);
    });
  }
});
