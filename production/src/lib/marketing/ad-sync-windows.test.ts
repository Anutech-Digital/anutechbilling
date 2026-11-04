import { describe, expect, it } from "vitest";
import { adSyncChunks } from "./ad-sync-windows";

describe("manual ad sync windows", () => {
  it("splits a long Google or Meta selection into non-overlapping requests", () => {
    for (const platform of ["google-ads", "meta-ads"] as const) {
      const chunks = adSyncChunks(platform, "2026-01-01", "2026-07-01", "2026-11-04");
      expect(chunks).toEqual([
        { platform, from: "2026-01-01", to: "2026-03-31", granularity: "DAILY" },
        { platform, from: "2026-04-01", to: "2026-06-29", granularity: "DAILY" },
        { platform, from: "2026-06-30", to: "2026-07-01", granularity: "DAILY" },
      ]);
    }
  });

  it("uses monthly LinkedIn history and daily recent data", () => {
    const chunks = adSyncChunks("linkedin-ads", "2025-01-01", "2026-11-04", "2026-11-04");
    expect(chunks[0]).toEqual({ platform: "linkedin-ads", from: "2025-01-01", to: "2025-12-31", granularity: "MONTHLY" });
    expect(chunks.at(-1)?.granularity).toBe("DAILY");
  });

  it("refuses an invalid custom range", () => {
    expect(() => adSyncChunks("meta-ads", "2026-12-01", "2026-11-04", "2026-11-04")).toThrow();
  });

  it("clips all-time Meta sync to its available recent history", () => {
    const chunks = adSyncChunks("meta-ads", "2016-12-01", "2026-11-04", "2026-11-04");
    expect(chunks[0].from).toBe("2023-11-04");
    expect(chunks.at(-1)?.to).toBe("2026-11-04");
  });
});
