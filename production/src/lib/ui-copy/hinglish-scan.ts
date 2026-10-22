import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/* R-1731 (decision R-1728, 22 Oct 2026): the whole app UI is English. Hinglish is allowed only
   in AI help (components/shared/ai-help.tsx) and in AI prompts / AI-generated replies. This
   scanner reads every .ts/.tsx file under src/app, src/components and (R-1733) src/lib — query
   helpers, API helpers and PDF/tax/payroll helpers put their text on screen too — and reports
   the quoted strings and JSX text that contain common Hinglish words. Comments, imports,
   console lines and regex literals are not screen text and are skipped. Used by the R-246
   ui-copy-english guard test. */

/** Common Hinglish words that never appear in English UI copy. Whole words only: a word inside an
    id or class name ("payroll-kis-mahine-ka") is not screen text. Longer words match in any case;
    the short ones (ka, ki, ke…) only in lower case, so "KA" (Karnataka) is not a hit. */
const LONG_WORDS =
  /(?<![-\w])(nahi|nahin|karo|karein|kariye|kijiye|kiya|kiye|daalo|daaliye|kholo|kholiye|chalu|hataye|hatao|hataya|hata|wapas|kisko|kisne|jaaye|jayega|jaayega|jaayegi|jaayenge|paisa|kharch|kharche|kharcha|liye|hain|ho gaya|ho gayi|abhi|baaki|yahan|wahan|kahan|dekho|dekhiye|dekhein|dikhao|banao|bharo|chuniye|chuno|aapka|aapke|aapki|apna|chahiye|lekin|warna|pehle|jodo|raha|rahi|rahe|rahegi|wala|wale|wali|sabhi|kuch|tarikh|tareekh|mahina|mahine|samajh|wajah|andaza|dabaiye|hisaab|hisab|bataye|batao|gaya|gayi|kaise|kyun|kyon|bina|mein|hoga|hogi|iski|uski|isliye|naam|kaam|aaya|sakte|sakta|lagega|maana|hatega|haath|sirf|likho|bhejein|bhejo|khaali|chhodo|byaaj|chukaya|liya|udhari|jodein|ghatega|layak|chhoote|bharein|chuniye)(?![-\w])/i;
const SHORT_WORDS = /(?<![-\w])(hai|ka|ki|ke|ko|ya|aur|kis|thi|tha|hua|hui|hue|bhi|ye|wo|tak)(?![-\w])/;

export const HINGLISH_UI = { test: (t: string): boolean => LONG_WORDS.test(t) || SHORT_WORDS.test(t) };

/** Files where Hinglish is the intended language: AI help, AI prompts and AI replies, and lists
    that MATCH what people type (customers and staff write Hinglish; the matcher must too). Every
    entry says why. A file with on-screen text never goes here — translate it instead. */
export const HINGLISH_ALLOWED_BY_DESIGN: RegExp[] = [
  /^src\/components\/shared\/ai-help\.tsx$/,                    // AI help chat
  /^src\/app\/api\/ai\//,                                        // AI routes: prompts and AI replies
  /(^|\/)[^/]*prompts?[^/]*\.tsx?$/i,                            // *prompt(s)* files: AI prompt text
  /^src\/lib\/ai\/(app-help|help-data-tools|data-entry)\.ts$/,   // AI help / data-entry prompts
  /^src\/lib\/ai\/public-sales-chat\.ts$/,                       // replies in the visitor's language + keywords
  /^src\/lib\/ai\/(battlecards|disparagement|promise-check|test-trail|tone)\.ts$/, // match typed text
  /^src\/lib\/feedback\/directive\.ts$/,                         // prompt for the fixing AI session
  /^src\/lib\/feedback\/(similar-reports|triage)\.ts$/,          // match words in typed bug reports
  /^src\/lib\/inbound\/(extract|follow-up)\.ts$/,                // match words in customer emails
  /^src\/lib\/marketing\/whatsapp-broadcast\.ts$/,               // opt-out words customers reply with
  /^src\/lib\/leads\/legacy-task-labels\.ts$/,                   // labels saved on old tasks, matched only
];

/** Regex literals that start like a pattern (/\b…/, /^…/, /(?…/) are keyword matchers, not text. */
const REGEX_LITERAL = /\/(?:\\b|\^|\(\?)(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])*\/[dgimsuy]*/g;

/** A template literal's text: each ${expression} becomes just the quoted strings inside it, so
    code such as `hsl(${row.hue}, …)` is not read as text but `${ok ? "" : "nahi"}` still is. */
function templateText(body: string): string {
  return body.replace(/\$\{([^{}]*)\}/g, (_m, e: string) => ` ${(e.match(/"[^"]*"|'[^']*'/g) ?? []).join(" ")} `);
}

/** Source without block/line comments, imports and console lines — what can reach the screen. */
export function uiLines(src: string): string[] {
  return src
    // A JSX comment ends at its OWN first close marker. R-1733: the old lazy match started at any
    // "{" followed by a doc comment (a props type, an object literal) and ran on to the next JSX
    // comment further down, silently dropping all the screen text in between (call-log-dialog).
    .replace(/\{\s*\/\*(?:(?!\*\/)[\s\S])*\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(import|export \* from)\b/.test(l) && !/console\.(log|warn|error|info|debug)/.test(l));
}

/** Only the quoted strings and JSX text on a line — never identifiers in code. */
export function textOf(rawLine: string): string {
  const line = rawLine.replace(REGEX_LITERAL, " ");
  const parts: string[] = [];
  for (const m of line.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`]*)`|'([^'\\]*(?:\\.[^'\\]*)*)'|>([^<>{}]+)</g)) {
    parts.push(m[1] ?? (m[2] !== undefined ? templateText(m[2]) : undefined) ?? m[3] ?? m[4] ?? "");
  }
  /* JSX text next to an {expression}: ">Text {x}" and "{x} more text<". */
  for (const m of line.matchAll(/(?<!=)>([^<>{}"'`]+)\{|\}([^<>{}"'`]+)</g)) {
    const t = m[1] ?? m[2] ?? "";
    if (/[A-Za-z]{2}/.test(t) && !/[;=]|=>|&&|\|\|/.test(t)) parts.push(t);
  }
  /* JSX text that runs past the end of the line ("<p>Some text") or starts a line ("text</p>"). */
  const tail = line.match(/(?<!=)>([^<>{}"'`]+)$/);
  if (tail && /[A-Za-z]{2}/.test(tail[1])) parts.push(tail[1]);
  const head = line.match(/^\s*([A-Za-z][^<>{}=;()"'`]*)<\//);
  if (head) parts.push(head[1]);
  /* A JSX text line on its own (no quotes, no code), with any {expressions} taken out. */
  let bare = line;
  for (let i = 0; i < 3; i++) bare = bare.replace(/\{[^{}]*\}/g, " ");
  const prose = !/[()]/.test(bare) || bare.trim().split(/\s+/).length >= 4;
  /* R-1733: an object-literal property line ("hue: 220," / "sender: x,") is code — its quoted
     strings were already taken above, the keys are not screen text. */
  const objectProp = /^\s*[\w$]+\??\s*:\s.*[,([{]\s*$/.test(bare);
  /* R-1733: JSX text may also start with a digit or ₹ ("20 se zyada …"). */
  if (prose && !objectProp && /^\s*[A-Za-z0-9₹&·—(][^=;{}<>]*$/.test(bare) && !/^\s*(return|const|let|var|if|else|case|default|type|interface|export|function|async|await|throw)\b/.test(bare)) parts.push(bare);
  return parts.join(" | ");
}

/** Screen-text pieces in one file's source that contain Hinglish. */
export function hinglishHits(src: string): string[] {
  return uiLines(src)
    .map((l) => textOf(l))
    .filter((t) => HINGLISH_UI.test(t))
    .map((t) => t.trim());
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
}

/** Every UI source file under src/app, src/components, src/lib and (R-1752) the public website src/site, as "src/..." paths. */
export function uiSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const d of ["src/app", "src/components", "src/lib", "src/site"]) walk(join(root, d), out);
  return out
    .map((p) => relative(root, p).replace(/\\/g, "/"))
    .filter((f) => !HINGLISH_ALLOWED_BY_DESIGN.some((re) => re.test(f)))
    .sort();
}

/** file -> Hinglish hits, only for files that have any. */
export function scanHinglish(root: string): Map<string, string[]> {
  const res = new Map<string, string[]>();
  for (const f of uiSourceFiles(root)) {
    const hits = hinglishHits(readFileSync(join(root, f), "utf8"));
    if (hits.length) res.set(f, hits);
  }
  return res;
}
