/**
 * Every internal link points at a route that exists.
 *
 * ─── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 * The quote hub offered "Edit" on a draft and "Change the pricing" in the approval block,
 * both linking to `/quotes/<id>/edit`. That route has never existed. Fetched on 21 Aug
 * 2026: HTTP 404, "This page could not be found". Two visible buttons on a money screen,
 * both dead ends.
 *
 * Next.js would have caught it. `next.config` sets `experimental.typedRoutes`, so an
 * unknown route is a build error — and both call sites carried `as any` on the href, which
 * silenced exactly the check that was right. That cast is why the build stayed green.
 *
 * So the check is rebuilt here, where a cast cannot reach it: read the links out of the
 * source as text and resolve them against APP_ROUTES, the table route-map.test.ts already
 * proves matches `src/app` on disk.
 *
 * ─── DELIBERATELY PERMISSIVE ────────────────────────────────────────────────
 * A dynamic segment matches anything, and an interpolated segment is allowed to match a
 * static one — `/quotes/${x}` may legitimately resolve to `/quotes/new` at runtime. This
 * misses some broken links. That trade is on purpose: a false positive here sends someone
 * to "fix" a working screen or gets the test deleted, and twice today a source-scanning
 * rule has fired on prose rather than code. A rule that only ever fires on real breakage
 * is worth more than a thorough one nobody trusts.
 */
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ROUTES } from "./route-map";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DYN = "[*]";

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // The vendored Anutech marketing site (src/site + the (marketing) route group,
    // merge brick #5) is a self-governed subtree: its own design, its own routes,
    // and its own link-integrity test (site/lib/site-invariants.test.ts). Its links
    // point at marketing pages that land incrementally, so the APP's route table
    // must not police them. Skip both.
    if (entry.isDirectory()) {
      if (entry.name === "site" || entry.name === "(marketing)") continue;
      tsxFiles(full, out);
    } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Comments are not links — see invoice-link.test.ts for why this matters. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** `/quotes/${quote.id}/edit?x=1` → `/quotes/[*]/edit` */
function normalize(raw: string): string | null {
  const path = raw.split("?")[0].split("#")[0];
  if (!path.startsWith("/")) return null;          // external, mailto:, tel:, wa.me…
  if (path.startsWith("//")) return null;          // protocol-relative → external
  /* API routes are real and linkable — OAuth connect URLs, PDF endpoints — but APP_ROUTES
     is a table of SCREENS by design (it exists to name the file a bug was reported from).
     Checking handlers against a table of pages would report four working endpoints as
     broken, which is how a useful test becomes a nuisance and then gets deleted. */
  if (path.startsWith("/api/")) return null;
  const collapsed = path.replace(/\$\{[^}]*\}/g, DYN).replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

/* Routes that exist but are deliberately NOT in APP_ROUTES. `/` is the Anutech
   marketing home ((marketing)/page.tsx, merge brick #5) — that group is
   self-governed and excluded from the app's screen registry, but app pages
   legitimately link to the site root (logo, "back to home"). The buyer's terms and
   refund policy are marketing pages too, linked from Online Orders (30 Sep 2026). */
const EXTRA_ROUTES = new Set(["/", "/terms-and-conditions", "/refund", "/privacy-policy"]);

function resolves(link: string): boolean {
  if (EXTRA_ROUTES.has(link)) return true;
  const want = link.split("/").filter(Boolean);
  return APP_ROUTES.some(({ route }) => {
    const have = route.split("/").filter(Boolean);
    if (have.length !== want.length) return false;
    return have.every((seg, i) => {
      const mine = want[i];
      if (seg === mine) return true;
      if (/^\[.*\]$/.test(seg)) return true;       // app route segment is dynamic
      if (mine === DYN) return true;               // interpolated — may be anything
      return false;
    });
  });
}

const LINK_PATTERNS = [
  /href=\{\s*`([^`]+)`/g,
  /href="(\/[^"]*)"/g,
  /router\.push\(\s*`([^`]+)`/g,
  /router\.replace\(\s*`([^`]+)`/g,
  /router\.push\(\s*"(\/[^"]*)"/g,
];

describe("internal links point at routes that exist", () => {
  const files = tsxFiles(SRC).map((file) => ({ file, src: stripComments(readSource(file)) }));

  it("has files and routes to work with", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(APP_ROUTES.length).toBeGreaterThan(50);
  });

  it("resolves every href and router.push in the app", () => {
    const broken: string[] = [];
    for (const { file, src } of files) {
      for (const pattern of LINK_PATTERNS) {
        for (const m of src.matchAll(pattern)) {
          const link = normalize(m[1]);
          if (!link) continue;
          if (!resolves(link)) broken.push(`${file.replace(/\\/g, "/").split("/src/")[1]} → ${link}`);
        }
      }
    }
    expect(
      [...new Set(broken)],
      "these links 404 — `as any` on an href silences typedRoutes, so nothing else catches them",
    ).toEqual([]);
  });

  it("rejects a route that does not exist, and accepts the ones that do", () => {
    /* Guards the guard: if `resolves` ever became permissive enough to accept anything,
       the test above would pass on a broken app and nobody would know.

       This originally asserted that `/quotes/[*]/edit` does NOT resolve — the dead route
       this file was written for. That route now exists (an in-place draft editor was
       built), so the assertion was inverted rather than deleted: the negative control
       moved to a path that is not going to be built, and the route that WAS dead is
       asserted live, which is the fact worth keeping. */
    expect(resolves("/quotes/[*]/edit")).toBe(true);
    expect(resolves("/quotes/[*]")).toBe(true);
    expect(resolves("/quotes/new")).toBe(true);
    expect(resolves("/invoices")).toBe(true);
    expect(resolves("/nonsense/page")).toBe(false);
    expect(resolves("/quotes/[*]/edit/deeper")).toBe(false);
  });
});
