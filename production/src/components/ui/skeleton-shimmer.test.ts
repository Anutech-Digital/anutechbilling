// R-832: every <Skeleton> sat still while loading (looked frozen) because the
// `shimmer` keyframes it animates with were never emitted into the CSS.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const skeleton = readFileSync(join(process.cwd(), "src/components/ui/skeleton.tsx"), "utf8");

describe("Skeleton placeholders animate", () => {
  it("Skeleton uses the skeleton-shimmer class", () => {
    expect(skeleton).toContain("skeleton-shimmer");
  });

  it("globals.css defines the keyframes .skeleton-shimmer runs on", () => {
    const rule = css.match(/\.skeleton-shimmer\s*\{[^}]*animation:\s*([\w-]+)/);
    expect(rule, ".skeleton-shimmer has no animation").toBeTruthy();
    const name = rule![1];
    expect(css).toMatch(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  });

  it("stops the shimmer for prefers-reduced-motion", () => {
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.skeleton-shimmer\s*\{\s*animation:\s*none/,
    );
  });
});
