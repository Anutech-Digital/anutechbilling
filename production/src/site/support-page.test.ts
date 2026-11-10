/**
 * The customer support page and the client-area link (30 Sep 2026).
 *
 * The site's "Support", "Knowledge base" and "Migration desk" links opened /support — the
 * STAFF support inbox, which sends a customer to the staff login. "Client area" opened
 * /dashboard, the staff app. The support page now lives at /contact, and "Client area" is
 * the DMS customer panel's sign-in (CLIENT_AREA_URL).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { nextWorkingDays, dayLabel } from "@/site/components/support/SupportBody";
import { SUPPORT_CHANNELS } from "@/site/lib/data/misc";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

const code = (f: string) => readSource(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|ts)$/.test(n) && !/\.test\./.test(n)) out.push(p);
  }
  return out;
}

describe("call-back days", () => {
  it("are the next working days after today, skipping Sunday", () => {
    // 2026-10-03 is a Saturday: next are Mon 5, Tue 6, Wed 7, Thu 8 (Sunday 4 skipped).
    expect(nextWorkingDays(4, "2026-10-03")).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
  });
  it("never include today, so a slot is never already in the past", () => {
    expect(nextWorkingDays(1, "2026-09-30")).toEqual(["2026-10-01"]);
  });
  it("read as a weekday and date", () => {
    expect(dayLabel("2026-10-01")).toBe("Thu 01 Oct");
  });
  it("are computed, not fixed dates", () => {
    expect(code("src/site/components/support/SupportBody.tsx")).not.toMatch(/"(Mon|Tue|Wed|Thu|Fri|Sat) \d\d [A-Z][a-z]{2}"/);
  });
});

describe("the support page says only what is true", () => {
  const c = code("src/site/components/support/SupportBody.tsx");
  it("shows WhatsApp only once a real number is set", () => {
    expect(c).toMatch(/\{WHATSAPP_READY && \(/);
    expect(c).not.toMatch(/Eleven-minute|eleven-minute/);
  });
  it("its channel cards promise no WhatsApp desk and no automatic SLA credit", () => {
    const text = JSON.stringify(SUPPORT_CHANNELS);
    expect(text).not.toMatch(/WhatsApp|SLA|automatically/);
  });
  it("is a real page at /contact", () => {
    expect(readSource("src/app/(marketing)/contact/page.tsx")).toMatch(/<SupportBody \/>/);
  });
});

describe("no site link sends a customer into the staff app", () => {
  const files = [...walk("src/site"), ...walk("src/app/(marketing)")];
  it("guard: the scan reads the site", () => {
    expect(files.length).toBeGreaterThan(50);
  });
  it('nothing links to "/support" or "/dashboard"', () => {
    const bad = files.filter((f) => /(href:?\s*=?\s*\{?\s*"|, ")\/(support|dashboard)["#?]/.test(code(f)));
    expect(bad).toEqual([]);
  });
  it("Client area is the customer panel's sign-in", () => {
    expect(code("src/site/components/chrome/Chrome.tsx")).toMatch(/\["Client area", CLIENT_AREA_URL\]/);
    expect(code("src/site/components/chrome/Header.tsx")).toMatch(/label: "Client area",[^}]*href: CLIENT_AREA_URL/);
  });
});
