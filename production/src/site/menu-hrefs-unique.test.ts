/**
 * Every item in one website mega-menu panel opens its own place.
 *
 * R-1505 (17 Oct 2026, Pawan on staging, report 240e05d6): two differently-named buttons in one
 * panel opened the same page — "Rate card" and "Transfer in" both /domains#rates, "WHOIS privacy"
 * and "Bulk operations" both /domains#included, five ResellerOS items all /reselleros, and
 * "Reseller program" / "White label" both /reseller. A visitor clicks the second one, lands where
 * the first one took them, and decides the menu is broken.
 *
 * This scan reads MENUS in Header.tsx and fails when two items of one panel share an href.
 * That every "#anchor" exists on its page is pinned by anchor-links.test.ts (R-1506).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HEADER = join(process.cwd(), "src/site/components/chrome/Header.tsx");
const src = readFileSync(HEADER, "utf8");

type Panel = { label: string; items: { label: string; href: string }[] };

function panels(): Panel[] {
  const start = src.indexOf("const MENUS");
  const end = src.indexOf("\n];", start);
  const block = src.slice(start, end);
  // Each panel starts with `label: "X", href: "/y",` on its own line at panel indent.
  const parts = block.split(/\n {4}label:\s*/).slice(1);
  return parts.map((p) => {
    const label = /^"([^"]+)"/.exec(p)?.[1] ?? "?";
    const items = [...p.matchAll(/\{\s*label:\s*"([^"]+)",\s*note:[^\n]*?,\s*href:\s*([^}\n]+?)\s*\}/g)]
      .map((m) => ({ label: m[1], href: m[2].trim() }));
    return { label, items };
  });
}

describe("website mega menu: one panel, one place per item (R-1505)", () => {
  const PANELS = panels();

  it("found every mega-menu panel and its items", () => {
    expect(PANELS.map((p) => p.label)).toEqual(
      ["Custom software", "Domains", "Hosting", "Email & security", "ResellerOS", "Wholesale"],
    );
    for (const p of PANELS) expect(p.items.length, p.label).toBeGreaterThanOrEqual(3);
  });

  it("no two items in one panel open the same href", () => {
    const repeats: string[] = [];
    for (const p of PANELS) {
      const seen = new Map<string, string>();
      for (const it of p.items) {
        const first = seen.get(it.href);
        if (first) repeats.push(`${p.label}: "${first}" and "${it.label}" both → ${it.href}`);
        else seen.set(it.href, it.label);
      }
    }
    expect(repeats).toEqual([]);
  });
});
