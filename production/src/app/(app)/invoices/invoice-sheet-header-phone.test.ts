// R-202 (6 Oct 2026): on a 375px phone the invoice preview (/invoices?open=<id>) came out
// 446px wide. The sheet header kept "View quote", "WhatsApp" and "PDF" in one `shrink-0`
// row that never wrapped, so the PDF button sat off the right edge and the whole sheet
// scrolled sideways — which also cut off the R-187 preview dialog opened from that button.
// The fix is layout only: the header and its button group wrap on a phone, and from `sm`
// up (where the 576px sheet has room) the buttons stay on one line exactly as before.
// jsdom has no layout engine, so this guards the classes that produce the wrap; the
// visual check at 375px is done in the browser.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/(app)/invoices/page.tsx"), "utf8");

function classOf(tagStart: number): string {
  const tag = src.slice(tagStart, src.indexOf(">", tagStart) + 1);
  return tag.match(/className="([^"]*)"/)?.[1] ?? "";
}

function header(): { row: string; identity: string; actions: string } {
  const start = src.indexOf("<SheetHeader");
  expect(start, "invoice sheet header not found").toBeGreaterThan(-1);
  const end = src.indexOf("</SheetHeader>", start);
  const block = src.slice(start, end);
  const actionsAt = block.indexOf("data-invoice-actions");
  expect(actionsAt, "button group must carry data-invoice-actions").toBeGreaterThan(-1);
  const identityAt = block.indexOf("<div", block.indexOf(">") + 1);
  return {
    row: classOf(start),
    identity: classOf(start + identityAt),
    actions: classOf(start + block.lastIndexOf("<div", actionsAt)),
  };
}

describe("invoice preview sheet header on a phone", () => {
  it("wraps the header row so the buttons can drop below the invoice number", () => {
    expect(header().row).toMatch(/\bflex-wrap\b/);
  });

  it("lets the invoice number/customer block shrink instead of pushing the row wider", () => {
    expect(header().identity).toMatch(/\bmin-w-0\b/);
  });

  it("wraps the button group so PDF never goes off-screen", () => {
    const { actions } = header();
    expect(actions).toMatch(/\bflex-wrap\b/);
    // a bare shrink-0 is what forced the 446px width; only sm and up may keep it
    expect(actions).not.toMatch(/(^|\s)shrink-0\b/);
  });

  it("keeps the desktop layout: one row of buttons from sm up", () => {
    const { row, actions } = header();
    expect(row).toMatch(/\bsm:flex-nowrap\b/);
    expect(actions).toMatch(/\bsm:flex-nowrap\b/);
    expect(actions).toMatch(/\bsm:shrink-0\b/);
  });
});
