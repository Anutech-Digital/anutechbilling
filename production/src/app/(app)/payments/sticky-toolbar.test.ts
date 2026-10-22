// R-1741 follow-up — /payments at 1400px: the shared DataTable header now sticks at top-14
// (just under the app's top bar). The page's own tabs + search toolbar was ALSO sticky at
// top-[56px], so the two stuck on top of each other and covered the first rows. The table
// shows only at xl (cardsBelow="xl"), so the toolbar stays sticky on phone/tablet (cards, no
// sticky header) and scrolls away normally from xl up — like Invoices. jsdom cannot measure
// stickiness, so this pins the classes in the source; the browser check confirms the look.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/app/(app)/payments/page.tsx"), "utf8");

describe("Payments toolbar vs the sticky table header (R-1741)", () => {
  it("the tabs + search toolbar is sticky only below xl, static where the table (and its sticky header) shows", () => {
    const line = src.split("\n").find((l) => l.includes("sticky top-[56px]"));
    expect(line, "toolbar still sticky on phones/tablets").toBeTruthy();
    expect(line).toMatch(/\bxl:static\b/);
  });

  it("the table still switches to cards below xl — the breakpoint the toolbar rule depends on", () => {
    expect(src).toMatch(/noun="payment"\s+cardsBelow="xl"/);
  });
});
