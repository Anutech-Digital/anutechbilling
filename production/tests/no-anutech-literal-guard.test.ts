/**
 * R-1929 (G-ONBOARD OB-8) — guard: the platform company's name is not hard-coded into what
 * every reseller's workspace runs.
 *
 * Before: the AI agents signed every reseller's mail as the platform company, the quote builder
 * promised that company's free training, and in-app help called the product "<company>'s own
 * app". A new reseller's customers saw somebody else's name.
 *
 * This scans the STRINGS of runtime code under src/ (string literals, template text, JSX text —
 * comments are not code and are not scanned) for "ANUTECH" or "Anutech Digital". A hit is
 * allowed only in the platform's own files and its public website, each listed below with the
 * reason. A new hit elsewhere fails: take the name from the tenant row (lib/ai/seller-identity,
 * lib/invoices/supplier-identity) or from PLATFORM_OPERATOR (lib/platform.ts) for the platform.
 * An allowlisted FILE that no longer has a hit fails too, so the list only shrinks.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "src");

const NAME = [/ANUTECH/, /anutech\s+digital/i];
const hasName = (s: string) => NAME.some((r) => r.test(s));

/** Folders: the platform company's public website / marketing (its own brand on purpose). */
const ALLOWED_DIRS: Record<string, string> = {
  "src/site/": "the platform company's public website: components, copy and config (its own brand)",
  "src/app/(marketing)/": "the platform company's public marketing pages, legal pages and checkout",
  "src/app/(lp)/": "the platform company's ad landing pages",
  "src/app/(public)/": "the platform company's public pages (about, buy pages)",
  "src/app/(product)/": "the ResellerOS product page; its publisher is the platform company",
};

/** Single files: the platform's own identity and admin, each for the reason given. */
const ALLOWED_FILES: Record<string, string> = {
  "src/lib/platform.ts": "PLATFORM_OPERATOR — the one place the platform company's name is defined",
  "src/app/learn/page.tsx": "public learn page on the website (logo alt text)",
  "src/app/(app)/platform/page.tsx": "platform admin screen: marks the platform company's own workspace",
  "src/app/api/platform/signups/[id]/route.ts": "platform admin: refuses deleting the platform company's own workspace",
  "src/app/api/public/agent/chat/route.ts": "the website's public chat agent, which answers for the platform tenant",
  "src/app/(auth)/login/page.tsx": "the login page is also the website's Client login; links to the platform company's purchase terms and privacy policy",
  "src/lib/catalog/catalog-prices.ts": "SKU code MAIL-ANUTECH-YR — a data key stored in items rows, not shown as a seller name",
  "src/app/api/academy/apprentices/[id]/login/route.ts": "Academy login email names the platform's Academy programme — per-tenant wording is a follow-up, not R-1929",
};

const posix = (p: string) => p.split(sep).join("/");

function runtimeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "__tests__" || e.name === "__mocks__") continue;
      runtimeFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** Lines of string literals / template text / JSX text that carry the name. Comments are skipped. */
function nameHits(file: string): number[] {
  const text = readFileSync(file, "utf8");
  if (!hasName(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  const visit = (n: ts.Node) => {
    const isText =
      ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ||
      n.kind === ts.SyntaxKind.JsxText;
    if (isText && hasName((n as ts.LiteralLikeNode).text)) {
      lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

const allowed = (rel: string) => rel in ALLOWED_FILES || Object.keys(ALLOWED_DIRS).some((d) => rel.startsWith(d));

describe("R-1929 guard — no platform company name in runtime code outside the platform + website", () => {
  const hits = new Map<string, number[]>();
  for (const f of runtimeFiles(SRC)) {
    const lines = nameHits(f);
    if (lines.length) hits.set(posix(relative(ROOT, f)), lines);
  }

  it("the scanner sees strings, not comments", () => {
    const probe = join(SRC, "lib", "ai", "seller-identity.ts");
    expect(readFileSync(probe, "utf8")).toMatch(/platform company/); // file exists and is scanned
    expect(nameHits(join(SRC, "lib", "platform.ts")).length).toBeGreaterThan(0);
  });

  it("no hit outside the allowlist", () => {
    const outside = [...hits].filter(([rel]) => !allowed(rel)).map(([rel, l]) => `${rel}:${l.join(",")}`);
    expect(outside, "Take the seller name from the tenant row (lib/ai/seller-identity.ts) — or, for the platform itself, from PLATFORM_OPERATOR (lib/platform.ts) and add the file here with a reason.").toEqual([]);
  });

  it("every allowlist entry has a reason, and every allowlisted file still needs it", () => {
    for (const [path, why] of Object.entries({ ...ALLOWED_DIRS, ...ALLOWED_FILES })) {
      expect(why.trim().length, path).toBeGreaterThan(10);
      expect(existsSync(join(ROOT, path)), `${path} no longer exists — remove it from the allowlist`).toBe(true);
    }
    const stale = Object.keys(ALLOWED_FILES).filter((p) => !hits.has(p));
    expect(stale, "these files no longer carry the name — remove them from ALLOWED_FILES").toEqual([]);
  });
});
