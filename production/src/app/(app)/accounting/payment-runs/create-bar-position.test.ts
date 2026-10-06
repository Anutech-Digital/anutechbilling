import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* R-298: the payment-run "create" bar sat at a hard-coded bottom-16 (64px) on phones while the
   bottom tab bar is var(--bottom-nav-h) = 56px + the home-indicator inset (app layout, R-268).
   On an iPhone the bar slid UNDER the tab bar and the "Create payment run" button was half
   hidden. Same anchor as the FAB, bulk bar and quote-builder bar. */
const src = readFileSync(join(process.cwd(), "src/app/(app)/accounting/payment-runs/page.tsx"), "utf8");
const bar = src.slice(src.indexOf("Sticky create bar"), src.indexOf("Create payment run"));

describe("payment-run create bar sits on the shared bottom nav height (R-298)", () => {
  it("finds the bar", () => {
    expect(bar.length).toBeGreaterThan(0);
  });

  it("no hard-coded bottom-16", () => {
    expect(bar).not.toMatch(/\bbottom-16\b/);
  });

  it("lifts above --bottom-nav-h on phones and sits at 0 from md", () => {
    expect(bar).toContain("bottom-[var(--bottom-nav-h,56px)]");
    expect(bar).toMatch(/\bmd:bottom-0\b/);
  });

  it("adds the home-indicator inset only where the bar touches the screen edge (md+)", () => {
    // On phones --bottom-nav-h already carries env(safe-area-inset-bottom); adding it again
    // left a tall empty strip under the buttons.
    expect(bar).not.toMatch(/style=\{\{\s*paddingBottom/);
    expect(bar).toContain("md:pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]");
  });
});
