/**
 * R-1479 (17 Oct 2026, Pawan on staging): about 14 public pages — cart, SSL, quote, the legal
 * pages, login … — had no description of their own, so every one of them showed the root
 * layout's ResellerOS blurb in search results, and /cart's tab read only the bare site title.
 *
 * Rule this test holds, for every public route (the (marketing), (public), (product) and (lp)
 * groups, plus the sign-in pages):
 *   - a page search engines may index sets its OWN title and its OWN description, and no two
 *     indexable pages share a title or a description;
 *   - a page that should not be indexed (robots.txt already blocks /cart, /checkout, /done,
 *     /login, /signup, /forgot-password; per-visitor quote/assessment links) says `noindex`
 *     and still has its own title — never the bare site default.
 *
 * Metadata is read from source (the page, then any layout between it and its route group),
 * because importing the pages would pull in the database and auth code.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const GROUPS = ["src/app/(marketing)", "src/app/(public)", "src/app/(product)", "src/app/(lp)"];
/** Sign-in pages that are reachable from the public site (robots.txt disallows them). */
const AUTH_PAGES = ["src/app/(auth)/login", "src/app/(auth)/signup", "src/app/(auth)/forgot-password"];
const ROBOTS_BLOCKED = ["/cart", "/checkout", "/done", "/login", "/signup", "/forgot-password"];

const read = (f: string) => readFileSync(f, "utf8");

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return pages(p);
    return n === "page.tsx" ? [p] : [];
  });
}

/** The exported metadata (object, call or generateMetadata body) of one file, or null. */
function metadataBlock(src: string): string | null {
  const start = src.search(/export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b)/);
  if (start < 0) return null;
  const rest = src.slice(start);
  const firstLine = rest.split("\n")[0];
  if (/;\s*$/.test(firstLine)) return firstLine; // one-liner: `= { title: "…" };` or `= helper("x");`
  const end = rest.search(/\n\}/);
  return end < 0 ? rest : rest.slice(0, end + 2);
}

const isDelegated = (block: string) => /metadata\s*(?::\s*Metadata\s*)?=\s*[A-Za-z_$][\w$]*\(/.test(block);

/** The first `key:` value in the block — a string literal (whitespace folded) or an expression name. */
function firstValue(block: string, key: string): string | null {
  const lead = String.raw`\b${key}\s*:\s*(?:\{\s*(?:absolute|default)\s*:\s*)?`;
  const lit = block.match(new RegExp(lead + String.raw`(["\x60])([\s\S]*?)\1`));
  const expr = block.match(new RegExp(lead + String.raw`([A-Za-z_$][\w$.]*)`));
  const li = lit?.index ?? Infinity;
  const ei = expr?.index ?? Infinity;
  if (lit && li <= ei) return lit[2].replace(/\s+/g, " ").trim();
  return expr ? expr[1] : null;
}

const titleOf = (block: string) => (isDelegated(block) ? block.trim() : firstValue(block, "title"));
const descriptionOf = (block: string) => (isDelegated(block) ? block.trim() : firstValue(block, "description"));

const noindex = (block: string) => /index\s*:\s*false|["']noindex["']/.test(block);

interface Route { page: string; path: string; title: string | null; description: string | null; noindex: boolean }

function routeFor(page: string, groupDir: string): Route {
  const own: string[] = [];
  let dir = dirname(page);
  const pageBlock = metadataBlock(read(page));
  if (pageBlock) own.push(pageBlock);
  // Route layouts between the page and its group (they belong to this route), nearest first.
  while (dir.length > groupDir.length) {
    const layout = join(dir, "layout.tsx");
    if (existsSync(layout)) {
      const b = metadataBlock(read(layout));
      if (b) own.push(b);
    }
    dir = dirname(dir);
  }
  const groupLayout = join(groupDir, "layout.tsx");
  const groupBlock = existsSync(groupLayout) ? metadataBlock(read(groupLayout)) : null;
  const path = "/" + dirname(page).slice(groupDir.length + 1).replace(/\\/g, "/");
  return {
    page: page.replace(/\\/g, "/"),
    path: path === "/" ? "/" : path.replace(/\/$/, ""),
    title: own.map(titleOf).find((t) => t !== null) ?? null,
    description: own.map(descriptionOf).find((d) => d !== null) ?? null,
    noindex: own.some(noindex) || (groupBlock !== null && noindex(groupBlock)),
  };
}

/** A page whose only job is to forward the visitor elsewhere renders nothing, so it needs no title. */
const redirectOnly = (page: string) => {
  const src = read(page);
  return /\bredirect\(/.test(src) && !/return\s*[(<]/.test(src);
};

/**
 * Pages left out on purpose, each with the reason.
 * /project-quote/[id] is a Project Sales page (Billing — Abhishek's area); its noindex +
 * title is asked of its owner instead of changed here.
 */
const SKIP = new Set(["src/app/(public)/project-quote/[id]/page.tsx"]);

const routes: Route[] = [
  ...GROUPS.flatMap((g) => pages(g).map((p) => routeFor(p, g))),
  ...AUTH_PAGES.map((d) => routeFor(join(d, "page.tsx"), "src/app/(auth)")),
].filter((r) => !SKIP.has(r.page) && !redirectOnly(r.page));
const indexable = routes.filter((r) => !r.noindex);

function dupes(key: (r: Route) => string | null): string[] {
  const seen = new Map<string, string[]>();
  for (const r of indexable) {
    const k = key(r);
    if (k) seen.set(k, [...(seen.get(k) ?? []), r.page]);
  }
  return [...seen.entries()].filter(([, ps]) => ps.length > 1).map(([k, ps]) => `${k}: ${ps.join(", ")}`);
}

describe("R-1479 every public route has its own title and description", () => {
  it("finds the public routes", () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it("no route falls back to the bare site title", () => {
    expect(routes.filter((r) => r.title === null).map((r) => r.page)).toEqual([]);
  });

  it("every indexable route has its own description", () => {
    expect(indexable.filter((r) => r.description === null).map((r) => r.page)).toEqual([]);
  });

  it("no two indexable routes share a description", () => {
    expect(dupes((r) => r.description)).toEqual([]);
  });

  it("no two indexable routes share a title", () => {
    expect(dupes((r) => r.title)).toEqual([]);
  });

  it("no page copies the root layout's ResellerOS description", () => {
    const root = descriptionOf(metadataBlock(read("src/app/layout.tsx")) ?? "");
    expect(root).toBeTruthy();
    expect(routes.filter((r) => r.description === root).map((r) => r.page)).toEqual([]);
  });

  it("pages robots.txt keeps out of search say noindex too", () => {
    const robots = read("src/app/robots.ts");
    for (const p of ROBOTS_BLOCKED) expect(robots).toContain(`"${p}"`);
    const missing = ROBOTS_BLOCKED.filter((p) => !routes.find((r) => r.path === p)?.noindex);
    expect(missing).toEqual([]);
  });

  it("the cart page names itself", () => {
    expect(routes.find((r) => r.path === "/cart")?.title).toBe("Your cart");
  });
});
