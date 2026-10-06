// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, cleanup } from "@testing-library/react";
import { Sheet, SheetContent, SheetTitle } from "./sheet";

afterEach(() => cleanup());

/* R-291: a side sheet given a fixed width (className="w-96" = 384px) ran off a 375px phone —
   the close button and the right edge of every field were outside the screen. Left/right
   sheets now cap at the viewport width whatever width the caller asks for. */
describe("Sheet — never wider than the phone (R-291)", () => {
  it.each(["left", "right"] as const)("%s sheet caps at 100vw", (side) => {
    render(
      <Sheet open>
        <SheetContent side={side} className="w-96" aria-describedby={undefined}>
          <SheetTitle>Panel</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.className).toContain("max-w-[100vw]");
    expect(panel.className).toContain("w-96");
  });
});

/* The quote builder's sticky action bar: same --bottom-nav-h as the FAB and bulk bar (R-268),
   and its z-index / negative margin must be two classes — "z-20-mx-4" was one unknown class,
   so the bar had no z-index and no bleed, and slid under other content on phones. */
describe("quote-builder bottom bar (R-291)", () => {
  const src = readFileSync("src/components/features/quotes/quote-builder.tsx", "utf8");
  it("sits on the shared --bottom-nav-h, not a hard-coded 56px", () => {
    expect(src).toContain("bottom-[calc(var(--bottom-nav-h,56px))]");
    expect(src).not.toContain("bottom-[calc(56px+env(safe-area-inset-bottom))]");
  });
  it("has no glued class names", () => {
    expect(src).not.toMatch(/z-\d+-m[xy]-/);
  });
});
