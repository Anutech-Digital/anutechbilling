// R-187 (6 Oct 2026): at phone width (~375–580px) the sticky toolbar above the Tax Invoice
// and Receipt Voucher previews kept every button on one line, so "Download PDF" was cut to
// "Downl…" off the right edge and the title broke over three lines. The fix is layout only:
// the toolbar and its button group wrap, and the title never breaks. jsdom has no layout
// engine, so this guards the classes that produce the wrap; the visual check was done in the
// browser at 375px and 580px.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "src/components/features/quotes");

function toolbar(file: string): { row: string; title: string; actions: string } {
  const src = readFileSync(join(dir, file), "utf8");
  const start = src.indexOf("sticky top-0 z-10 print:hidden");
  expect(start, `${file}: toolbar not found`).toBeGreaterThan(-1);
  const rowLineStart = src.lastIndexOf("<div", start);
  const row = src.slice(rowLineStart, src.indexOf(">", start) + 1);
  const rest = src.slice(start);
  const titleMatch = rest.match(/<span className="([^"]*)">\s*(Tax Invoice|Receipt Voucher)/);
  expect(titleMatch, `${file}: toolbar title not found`).not.toBeNull();
  const actionsMatch = rest.match(/<div className="([^"]*)" data-toolbar-actions/);
  return { row, title: titleMatch?.[1] ?? "", actions: actionsMatch?.[1] ?? "" };
}

describe.each(["tax-invoice-dialog.tsx", "receipt-voucher-dialog.tsx"])("%s preview toolbar on a phone", (file) => {
  it("wraps the toolbar row so the buttons can drop to a second line", () => {
    expect(toolbar(file).row).toMatch(/\bflex-wrap\b/);
  });

  it("wraps the button group so Download PDF is never pushed off-screen", () => {
    const { actions } = toolbar(file);
    expect(actions).toMatch(/\bflex\b/);
    expect(actions).toMatch(/\bflex-wrap\b/);
  });

  it("keeps the title on one line", () => {
    expect(toolbar(file).title).toMatch(/\bwhitespace-nowrap\b/);
  });
});
