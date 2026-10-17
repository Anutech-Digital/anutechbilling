// R-1408: pages and the Claim & merge form follow production/CLAUDE.md §20 widths.
//
// Pawan, staging AI Help, 12 Oct 2026: content widths varied page to page — /team sat at
// 1500px and /ux-insights at 1100px while /dashboard and the other listing pages use
// `max-w-[1800px] mx-auto` (§20: listing 1800px, detail/form 1240px; /settings already
// uses 1240px). On /team the "Claim a colleague" form stretched across the whole page on
// wide screens, and the email box carried its helper line inside the bottom-aligned row,
// so the box, the Role select and the button did not line up.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("R-1408 — §20 page widths", () => {
  it("/team uses the listing width", () => {
    const src = read("app/(app)/team/page.tsx");
    expect(src).toContain("mx-auto max-w-[1800px]");
    expect(src).not.toContain("max-w-[1500px]");
  });

  it("/ux-insights uses the listing width", () => {
    const src = read("components/features/insights/insights-view.tsx");
    expect(src).toContain("max-w-[1800px] mx-auto");
    expect(src).not.toContain("max-w-[1100px]");
  });
});

describe("R-1408 — Claim a colleague form", () => {
  const src = read("components/features/team/claim-colleague-card.tsx");

  it("has a sensible max width instead of stretching on wide screens", () => {
    expect(src).toMatch(/<Card className="[^"]*\bmax-w-3xl\b[^"]*">/);
  });

  it("keeps the email helper outside the bottom-aligned input row", () => {
    const input = src.match(/<Input\s+id="claim-email"[\s\S]*?\/>/);
    expect(input).not.toBeNull();
    expect(input![0]).not.toContain("helper=");
    expect(src).toContain("The exact address they sign in with.");
  });
});
