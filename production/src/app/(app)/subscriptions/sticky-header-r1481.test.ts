// R-1481 (Hitesh, staging 17 Oct 2026): scrolling down /subscriptions hid the column
// names. The desktop tables sat inside Card flush's `overflow-x-auto` box — an overflow
// box that never scrolls vertically, so a sticky header inside it could not stick to the
// page either. Each desktop table now gets its own scroll box (overflow-auto + max-h,
// the same pattern as /payments and /quotes) and a sticky thead on a solid token
// background above the rows. Scan test: reads page.tsx, because the page is too large
// (queries, dialogs, sheets) to render in jsdom for a class check.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(
  path.join(process.cwd(), "src/app/(app)/subscriptions/page.tsx"),
  "utf8",
);

/** Every `<thead ...>` opening tag, with the 200 characters of markup before it. */
function theads(text: string): { tag: string; before: string }[] {
  const out: { tag: string; before: string }[] = [];
  const re = /<thead\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({ tag: m[0], before: text.slice(Math.max(0, m.index - 200), m.index) });
  }
  return out;
}

describe("R-1481 — /subscriptions table header stays visible while scrolling", () => {
  const heads = theads(src);

  it("has the two desktop tables (subscriptions + trials)", () => {
    expect(heads.length).toBe(2);
  });

  it.each([0, 1])("thead #%i is sticky at top-0 with a solid bg token above the rows", (i) => {
    const cls = heads[i].tag;
    expect(cls).toMatch(/\bsticky\b/);
    expect(cls).toMatch(/\btop-0\b/);
    expect(cls).toMatch(/\bz-10\b/);
    expect(cls).toMatch(/\bbg-paper-2\b/);
    // no translucent background — rows must not show through the header
    expect(cls).not.toMatch(/bg-paper-2\/\d+/);
  });

  it.each([0, 1])("table #%i scrolls inside its own box, so sticky has something to stick to", (i) => {
    const before = heads[i].before;
    expect(before).toMatch(/overflow-auto max-h-\[calc\(100vh-15rem\)\]/);
  });

  it("mobile card list is unchanged — no sticky header there", () => {
    const mobile = src.match(/<ul className="xl:hidden space-y-2 mb-3">/);
    expect(mobile).not.toBeNull();
  });
});
