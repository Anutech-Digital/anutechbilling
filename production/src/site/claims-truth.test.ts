/**
 * R-1600 + R-1602 (19 Oct 2026) — two public claims that were not true, now held by a scan.
 *
 * R-1600: the privacy policy, /about, the /pricing FAQ, /why-us and the /email FAQ said our
 * data sits in "Mumbai (asia-south1)" on "Supabase", "Mumbai and Bengaluru", "India data
 * residency". Production is Cloud SQL + Cloud Run in asia-southeast1 (Singapore) since Sep 2026.
 * The region now comes from ONE constant (DATA_LOCATION, site/lib/config.ts), and this test
 * fails if copy names the old region/vendor again or claims DPDP compliance without a CA's yes.
 *
 * R-1602: "Google Premier Partner since 2014" is not shown until the certificate is on file.
 * Restoring it is one flag (SHOW_PREMIER_PARTNER). This test fails if "Premier Partner" is
 * written as copy anywhere but config.ts.
 *
 * Comments are stripped before scanning — they may explain history; only shipped text counts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  DATA_LOCATION, SHOW_PREMIER_PARTNER, PARTNER_LINE, PARTNER_BADGE, PARTNER_SHORT, COMPANY,
} from "@/site/lib/config";

const ROOT = join(__dirname, "..", ".."); // production/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every file whose strings reach a visitor: the two public sites, root metadata, chat facts. */
const FILES = [
  ...walk(join(ROOT, "src", "site")),
  ...walk(join(ROOT, "src", "app", "(public)")),
  ...walk(join(ROOT, "src", "app", "(marketing)")),
  join(ROOT, "src", "app", "layout.tsx"),
  join(ROOT, "src", "lib", "ai", "public-sales-chat.ts"),
  join(ROOT, "public", "llms.txt"),
];

const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

/** Drop comments and import lines; keep strings and JSX text. */
function shipped(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/^\s*import\b[^;]*;/gm, "");
}

const CODE = FILES.map((f) => ({ file: rel(f), text: shipped(readFileSync(f, "utf8")) }));

function offenders(re: RegExp, allow: (file: string) => boolean = () => false): string[] {
  return CODE.filter(({ file, text }) => !allow(file) && re.test(text)).map(({ file, text }) => {
    const m = text.match(re);
    return `${file}: …${m?.[0] ?? ""}…`;
  });
}

describe("R-1600 — data location is the true one", () => {
  it("the constant names Singapore, asia-southeast1, Cloud SQL + Cloud Run", () => {
    expect(DATA_LOCATION.region).toBe("asia-southeast1");
    expect(DATA_LOCATION.city).toBe("Singapore");
    expect(DATA_LOCATION.database).toMatch(/Cloud SQL/);
    expect(DATA_LOCATION.app).toBe("Cloud Run");
    expect(DATA_LOCATION.label).toContain(DATA_LOCATION.region);
  });

  it("scans a real set of files (guard against an empty walk)", () => {
    expect(CODE.length).toBeGreaterThan(50);
    expect(CODE.map((c) => c.file)).toContain("src/app/(public)/privacy/page.tsx");
  });

  it("no copy names the old region asia-south1", () => {
    expect(offenders(/asia-south1\b|ap-south-1/i)).toEqual([]);
  });

  it("no copy says data / hosting / a datacentre is in Mumbai or Bengaluru", () => {
    const re = /(google cloud|hosted|hosting|datacent(?:re|er)|region|data|server|node)[^.\n"`]{0,40}\b(mumbai|bengaluru|bangalore)\b|\b(mumbai|bengaluru|bangalore)\b[^.\n"`]{0,20}(region|datacent|node|asia-)|"datacentre", us: "[^"]*(mumbai|bengaluru)/i;
    expect(offenders(re)).toEqual([]);
  });

  it("Supabase is not named as where data lives (it is self-hosted software now, not a vendor)", () => {
    // Capital-S word only: code identifiers (`supabase`, `SupabaseClient`) are not copy.
    expect(offenders(/\bSupabase\b/)).toEqual([]);
  });

  it("no 'India data residency' / 'data stays in India' claim (Singapore is not India)", () => {
    expect(offenders(/india data residency|data stays in india|replicated within india|held on indian infrastructure/i)).toEqual([]);
  });

  it("no 'DPDP compliant / ready' claim until a CA or lawyer says yes", () => {
    expect(offenders(/DPDP[^.\n"`]{0,25}(compliant|ready)/i)).toEqual([]);
  });

  it("the pages that state a region read it from DATA_LOCATION", () => {
    const uses = (f: string) => CODE.find((c) => c.file === f)?.text.includes("DATA_LOCATION");
    for (const f of [
      "src/app/(public)/privacy/page.tsx",
      "src/app/(public)/about/page.tsx",
      "src/app/(public)/pricing/page.tsx",
      "src/site/lib/data/misc.ts",
    ]) expect(uses(f), f).toBe(true);
  });
});

describe("R-1602 — 'Google Premier Partner' only through the one flag", () => {
  it("the flag is OFF until the certificate is on file", () => {
    expect(SHOW_PREMIER_PARTNER).toBe(false);
    for (const s of [PARTNER_LINE, PARTNER_BADGE, PARTNER_SHORT, COMPANY.partnerLine]) {
      expect(s).not.toMatch(/premier/i);
    }
  });

  it("no copy outside config.ts writes 'Premier Partner'", () => {
    expect(offenders(/premier[\s ]+partner/i, (f) => f === "src/site/lib/config.ts")).toEqual([]);
  });

  it("the buy/workspace badge stays behind the flag", () => {
    const f = CODE.find((c) => c.file === "src/app/(public)/buy/workspace/buy-workspace-client.tsx");
    expect(f?.text).toMatch(/if \(!SHOW_PREMIER_PARTNER\) return null;/);
  });
});
