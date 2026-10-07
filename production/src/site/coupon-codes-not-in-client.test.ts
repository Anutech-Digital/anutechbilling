/**
 * R-329 (7 Oct 2026): R-225 took the coupon code names off the cart page's HTML, but the
 * code table (site/lib/money COUPONS) was still imported by the cart page and the cart
 * provider, so every code shipped in the public JS bundle — one "view source" away.
 *
 * The codes now live only on the server (lib/checkout/coupons, `server-only`); the cart asks
 * POST /api/public/cart-coupon whether a typed code is valid. This walks the import graph
 * of every client entry that touches the cart and fails if any file in it names a code.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { COUPONS } from "@/lib/checkout/coupons";

const SRC = path.resolve(__dirname, "..");
const ENTRIES = [
  "app/(marketing)/cart/page.tsx",
  "app/(marketing)/checkout/page.tsx",
  "site/components/cart/CartProvider.tsx",
  "site/components/cart/CartDrawer.tsx",
  "site/lib/money.ts",
];

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function clientGraph(): Map<string, string> {
  const seen = new Map<string, string>();
  const todo = ENTRIES.map((e) => path.join(SRC, e));
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file) || !/\.(ts|tsx)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    seen.set(file, text);
    // Type-only imports never reach the bundle.
    const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const r = resolveImport(file, m[1] ?? m[2]);
      if (r) todo.push(r);
    }
  }
  return seen;
}

describe("coupon codes never reach the browser (R-329)", () => {
  const codes = [...new Set(["ANUTECH10", "MIGRATE15", ...Object.keys(COUPONS)])];

  it("the cart's client import graph names no coupon code", () => {
    const graph = clientGraph();
    expect(graph.size).toBeGreaterThan(ENTRIES.length); // the walk really followed imports
    const leaks: string[] = [];
    for (const [file, text] of graph) {
      for (const c of codes) if (text.toUpperCase().includes(c)) leaks.push(`${path.relative(SRC, file)}: ${c}`);
    }
    expect(leaks).toEqual([]);
  });

  it("the code table is server-only", () => {
    const text = fs.readFileSync(path.join(SRC, "lib/checkout/coupons.ts"), "utf8");
    expect(text).toMatch(/^import "server-only";/m);
  });
});
