/**
 * R-2265 (Design D5) — one primary (amber) button per view on the Quotes, Invoices and
 * Companies LIST pages. The 31 Oct design audit counted 25 amber buttons on Quotes and 10 on
 * Invoices: every row's next step was primary, so the eye could not find the page's own one.
 *
 * Rule: with rows on screen, the only `variant="primary"` button is the page's main CTA
 * (New quote / New invoice / Add company). Row actions, the selection bar and side cards use
 * the quiet `default` (or `outline`) variant. An empty-state call-to-action is allowed: it
 * renders only when there are no rows.
 *
 * jsdom has no layout and these pages pull ~30 data hooks each, so — like the R-2264 guard —
 * this reads the page source: every primary occurrence is listed with its label and must be
 * the page CTA (in the header, or a mutually exclusive branch of it) or inside an EmptyState.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Files may be checked out with CRLF on Windows — compare on LF. */
const read = (f: string): string => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

type Hit = { at: number; label: string; inEmptyState: boolean };

/** Source with comments blanked out (same length, so indexes stay true). */
function stripComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, p: string) => p + " ".repeat(m.length - p.length));
}

/** Every primary button/variant in the file: `variant="primary"`, `variant: "primary"`, or a
 *  `variant={…"primary"…}` expression. */
function primaries(file: string): Hit[] {
  const src = stripComments(read(file));
  const re = /variant(?:=\{[^}]*"primary"[^}]*\}|="primary"|:\s*"primary")/g;
  const hits: Hit[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const at = m.index;
    const close = src.indexOf("</Button>", at);
    const raw = close > -1 && close - at < 1200 ? src.slice(at, close) : "";
    // Button text: drop the rest of the opening tag (up to its `>`, not an arrow's `=>`),
    // then any inner tags such as <Link>.
    const label = raw
      .replace(/^[\s\S]*?[^=]>/, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Inside an EmptyState's props: an `<EmptyState` opened before it whose self-closing
    // `/>` (on the line at the same indent) has not come yet.
    const es = src.lastIndexOf("<EmptyState", at);
    const indent = es > -1 ? (/[ \t]*$/.exec(src.slice(0, es))?.[0] ?? "") : "";
    const between = es > -1 ? src.slice(es, at) : "";
    const inEmptyState = es > -1 && at - es < 2000 && !between.includes(`\n${indent}/>`) && !between.includes("</EmptyState>");
    hits.push({ at, label, inEmptyState });
  }
  return hits;
}

/** Primaries that can show while rows are on screen (empty states excluded). */
function withRows(file: string): Hit[] {
  return primaries(file).filter((h) => !h.inEmptyState);
}

const QUOTES = "src/app/(app)/quotes/page.tsx";
const INVOICES = "src/app/(app)/invoices/page.tsx";
const CUSTOMERS = "src/app/(app)/customers/page.tsx";

describe("R-2265 — one primary per list view", () => {
  it("Quotes: only New quote is primary (one per view: the subscription or the project branch)", () => {
    const hits = withRows(QUOTES);
    expect(hits.map((h) => h.label)).toEqual(["{COPY.newQuote}", "{COPY.newQuote}"]);
    // The two are the two sides of ONE header ternary, so a render shows exactly one.
    const src = read(QUOTES);
    const between = src.slice(hits[0].at, hits[1].at);
    expect(src.slice(hits[0].at - 200, hits[0].at)).toContain('view === "project" ?');
    expect(between).toMatch(/\)\s*:\s*\(/);
  });

  it("Invoices: only New invoice is primary — Record payment, Generate and the bulk Generate are not", () => {
    expect(withRows(INVOICES).map((h) => h.label)).toEqual(["New invoice"]);
  });

  it("Companies: only the header Add company is primary — the toolbar copy is not", () => {
    expect(withRows(CUSTOMERS).map((h) => h.label)).toEqual(["Add company"]);
  });

  it("every row / bar action is still there (labels kept, only the colour changed)", () => {
    const q = read(QUOTES);
    for (const label of ["Show these quotes", ">Send<", "WhatsApp", "Generate invoice", "Record payment", "Continue billing", "Re-quote"]) {
      expect(q).toContain(label);
    }
    const inv = read(INVOICES);
    for (const label of ["Record payment", "Generate {pendingSelected.size}", "Generate invoice for ", "Generate\n"]) {
      expect(inv).toContain(label);
    }
    const c = read(CUSTOMERS);
    expect(c.match(/Add company\n/g)?.length).toBe(2);
  });

  it("the guard itself sees a primary in a row (self-check)", () => {
    // If the regex stopped matching, every test above would pass on an amber page.
    expect(primaries(QUOTES).length).toBeGreaterThanOrEqual(2);
    expect(primaries(INVOICES).some((h) => h.label === "New invoice")).toBe(true);
  });
});
