/**
 * Every website #anchor link lands on a section that exists.
 *
 * R-1506 (17 Oct 2026, Pawan on staging, 3 reports): "See how migration works" (<a href="#move">
 * on /hosting) flickered and went nowhere. The id was there; the root cause was the workspace
 * popstate handler stripping the hash (workspace-tabs-provider.test.tsx pins that). This scan
 * pins the other half, so a button can never silently point at a section that is not on its page:
 *
 *  - a same-page link ("#move") must have a matching id on EVERY page that renders the file;
 *  - a cross-page link ("/domains#rates") must have the id on that route's page.
 *
 * "On a page" = the page.tsx plus its layouts, and every file they import (followed through
 * @/ and relative imports), since sections live in components, not in page.tsx.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const GROUPS = ["(marketing)", "(lp)", "(product)"];

const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

const srcCache = new Map<string, string>();
const read = (f: string) => {
  if (!srcCache.has(f)) srcCache.set(f, readFileSync(f, "utf8"));
  return srcCache.get(f)!;
};

/** The file plus everything it imports, transitively. */
function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of read(f).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const r = resolveImport(f, m[1]);
      if (r && /\.(tsx?|jsx?)$/.test(r) && !/\.test\./.test(r)) stack.push(r);
    }
  }
  return seen;
}

type Page = { route: string; files: Set<string>; ids: Set<string> };

function idsIn(files: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const f of files) {
    for (const m of read(f).matchAll(/\bid\s*[=:]\s*\{?\s*["'`]([A-Za-z][\w-]*)["'`]/g)) ids.add(m[1]);
  }
  return ids;
}

function pages(): Page[] {
  const out: Page[] = [];
  for (const g of GROUPS) {
    const groupDir = join(SRC, "app", g);
    for (const page of walk(groupDir).filter((f) => /[\\/]page\.tsx$/.test(f))) {
      const layouts: string[] = [];
      for (let d = dirname(page); d.startsWith(groupDir); d = dirname(d)) {
        const l = join(d, "layout.tsx");
        if (existsSync(l)) layouts.push(l);
      }
      const routeDir = rel(dirname(page)).replace(`src/app/${g}`, "");
      const route = routeDir.replace(/\/\([^)]+\)/g, "") || "/";
      const files = closure([page, ...layouts]);
      out.push({ route, files, ids: idsIn(files) });
    }
  }
  return out;
}

const PAGES = pages();

/** Literal anchor hrefs in a file: "#x" (same page) and "/path#x" (another page). */
function anchorsIn(file: string): { route: string | null; id: string; line: number }[] {
  const found: { route: string | null; id: string; line: number }[] = [];
  read(file).split("\n").forEach((text, i) => {
    // An href="..." / href: "..." attribute, or a ["Label", "/path#id"] link pair.
    for (const m of text.matchAll(/href\s*[=:]\s*\{?\s*["'`](\/[\w/-]*)?#([A-Za-z][\w-]*)["'`]/g)) {
      found.push({ route: m[1] ?? null, id: m[2], line: i + 1 });
    }
    for (const m of text.matchAll(/,\s*["'`](\/[\w/-]*)#([A-Za-z][\w-]*)["'`]/g)) {
      found.push({ route: m[1], id: m[2], line: i + 1 });
    }
  });
  return found;
}

describe("website #anchor links land on a real section (R-1506)", () => {
  it("found the website pages to scan", () => {
    for (const r of ["/", "/hosting", "/domains", "/email", "/ssl", "/reseller", "/reselleros"]) {
      expect(PAGES.map((p) => p.route), r).toContain(r);
    }
  });

  it("every same-page and cross-page #anchor has its id on the target page", () => {
    const files = new Set<string>();
    PAGES.forEach((p) => p.files.forEach((f) => files.add(f)));
    const broken: string[] = [];
    let checked = 0;
    for (const f of files) {
      if (!rel(f).startsWith("src/site/") && !rel(f).startsWith("src/app/")) continue;
      for (const a of anchorsIn(f)) {
        const targets = a.route === null
          ? PAGES.filter((p) => p.files.has(f))
          : PAGES.filter((p) => p.route === a.route);
        if (a.route !== null && targets.length === 0) {
          broken.push(`${rel(f)}:${a.line} → ${a.route}#${a.id} (no such page)`);
          continue;
        }
        for (const p of targets) {
          checked++;
          if (!p.ids.has(a.id)) broken.push(`${rel(f)}:${a.line} → ${p.route}#${a.id} (no id="${a.id}" on ${p.route})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(broken).toEqual([]);
  });

  it("the /hosting hero button points at the migration section", () => {
    const hosting = PAGES.find((p) => p.route === "/hosting")!;
    for (const id of ["move", "choose", "cost", "worries", "main"]) expect(hosting.ids, id).toContain(id);
  });
});
