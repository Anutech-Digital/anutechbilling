/**
 * What the site says about our hosting matches the hosting (Pawan, 9 Oct 2026: "fix such basic
 * mistakes"). Measured that day on server1.anutech.in: the control panel is DirectAdmin
 * (:2222), the web server is Apache 2.4, and the one hosting server is Google Cloud in Mumbai.
 * The site said "cPanel" in ~25 places, "LiteSpeed" and "Mumbai and Bengaluru".
 *
 * "cPanel" is still right where it names the CUSTOMER'S OLD host ("your current hosting or cPanel
 * login"); those lines are listed below. The /status page's rows are static demo data awaiting
 * an owner decision (hide it until a real status feed exists) and are listed too.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/site", "src/app/(marketing)", "src/lib/hosting", "src/app/api/public/trial"];
const WRONG = /\bc-?panel\b|litespeed|bengaluru|bangalore|\bWHM\b/i;
/** Lines where the word is correct: the customer's previous provider — or pending demo data. */
const ALLOWED: RegExp[] = [
  /What about my old email \(cPanel, Zoho, Outlook\)/,
  /Purana email \(cPanel, Zoho, Outlook\)/,
  /placeholder="Gmail, GoDaddy, cPanel…"/,
  /"cPanel or hosting mail"/,
  /Your current hosting or cPanel login/,
  /name: "Shared hosting · (Mumbai|Bengaluru)", note: "LiteSpeed cluster"/, // /status demo rows — owner decision
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

describe("hosting platform facts on the site", () => {
  it("never says cPanel, LiteSpeed or Bengaluru about our own hosting", () => {
    const bad: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(process.cwd(), root))) {
        readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
          if (WRONG.test(line) && !ALLOWED.some((a) => a.test(line))) bad.push(`${f.replace(process.cwd(), "")}:${i + 1}  ${line.trim().slice(0, 120)}`);
        });
      }
    }
    expect(bad).toEqual([]);
  });

  it("the cart line and the hosting page name the real panel", () => {
    expect(readFileSync(join(process.cwd(), "src/site/lib/hosting-cart-line.ts"), "utf8")).toContain("DirectAdmin on Google Cloud");
    expect(readFileSync(join(process.cwd(), "src/app/(marketing)/hosting/page.tsx"), "utf8")).toMatch(/DirectAdmin/);
  });
});
