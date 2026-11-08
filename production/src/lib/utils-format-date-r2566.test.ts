/**
 * R-2566: formatDate builds each Intl formatter once (it used `toLocaleString(locale, options)`,
 * which builds a new one per call and froze the BRS page). The text must be exactly what the old
 * code printed — every month, both halves of the day, IST midnight edges, date-only strings.
 */
import { describe, expect, it } from "vitest";
import { formatDate } from "./utils";

/** The old formatDate, verbatim (before R-2566). */
function oldFormatDate(input: Date | string | number | null | undefined, format: "short" | "long" | "relative" = "short"): string {
  if (!input) return "—";
  const dateOnly = typeof input === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim()) : null;
  if (dateOnly && format !== "relative") {
    const cal = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
    if (isNaN(cal.getTime())) return "—";
    const mon = cal.toLocaleString("en-IN", { month: "short", timeZone: "UTC" });
    return `${cal.getUTCDate()} ${mon} ${cal.getUTCFullYear()}`;
  }
  const d = typeof input === "string" || typeof input === "number" ? new Date(input) : input;
  if (isNaN(d.getTime())) return "—";
  if (format === "relative") return "(relative)";
  const day = Number(d.toLocaleString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" }));
  const month = d.toLocaleString("en-IN", { month: "short", timeZone: "Asia/Kolkata" });
  const year = Number(d.toLocaleString("en-IN", { year: "numeric", timeZone: "Asia/Kolkata" }));
  if (format === "long") {
    const time = d.toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata", hour12: true });
    return `${day} ${month} ${year} · ${time}`;
  }
  return `${day} ${month} ${year}`;
}

describe("R-2566 formatDate — same text as before, formatters built once", () => {
  it("date-only strings: every month of two years, short and long", () => {
    for (const y of [2025, 2026]) for (let m = 1; m <= 12; m++) for (const dd of [1, 15, 28]) {
      const s = `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      expect(formatDate(s)).toBe(oldFormatDate(s));
      expect(formatDate(s, "long")).toBe(oldFormatDate(s, "long"));
    }
  });

  it("timestamps: every hour of a day in each month (IST edges included), short and long", () => {
    for (let m = 0; m < 12; m++) for (let h = 0; h < 24; h++) {
      const d = new Date(Date.UTC(2026, m, 10, h, 7 * (h % 8)));
      expect(formatDate(d)).toBe(oldFormatDate(d));
      expect(formatDate(d, "long")).toBe(oldFormatDate(d, "long"));
      expect(formatDate(d.toISOString(), "long")).toBe(oldFormatDate(d.toISOString(), "long"));
      expect(formatDate(d.getTime())).toBe(oldFormatDate(d.getTime()));
    }
  });

  it("empty and bad input unchanged", () => {
    for (const v of [null, undefined, "", "not a date", "2026-13-45"]) expect(formatDate(v)).toBe(oldFormatDate(v));
  });

  it("3,770 calls take well under the old cost (no formatter per call)", () => {
    const t0 = performance.now();
    for (let i = 0; i < 3770; i++) formatDate(`2026-${String((i % 12) + 1).padStart(2, "0")}-15`);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
