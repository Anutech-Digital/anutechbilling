/**
 * Checkout → /done shows no "The cart is empty" in between (7 Oct 2026, Pawan: "I see a popup
 * … next I see the empty cart, then we get redirected"). Every success path empties the cart
 * just before router.push("/done"); each must first mark the page as leaving, and the leaving
 * view must come before the empty-cart view.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("src/app/(marketing)/checkout/page.tsx", "utf8");

describe("checkout → /done has no empty-cart flash", () => {
  it("every cart.clear() before /done is preceded by setLeaving(…)", () => {
    const clears = [...src.matchAll(/cart\.clear\(\);/g)];
    expect(clears.length).toBeGreaterThanOrEqual(3);
    for (const m of clears) {
      const before = src.slice(Math.max(0, m.index! - 200), m.index!);
      expect(before).toMatch(/setLeaving\("[^"]+"\);\s*$/);
    }
  });

  it("the leaving view renders before the empty-cart view", () => {
    const leavingAt = src.indexOf("if (leaving) {");
    const emptyAt = src.indexOf("if (cart.lines.length === 0) {");
    expect(leavingAt).toBeGreaterThan(-1);
    expect(leavingAt).toBeLessThan(emptyAt);
    expect(src.slice(leavingAt, emptyAt)).toContain('<BusyPanel active variant="modal"');
  });
});
