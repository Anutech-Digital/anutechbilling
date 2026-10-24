// R-1428 (Pawan, staging 17 Oct): "Set company state" opens /settings?tab=company#settings-registered-state
// and useScrollToHash scrolls that <select> to the top of the window — where the sticky topbar
// (h-14 = 56px) covers it and its "Registered state" label. The select now keeps a scroll
// margin taller than the topbar plus the label, so both land in view below the header.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const settings = read("src/app/(app)/settings/page.tsx");
const topbar = read("src/components/layout/topbar.tsx");

/** Tailwind spacing step → px (1 step = 4px). */
const px = (step: string) => Number(step) * 4;

describe("R-1428: the Registered state field is not hidden under the sticky header", () => {
  it("the deep-link target keeps a scroll margin taller than the sticky topbar + its label", () => {
    const header = /<header className="sticky top-0[^"]*\bh-(\d+)\b/.exec(topbar);
    expect(header, "topbar is sticky with a fixed height").toBeTruthy();
    const headerPx = px(header![1]);

    const tag = /<select id="settings-registered-state"[\s\S]*?>/.exec(settings)?.[0] ?? "";
    expect(tag).not.toBe("");
    const mt = /\bscroll-mt-(\d+)\b/.exec(tag);
    expect(mt, "the select carries a scroll-mt-* class").toBeTruthy();
    // header + the label above the select (~20px) + a little air
    expect(px(mt![1])).toBeGreaterThanOrEqual(headerPx + 32);
  });

  it("the setup link still points at that exact field", () => {
    expect(read("src/lib/onboarding/setup-links.ts")).toContain("#settings-registered-state");
  });
});
