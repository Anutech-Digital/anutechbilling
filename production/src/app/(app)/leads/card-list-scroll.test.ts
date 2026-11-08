/**
 * A page that clips its own height must give every list inside it a way to scroll.
 *
 * ─── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 * /leads sets a fixed viewport height with `overflow-hidden` on its root wrapper, because
 * the Kanban board needs a bounded box to scroll columns inside. The Kanban branch and the
 * desktop table branch both carried `overflow-y-auto` and worked. The mobile/tablet card
 * list did not — so below `xl` the page rendered all 17 leads and showed two.
 *
 * It failed in the worst possible way: SILENTLY. No scrollbar appeared anywhere, every
 * number on the page was correct, the rows were all in the DOM, and the page just ended.
 * Measured in the running app on 21 Aug 2026 — 3217px of content inside a 666px box, and
 * `document.scrollingElement.scrollHeight === clientHeight`, so nothing could scroll at
 * all. Reported by the owner as "only 2 leads show but it says 17".
 *
 * ─── WHY A SOURCE SCAN AND NOT A RENDER TEST ────────────────────────────────
 * jsdom has no layout engine: it reports every height as 0, so a rendered card list looks
 * identical whether it can scroll or not. The thing that went wrong is a class on an
 * element, and that is what is checked here. Crude, and it would have caught this.
 *
 * A sweep of the running app confirmed /leads was the only page affected — customers,
 * quotes, invoices and payments all let the document scroll instead. This test is scoped
 * to the pages that actually clip, so it stays true rather than becoming a rule nobody
 * can satisfy.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

function pageFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pageFiles(full, out);
    else if (entry.name === "page.tsx") out.push(full);
  }
  return out;
}

/** Page (relative to src/app) → component files that render its responsive card list. */
const RENDERED_LISTS: Record<string, string[]> = {
  "(app)/leads/page.tsx": [join(APP, "..", "..", "components", "features", "leads", "lead-list-view.tsx")],
};

/**
 * Pages whose ROOT wrapper both fixes its height and hides the overflow.
 *
 * Both classes must be UNPREFIXED, and that qualifier is the whole accuracy of this test.
 * The first version asked only "does some line carry both classes", and it flagged
 * customers/page.tsx — whose clipping element is `hidden md:flex … overflow-hidden
 * xl:h-[calc(100vh-200px)]`, an inner panel that is only tall at `xl`, sitting beside a
 * `md:hidden` card list that only exists BELOW md. The two are never on screen together,
 * so it cannot clip that list, and the running page confirmed it: /customers scrolls the
 * document and clips nothing.
 *
 * That false positive mattered more than the miss would have. Someone would have "fixed"
 * a page that was never broken, or deleted the test — and a test people delete protects
 * nothing. A breakpoint-conditional height cannot clip a list that lives at a different
 * breakpoint, so it is not scanned.
 */
function clippingPages(): { file: string; src: string }[] {
  const unprefixedHeight = /(?:^|["\s])h-\[calc\(100vh/;
  const unprefixedHidden = /(?:^|["\s])overflow-hidden/;
  return pageFiles(APP)
    .map((file) => ({
      file,
      /* A page's card list may live in a component it renders (S35 moved /leads' list into
         LeadListView). Those sources are scanned WITH the page, so the list is still held
         to the page's clipping rule instead of escaping it by changing files. */
      src: [file, ...(RENDERED_LISTS[file.replace(/\\/g, "/").split("/app/").pop() ?? ""] ?? [])]
        .map((f) => readSource(f))
        .join("\n"),
    }))
    .filter(({ src }) =>
      src
        .split(/\r?\n/)
        .some((line) => unprefixedHeight.test(line) && unprefixedHidden.test(line)),
    );
}

describe("a page that clips its own height lets its lists scroll", () => {
  const pages = clippingPages();

  it("still finds the page this rule was written for", () => {
    /* If /leads ever stops clipping, this rule may be obsolete — but silence is the wrong
       way to find that out, so the scan proves it is still looking at something. */
    expect(pages.map((p) => p.file.replace(/\\/g, "/")).join("\n")).toMatch(/leads\/page\.tsx/);
  });

  it("still sees /leads' card list, wherever the component lives", () => {
    /* Without this, moving the list into a component would make the two checks below pass
       by scanning nothing for the one page they were written for. */
    const leads = pages.find((p) => p.file.replace(/\\/g, "/").endsWith("(app)/leads/page.tsx"));
    expect(leads?.src).toMatch(/<ul className="(?:xl|lg|md|sm):hidden/);
  });

  it("gives every responsive card list its own vertical scroll", () => {
    const offenders: string[] = [];
    for (const { file, src } of pages) {
      /* The card list on these pages is a <ul> hidden at a breakpoint — `xl:hidden` for a
         table swap, `md:hidden` for a phone/desktop swap. */
      for (const m of src.matchAll(/<ul className="((?:xl|lg|md|sm):hidden[^"]*)"/g)) {
        const classes = m[1];
        if (!/overflow-y-auto|overflow-auto/.test(classes)) {
          offenders.push(`${file}: <ul className="${classes}">`);
        }
      }
    }
    expect(
      offenders,
      "this page clips its own height, so a list without overflow-y-auto is silently cut off — add `flex-1 min-h-0 overflow-y-auto`",
    ).toEqual([]);
  });

  it("pairs that scroll with min-h-0, or flexbox refuses to shrink the box", () => {
    /* `flex-1 overflow-y-auto` without `min-h-0` is the classic near-miss: a flex child's
       default `min-height: auto` keeps it as tall as its content, so it overflows the
       parent instead of scrolling, and the clipping happens one level up exactly as
       before. The scrollbar never appears and the fix looks applied. */
    const offenders: string[] = [];
    for (const { file, src } of pages) {
      for (const m of src.matchAll(/<ul className="((?:xl|lg|md|sm):hidden[^"]*overflow-y-auto[^"]*)"/g)) {
        if (!/min-h-0/.test(m[1])) offenders.push(`${file}: <ul className="${m[1]}">`);
      }
    }
    expect(offenders, "add min-h-0 alongside flex-1 or the list will not shrink").toEqual([]);
  });
});
