/**
 * R-1631 (24 Oct 2026): the public /pricing meta description — the line Google shows under the
 * result — said "tiers launch once we hit ₹15K MRR", an internal revenue target. Every public
 * page's metadata (title + description) is scanned for internal notes: revenue targets, plan
 * names, people's names, TODOs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const APP = path.join(process.cwd(), "src/app");

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "(app)" || name === "api" || name === "dev") continue; // signed-in app / endpoints
      out.push(...pageFiles(p));
    } else if (/^(page|layout)\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/** The `metadata` object (or generateMetadata body) of a page, comments stripped. */
function metadataBlock(src: string): string | null {
  const m = /export (?:const metadata[^=]*=|async function generateMetadata|function generateMetadata)([\s\S]*?)\n\}/.exec(src);
  if (!m) return null;
  return m[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const INTERNAL = /\bMRR\b|\bARR\b|₹\s*\d+\s*K\b|once we hit|90-day plan|PROJECT_TRACKER|\bTODO\b|\bFIXME\b|Pardeep|Abhishek|Pawan|Hitesh/i;

describe("R-1631: public page metadata carries no internal notes", () => {
  const files = pageFiles(APP);

  it("finds the public pages", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("/pricing's description is customer copy, not a revenue target", () => {
    const block = metadataBlock(readFileSync(path.join(APP, "(public)/pricing/page.tsx"), "utf8"));
    expect(block).not.toBeNull();
    expect(block).not.toMatch(INTERNAL);
    expect(block).toMatch(/description:/);
  });

  it("no public page's title/description names an internal target, plan or person", () => {
    const bad = files
      .map((f) => ({ f: path.relative(APP, f), block: metadataBlock(readFileSync(f, "utf8")) }))
      .filter((x) => x.block && INTERNAL.test(x.block))
      .map((x) => `${x.f}: ${x.block!.match(INTERNAL)![0]}`);
    expect(bad).toEqual([]);
  });
});
