// @vitest-environment jsdom
/**
 * R-2010 (27 Oct 2026, G-DPDP): an ad visitor who lands straight on /buy/workspace (or comes
 * back to the thanks page) never saw the site's consent banner — it was mounted only in the
 * (marketing) layout — so consent never became "all" and the Pixel / Conversions API never ran.
 * Every page that renders <MetaPixel> now renders the same <ConsentBanner>, and the buy page's
 * footer has "Cookie settings" to change the choice.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import { SiteFooter } from "./_parts/info-sections";

afterEach(() => cleanup());

const read = (f: string) => readFileSync(f, "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out); }
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

describe("R-2010: the consent banner sits wherever the Meta Pixel does", () => {
  it("the buy page renders the shared ConsentBanner next to MetaPixel", () => {
    const src = read("src/app/(public)/buy/workspace/buy-workspace-client.tsx");
    expect(src).toMatch(/import \{[^}]*\bConsentBanner\b[^}]*\} from "@\/site\/components\/chrome\/ConsentBanner"/);
    expect(src).toMatch(/<ConsentBanner \/>/);
  });

  it("the thanks page renders it too", () => {
    const src = read("src/app/(public)/buy/workspace/thanks/thanks-client.tsx");
    expect(src).toMatch(/from "@\/site\/components\/chrome\/ConsentBanner"/);
    expect(src).toMatch(/<ConsentBanner \/>/);
  });

  it("no file under src/app renders <MetaPixel> without a ConsentBanner in the same file", () => {
    const offenders = walk("src/app").filter((f) => {
      const s = read(f);
      return /<MetaPixel\b/.test(s) && !/<ConsentBanner \/>/.test(s);
    });
    expect(offenders).toEqual([]);
  });

  it("there is ONE banner: no second copy of the wording anywhere in src", () => {
    const hits = walk("src").filter((f) => read(f).includes("Advertising measurement (Meta)</"));
    expect(hits.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/site/components/chrome/ConsentBanner.tsx"]);
  });
});

describe("R-2010: buy page footer — Cookie settings", () => {
  it("has a 'Cookie settings' button next to the Privacy policy link", () => {
    render(<SiteFooter brand={null} />);
    expect(screen.getByRole("link", { name: "Privacy policy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cookie settings" })).toBeTruthy();
  });
});
