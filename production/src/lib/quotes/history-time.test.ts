// R-815 — quote "Workflow history" must never show a made-up 05:30 am for a date-only value.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { historyTime, quoteCreatedAt } from "./history-time";
import { formatDate } from "@/lib/utils";

describe("historyTime (R-815)", () => {
  it("a date-only value shows just the date — never 05:30", () => {
    expect(historyTime("2026-10-10")).toBe("10 Oct 2026");
    expect(historyTime("2026-10-10")).not.toMatch(/05:30|:/);
  });

  it("a real timestamp shows the right IST time", () => {
    // 14:47 IST = 09:17 UTC — the quote from the staging report.
    expect(historyTime("2026-10-10T09:17:00Z")).toBe("10 Oct 2026 · 02:47 pm");
    expect(historyTime("2026-10-10T09:17:00.123456+00:00")).toBe("10 Oct 2026 · 02:47 pm");
  });

  it("a timestamp late in the UTC day lands on the next IST day", () => {
    expect(historyTime("2026-10-09T20:00:00Z")).toBe("10 Oct 2026 · 01:30 am");
  });

  it("a date cast to timestamptz (exact midnight UTC or IST) shows just the date", () => {
    expect(historyTime("2026-10-10T00:00:00+00:00")).toBe("10 Oct 2026");
    expect(historyTime("2026-10-10T00:00:00+05:30")).toBe("10 Oct 2026");
  });

  it("empty or junk shows a dash", () => {
    expect(historyTime(null)).toBe("—");
    expect(historyTime("")).toBe("—");
    expect(historyTime("not a date")).toBe("—");
  });

  it("created moment prefers created_at over created_date", () => {
    expect(quoteCreatedAt({ created_at: "2026-10-10T09:17:00Z", created_date: "2026-10-10" })).toBe("2026-10-10T09:17:00Z");
    expect(quoteCreatedAt({ created_at: null, created_date: "2026-10-10" })).toBe("2026-10-10");
    expect(quoteCreatedAt({})).toBeNull();
  });
});

describe("formatDate date-only values (R-815)", () => {
  it("long format of a date-only value has no time", () => {
    expect(formatDate("2026-10-10", "long")).toBe("10 Oct 2026");
    expect(formatDate("2026-01-01", "short")).toBe("1 Jan 2026");
  });

  it("long format of a timestamp still shows the IST time", () => {
    expect(formatDate("2026-10-10T09:17:00Z", "long")).toBe("10 Oct 2026 · 02:47 pm");
  });

  it("day and year follow IST, not the machine's zone", () => {
    // 31 Dec 2025 20:00 UTC = 1 Jan 2026 01:30 IST
    expect(formatDate("2025-12-31T20:00:00Z")).toBe("1 Jan 2026");
  });
});

describe("quote page Workflow history uses historyTime (R-815)", () => {
  const src = readFileSync(join(process.cwd(), "src/app/(app)/quotes/[id]/page.tsx"), "utf8");
  it("no history row formats created_date with a time", () => {
    expect(src).not.toMatch(/formatDate\(quote\.created_date,\s*"long"\)/);
    expect(src).toMatch(/historyTime\(quoteCreatedAt\(quote\)\)/);
  });
});
