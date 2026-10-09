/**
 * A second website's hosting is added from the cart (9 Oct 2026, Pawan: "why can't user buy
 * more than one hosting in sidebar cart?"). Several plans per order work since R-032; the cart
 * said "1 per order" with a locked "+". Now "+" adds another plan as its own line.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { addsAnotherLine, isSingleUnit, lineDisplayLabel, singleUnitNote } from "@/site/lib/money";

describe("hosting lines in the cart", () => {
  const h = (key: string, sku = "hosting:standard") => ({ key, label: "Standard hosting", sku });
  it("say '1 per website', never '1 per order'", () => {
    expect(singleUnitNote({ sku: "hosting:standard" })).toBe("1 per website");
    expect(singleUnitNote({ sku: "domain:in" })).toBe("1 per domain");
  });
  it("a hosting line's + adds another line; a domain or trial line's does not", () => {
    expect(addsAnotherLine({ sku: "hosting:standard" })).toBe(true);
    expect(addsAnotherLine({ sku: "domain:in" })).toBe(false);
    expect(addsAnotherLine({ sku: "hosting-trial:starter" })).toBe(false);
    expect(isSingleUnit({ sku: "hosting:standard" })).toBe(true); // each line stays quantity 1
  });
  it("repeated plans are numbered, a single one is not", () => {
    const lines = [h("a"), h("b"), h("c", "hosting:plus")];
    expect(lineDisplayLabel(lines, lines[0])).toBe("Standard hosting · 1");
    expect(lineDisplayLabel(lines, lines[1])).toBe("Standard hosting · 2");
    expect(lineDisplayLabel(lines, lines[2])).toBe("Standard hosting");
    expect(lineDisplayLabel([h("a")], h("a"))).toBe("Standard hosting");
  });
  it.each(["src/site/components/cart/CartDrawer.tsx", "src/app/(marketing)/cart/page.tsx"])("%s wires + to addAnother and numbers the lines", (f) => {
    const src = readFileSync(f, "utf8");
    expect(src).toContain("another ? cart.addAnother(l.key) : cart.setQty(l.key, 1)");
    expect(src).toContain("disabled={locked && !another}");
    expect(src).toContain("Add another ${l.label} for another website");
    expect(src).toContain("lineDisplayLabel(cart.lines, l)");
  });
  it("the provider inserts the copy right after the line, as quantity 1", () => {
    const src = readFileSync("src/site/components/cart/CartProvider.tsx", "utf8");
    expect(src).toMatch(/const addAnother = useCallback\(\(key: string\) => \{[\s\S]*qty: 1, key:[\s\S]*prev\.slice\(0, i \+ 1\), copy, \.\.\.prev\.slice\(i \+ 1\)/);
  });
});
