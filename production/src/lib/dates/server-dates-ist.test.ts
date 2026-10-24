/**
 * R-1660 — every date the SERVER writes into a customer message is India time.
 *
 * Cloud Run runs in UTC. `new Date(x).toLocaleDateString("en-IN", { day, month, year })`
 * without `timeZone` therefore prints the UTC day: a trial started at 02:00 IST said it
 * ends a day early, and an offer expiring late at night IST showed the day before. Trial
 * emails, offer/campaign emails, renewal reminders and invoice-due lines are all built in
 * src/app/api and src/lib (email, hosting, renewals, AI-draft helpers).
 *
 * The rule (R-275 did it for screens): a date/time toLocale…String call names `timeZone`
 * (IST_TZ, or "UTC" for a YYYY-MM-DD calendar date pinned to midnight UTC), or the code
 * goes through formatIstDate / formatIstTime / formatDate (lib/utils, IST). This scan
 * holds the line for every file under those trees, so a new email template cannot quietly
 * format a date in server time.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatIstDate } from "./ist";

const ROOTS = ["src/app/api", "src/lib", "src/server"];

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "generated") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
}

/** Each `.toLocale…String(` call with its argument text (options objects hold no parens). */
function localeCalls(src: string): string[] {
  return [...src.matchAll(/\.toLocale(?:Date|Time)?String\(([^)]*)\)/g)].map((m) => m[1]);
}

/** A call that prints a date or a clock time (not a number) and does not pin the zone. */
function nakedDateCalls(src: string): string[] {
  return localeCalls(src)
    .filter((args) => /\b(day|month|hour|minute|weekday|year|dateStyle|timeStyle)\b/.test(args))
    .filter((args) => !/timeZone\s*:/.test(args))
    .map((a) => a.replace(/\s+/g, " ").trim());
}

describe("server-side dates are India time (R-1660)", () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(path.join(process.cwd(), r), files);

  it("the scan finds the server code", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("no date/time toLocale…String call without timeZone in src/app/api, src/lib, src/server", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const call of nakedDateCalls(fs.readFileSync(f, "utf8"))) {
        offenders.push(`${path.relative(process.cwd(), f).replace(/\\/g, "/")}: (${call})`);
      }
    }
    expect(offenders, `format these with formatIstDate / formatIstTime, or add timeZone: IST_TZ:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the scan catches a naked call and passes a pinned one", () => {
    expect(nakedDateCalls(`d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })`)).toHaveLength(1);
    expect(nakedDateCalls(`d.toLocaleDateString("en-IN", { day: "2-digit", timeZone: IST_TZ })`)).toHaveLength(0);
    expect(nakedDateCalls(`n.toLocaleString("en-IN")`)).toHaveLength(0);
  });

  it("a trial that ends at 01:00 IST is dated that IST day, not the UTC day before", () => {
    // 19:30 UTC on 1 Nov = 01:00 IST on 2 Nov.
    expect(formatIstDate(new Date("2026-11-01T19:30:00Z"))).toBe("2 Nov 2026");
  });
});
