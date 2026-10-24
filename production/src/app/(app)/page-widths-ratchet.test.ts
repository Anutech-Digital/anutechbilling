/**
 * R-1489 (rest of R-1408): every app page uses the CLAUDE.md §20 widths —
 * listing/dashboard pages `max-w-[1800px] mx-auto`, detail/form pages
 * `max-w-[1240px]`. Pages at 1400px / 1500px / max-w-screen-xl / max-w-7xl
 * made the app look like it changes width from page to page (Pawan, staging,
 * /accounting/payment-runs).
 *
 * Source scan over src/app/(app): no .tsx file may use those old widths.
 * ALLOWLIST is for a page that must stay narrower for a real reason — give the
 * reason. It may only shrink.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP = path.join(process.cwd(), "src/app/(app)");
const BANNED = /max-w-\[(1400|1500)px\]|max-w-screen-xl|max-w-7xl/g;

/** path (relative to src/app/(app)) → reason it may keep a narrower width. */
const ALLOWLIST: Record<string, string> = {};

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsxFiles(full));
    else if (e.name.endsWith(".tsx") && !/\.test\.tsx$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(APP, f).split(path.sep).join("/");

describe("R-1489: app pages use §20 widths (no 1400/1500px wrappers)", () => {
  const files = tsxFiles(APP);

  it("finds the app pages", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no page uses max-w-[1400px] / max-w-[1500px] / max-w-screen-xl / max-w-7xl", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (r in ALLOWLIST) continue;
      const hits = fs.readFileSync(f, "utf8").match(BANNED);
      if (hits) offenders.push(`${r}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlisted page still exists and still needs it (list only shrinks)", () => {
    for (const [r, why] of Object.entries(ALLOWLIST)) {
      expect(why.trim().length, `${r} needs a reason`).toBeGreaterThan(0);
      const full = path.join(APP, r);
      expect(fs.existsSync(full), `${r} is gone — remove it from ALLOWLIST`).toBe(true);
      expect(
        BANNED.test(fs.readFileSync(full, "utf8")),
        `${r} is fixed — remove it from ALLOWLIST`,
      ).toBe(true);
      BANNED.lastIndex = 0;
    }
  });
});
