/**
 * R-1133 — no NEW hand-written quote discount maths (23 Oct 2026).
 *
 * The quote-level discount has one home: taxableAfterDiscount() in lib/quotes/amounts.ts —
 * the same Math.round(S × p / 100) that SQL generate_invoice puts on the tax invoice. Copies
 * written by hand drifted into a second formula, Math.round(S × (p / 100)), which is ₹1 off
 * at the .5 edges (see discount-formula.characterization.test.ts).
 *
 * This scan walks src/ and counts, per file, lines that round a product with a discount pct
 * divided by 100. BASELINE is today's copies (all Form A), waiting on the decision written on
 * card R-1133. Rules:
 *   - a file NOT in BASELINE with a hit fails → call taxableAfterDiscount() instead;
 *   - a file with MORE hits than its BASELINE count fails;
 *   - a file with FEWER hits fails too → delete/lower its BASELINE line (the list only shrinks).
 * When the decision lands and every Form A copy moves to the helper, BASELINE becomes {}.
 *
 * Line-level discounts (l./it./line.discount_pct — per-line, before the subtotal) are a
 * different number and not counted.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const BASELINE: Readonly<Record<string, number>> = {
  "src/app/(app)/quotes/page.tsx": 2,
  "src/app/(app)/quotes/[id]/page.tsx": 1,
  "src/app/(app)/quotes/[id]/pay-intent.ts": 1,
  "src/app/(public)/quote/[id]/accept/quote-accept-view.tsx": 1,
  "src/app/api/quotes/[id]/send/route.ts": 1,
  "src/app/api/whatsapp/send/route.ts": 1,
  "src/app/dev/pdf-test/page.tsx": 1,
  "src/components/features/quotes/quote-action-bar.tsx": 1,
  "src/lib/pdf/build-props.ts": 1,
  "src/lib/quotes/foreign-totals.ts": 1,
  "src/lib/quotes/quote-from-enquiry.ts": 1,
  "src/lib/quotes/quote-pdf-attachment.ts": 1,
  "src/lib/quotes/send-auto-quote.ts": 1,
};

/** The one place the formula may be written. */
const HOME = "src/lib/quotes/amounts.ts";

/** Math.round( … * … discount_pct / discountPct … / 100 — both Form A and Form B. */
const HAND_WRITTEN = /Math\.round\([^;]*\*[^;]*\b[A-Za-z_.]*[dD]iscount_?[pP]ct\b[^;]*\/\s*100/;
const LINE_LEVEL = /\b(?:l|it|line)\.discount_pct\b/;

function discountCopyHits(source: string): number {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
    .split(/\r?\n/)
    .filter((l) => HAND_WRITTEN.test(l) && !LINE_LEVEL.test(l)).length;
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") yield* walk(p); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield p;
  }
}

describe("R-1133 discount copies ratchet", () => {
  const root = process.cwd();
  const found: Record<string, number> = {};
  for (const abs of walk(join(root, "src"))) {
    const rel = relative(root, abs).split("\\").join("/");
    if (rel === HOME) continue;
    const n = discountCopyHits(readFileSync(abs, "utf8"));
    if (n > 0) found[rel] = n;
  }

  it("no new hand-written quote discount — use taxableAfterDiscount() from lib/quotes/amounts", () => {
    const over: Record<string, string> = {};
    for (const [f, n] of Object.entries(found)) {
      const allowed = BASELINE[f] ?? 0;
      if (n > allowed) over[f] = `${n} copies, baseline ${allowed}`;
    }
    expect(over).toEqual({});
  });

  it("the baseline only shrinks — lower or delete a line once its copy is gone", () => {
    const stale: Record<string, string> = {};
    for (const [f, allowed] of Object.entries(BASELINE)) {
      const n = found[f] ?? 0;
      if (n < allowed) stale[f] = `${n} copies left, baseline says ${allowed}`;
    }
    expect(stale).toEqual({});
  });

  it("the scan sees both forms and skips line-level discounts", () => {
    expect(discountCopyHits("const d = Math.round(subtotal * (discountPct / 100));")).toBe(1);
    expect(discountCopyHits("const t = s - Math.round((s * (q.discount_pct ?? 0)) / 100);")).toBe(1);
    expect(discountCopyHits("x: S - Math.round(S * discountPct / 100),")).toBe(1);
    expect(discountCopyHits("s + Math.round(gross * ((l.discount_pct ?? 0) / 100))")).toBe(0);
    expect(discountCopyHits("// Math.round(subtotal * (discountPct / 100))")).toBe(0);
    expect(discountCopyHits("const t = taxableAfterDiscount(subtotal, discountPct);")).toBe(0);
  });
});
