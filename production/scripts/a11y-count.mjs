#!/usr/bin/env node
/**
 * a11y-count — measure the four S36 accessibility gaps per owner, so a fix is a number
 * that went down rather than a claim.
 *
 *   node scripts/a11y-count.mjs                  summary per owner
 *   node scripts/a11y-count.mjs --owner pawan    + every hit for that owner (file:line)
 *   node scripts/a11y-count.mjs --json           machine-readable
 *   node scripts/a11y-count.mjs --ref <git-ref>  measure a commit instead of the working tree
 *
 * What is counted (regex over .tsx source; a heuristic, not a parser — read the hits):
 *   label-no-for   <label>/<Label> with no htmlFor that does not WRAP its control
 *                  (a wrapping label is a valid implicit association, so it is not counted)
 *   input-no-name  <input>/<Input>/<textarea>/<Textarea>/<select> with no id, aria-label or
 *                  aria-labelledby, not type="hidden"/"file", and not inside a wrapping label
 *   modal-no-trap  a `fixed inset-0` overlay anywhere but ui/dialog.tsx and ui/sheet.tsx (no focus trap)
 *   ink4-body      text-ink-4 that is not `placeholder:text-ink-4` (ink-4 = #ABA290, 2.4:1 on paper)
 *   small-content  text-2xs / text-3xs / text-[10px] / text-[11px] on an element that is NOT an
 *                  uppercase eyebrow, a pill/badge (rounded + tight padding), a <kbd>, or a counter
 *   small-deco     the same sizes on those decorative elements (reported, left alone by S36)
 *   small-other    the same sizes in a class string that is not on a JSX tag (a lookup table)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { ownerOf } from "./areas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, "..");
const REPO = join(APP, "..");

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

const lineOf = (src, i) => src.slice(0, i).split("\n").length;

/** Opening JSX tag starting at i: returns the text up to the matching `>` (brace-aware). */
function tagAt(src, i) {
  let depth = 0;
  for (let j = i; j < src.length && j < i + 4000; j++) {
    const c = src[j];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i, i + 200);
}

const CONTROL = /<(input|Input|textarea|Textarea|select|Select|SelectTrigger|Checkbox|Switch|MoneyInput|DateInput)\b/;

/** Blank out comments (keeping newlines, so line numbers hold): prose that mentions a
 *  `<select>` is not a select. */
const stripComments = (s) =>
  // Only comments that START a JSX expression or a line — `accept="image/*"` is not one.
  s.replace(/\{\/\*[\s\S]*?\*\/\}|^[ \t]*\/\*[\s\S]*?\*\//gm, (c) => c.replace(/[^\n]/g, " ")).replace(/^(\s*)\/\/.*$/gm, (c, ws) => ws + " ".repeat(c.length - ws.length));

export function scan(raw, path = "") {
  const src = stripComments(raw);
  const hits = { "label-no-for": [], "input-no-name": [], "modal-no-trap": [], "ink4-body": [], "small-content": [], "small-deco": [], "small-other": [] };

  // Wrapping-label spans, so controls inside them count as named.
  const wraps = [];
  for (const m of src.matchAll(/<(label|Label)\b/g)) {
    const tag = tagAt(src, m.index);
    if (tag.endsWith("/>")) continue;
    const close = src.indexOf(`</${m[1]}>`, m.index + tag.length);
    const body = close > 0 ? src.slice(m.index + tag.length, close) : "";
    const wrapsControl = CONTROL.test(body);
    if (wrapsControl) wraps.push([m.index, close]);
    if (!/\bhtmlFor=/.test(tag) && !wrapsControl && !/\{\.\.\./.test(tag)) hits["label-no-for"].push(lineOf(src, m.index));
  }
  // FormField (ui/label) and local <Field label=…> wrappers render a label that only points
  // at the control when htmlFor is passed; without it the label is decoration.
  for (const m of src.matchAll(/<(FormField|Field)\b(?=[\s>])/g)) {
    const tag = tagAt(src, m.index);
    if (tag.endsWith("/>") || /\bhtmlFor=/.test(tag) || !/\blabel=/.test(tag)) continue;
    const close = src.indexOf(`</${m[1]}>`, m.index + tag.length);
    if (close > 0 && CONTROL.test(src.slice(m.index + tag.length, close))) hits["label-no-for"].push(lineOf(src, m.index));
  }
  const inWrap = (i) => wraps.some(([a, b]) => i > a && i < b);

  for (const m of src.matchAll(/<(input|Input|textarea|Textarea|select)\b/g)) {
    const tag = tagAt(src, m.index);
    if (/\b(id|aria-label|aria-labelledby)=/.test(tag)) continue;
    if (/type=["'](hidden|file)["']/.test(tag)) continue;
    if (/\{\.\.\.\w+\}/.test(tag)) continue; // a spread props object may carry the id / aria-label
    if (inWrap(m.index)) continue;
    hits["input-no-name"].push(lineOf(src, m.index));
  }

  // Every full-screen overlay outside the two primitives that trap focus. (A file-level
  // "imports ui/dialog" exemption hid /lead-gen's hand-rolled share sheet — it used Dialog
  // for a different modal on the same page.)
  // R-289: an overlay that IS a Radix primitive's own Overlay/Content tag (e.g. the full-screen
  // image viewer on @radix-ui/react-dialog) traps focus too — judged per tag, never per file.
  if (!/src\/components\/ui\/(dialog|sheet)\.tsx$/.test(path)) {
    for (const m of src.matchAll(/fixed inset-0/g)) {
      const open = src.lastIndexOf("<", m.index);
      const onRadix = open >= 0 && /^<\w+Primitive\.(Overlay|Content)\b/.test(src.slice(open, open + 60))
        && open + tagAt(src, open).length > m.index;
      if (!onRadix) hits["modal-no-trap"].push(lineOf(src, m.index));
    }
  }

  for (const m of src.matchAll(/(^|[^:\w-])text-ink-4\b/g)) hits["ink4-body"].push(lineOf(src, m.index + m[1].length));

  for (const s of smallTextSites(raw)) hits[`small-${s.kind}`].push(lineOf(src, s.index));
  return hits;
}

/** Every sub-12px size class, with its offset and a verdict: "content" (real text S36 lifts
 *  to 12px), "deco" (eyebrow / pill / counter — left alone), "other" (not on a JSX tag). */
export function smallTextSites(raw) {
  const src = stripComments(raw);
  const out = [];
  for (const m of src.matchAll(/text-(2xs|3xs|\[10px\]|\[11px\])(?![\w-])/g)) {
    // The className string the size sits in, and the tag it belongs to.
    const lt = src.lastIndexOf("<", m.index);
    const tag = tagAt(src, lt);
    // A class string in a lookup table / variable, not on the element it styles: which
    // element it lands on is not knowable from here, so it is not judged either way.
    if (lt < 0 || lt + tag.length < m.index) { out.push({ index: m.index, length: m[0].length, kind: "other" }); continue; }
    const deco =
      /\buppercase\b/.test(tag) ||                                        // eyebrow / column header
      (/\brounded(-full|-sm|-md)?\b/.test(tag) && /\bpx-(0\.5|1|1\.5|2)\b/.test(tag) && /\bpy-(0|px|0\.5)\b/.test(tag)) || // pill
      /\b(h|w|size|min-w)-(3|3\.5|4|4\.5|5)\b/.test(tag) ||               // count bubble in a fixed tiny box
      /^<(kbd|sup|sub|Badge|StatusPill)\b/.test(tag) ||
      (/\btabular-nums\b/.test(tag) && /\b(ml-auto|min-w-)/.test(tag));  // trailing counter
    out.push({ index: m.index, length: m[0].length, kind: deco ? "deco" : "content" });
  }
  return out;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).replace(/\\/g, "/") === process.argv[1].replace(/\\/g, "/");
if (isMain) {
  const args = process.argv.slice(2);
  const want = args.includes("--owner") ? args[args.indexOf("--owner") + 1] : null;
  // --ref <git-ref>: measure a commit instead of the working tree (the "before" number).
  const ref = args.includes("--ref") ? args[args.indexOf("--ref") + 1] : null;
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: REPO, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const sources = ref
    ? git(`ls-tree -r --name-only ${ref} production/src`).split("\n")
        .filter((p) => p.endsWith(".tsx") && !p.endsWith(".test.tsx"))
        .map((rel) => [rel, () => git(`show "${ref}:${rel}"`)])
    : walk(join(APP, "src")).map((f) => [relative(REPO, f).replace(/\\/g, "/"), () => readFileSync(f, "utf8")]);
  const totals = {};
  const detail = {};
  for (const [rel, read] of sources) {
    const owner = ownerOf(rel);
    const hits = scan(read(), rel);
    totals[owner] ??= {};
    for (const [k, lines] of Object.entries(hits)) {
      totals[owner][k] = (totals[owner][k] ?? 0) + lines.length;
      if (lines.length && (owner === want || args.includes("--json"))) (detail[owner] ??= []).push({ file: rel, kind: k, lines });
    }
  }
  if (args.includes("--json")) console.log(JSON.stringify({ totals, detail }, null, 2));
  else {
    console.table(totals);
    if (want) for (const d of detail[want] ?? []) console.log(`${d.kind.padEnd(14)} ${d.file}:${d.lines.join(",")}`);
  }
}
