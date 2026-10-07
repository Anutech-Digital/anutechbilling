/**
 * R-275: dates and times shown in the app are India time, whatever the device clock says.
 *
 * `d.toLocaleString("en-IN", {...})` without `timeZone` uses the VIEWER's zone: a laptop
 * on UTC (or a server render on Cloud Run) shows a 10:00 follow-up as 04:30, and between
 * 00:00 and 05:30 IST the date is yesterday's. Every such call in the files below must
 * pin `timeZone: "Asia/Kolkata"` (IST_TZ), or go through formatIstDate / formatIstTime.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { formatIstTime, IST_TZ } from "./ist";

const FILES = [
  "src/app/(app)/tasks/page.tsx",
  "src/components/features/leads/lead-detail-followups-tab.tsx",
  "src/components/features/leads/email-thread-panel.tsx",
  "src/app/(app)/settings/backup/page.tsx",
];

/** Each `.toLocale…String(` call with its argument text (options objects hold no parens). */
function localeCalls(src: string): string[] {
  return [...src.matchAll(/\.toLocale(?:Date|Time)?String\(([^)]*)\)/g)].map((m) => m[1]);
}

describe("dates on screen are pinned to IST (R-275)", () => {
  it("IST_TZ is Asia/Kolkata", () => {
    expect(IST_TZ).toBe("Asia/Kolkata");
  });

  for (const file of FILES) {
    it(`${file}: every date/time toLocale call names the IST time zone`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const naked = localeCalls(src).filter((args) => /\b(day|month|hour|minute|weekday|year)\b/.test(args) || args.trim() === '"en-IN"')
        .filter((args) => !/timeZone\s*:/.test(args));
      expect(naked, `toLocale…String without timeZone in ${file}:\n  ${naked.join("\n  ")}`).toEqual([]);
    });
  }

  it("formatIstTime shows India time whatever the process time zone", () => {
    // 20:00 UTC = 01:30 IST the next day.
    expect(formatIstTime("2026-10-06T20:00:00Z")).toMatch(/^0?1:30\s?am$/i);
    // 04:30 UTC = 10:00 IST.
    expect(formatIstTime(new Date("2026-10-06T04:30:00Z"))).toMatch(/^10:00\s?am$/i);
    expect(formatIstTime(null)).toBe("");
    expect(formatIstTime("not a date")).toBe("");
  });
});
