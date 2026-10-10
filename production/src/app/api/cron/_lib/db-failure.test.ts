/**
 * R-702/R-704/R-706..R-709/R-711: a cron whose first database read fails says whether the
 * database was unreachable (one outage) or the query was wrong (a bug).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/ops/heartbeat", () => ({ pingHeartbeat: vi.fn() }));

import { cronDbFailure, DB_UNREACHABLE } from "./db-failure";
import { pingHeartbeat } from "@/lib/ops/heartbeat";

const unreachable = { message: "TypeError: fetch failed", details: "Caused by: ConnectTimeoutError: Connect Timeout Error (UND_ERR_CONNECT_TIMEOUT)", code: "" };

let stderr: string[];
beforeEach(() => {
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { stderr.push(a.join(" ")); });
  vi.mocked(pingHeartbeat).mockClear();
});

describe("cronDbFailure", () => {
  it("unreachable database → 503, dbUnreachable, one [cron/<job>] stderr line naming it", async () => {
    const r = cronDbFailure("gmail-inbox", unreachable, unreachable.message);
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("60");
    const body = await r.json();
    expect(body.dbUnreachable).toBe(true);
    expect(body.error).toBe(DB_UNREACHABLE);
    expect(stderr.some((l) => l.startsWith("[cron/gmail-inbox]") && l.includes("database unreachable"))).toBe(true);
    expect(pingHeartbeat).toHaveBeenCalledWith("gmail-inbox", false);
  });

  it("a thrown TypeError fetch failed is unreachable too", async () => {
    const e = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
    expect(cronDbFailure("billing", e, "fetch failed").status).toBe(503);
  });

  it("a real query fault stays 500 with the route's own text, now reported", async () => {
    const r = cronDbFailure("renewals", { message: "column x does not exist", code: "42703" }, "subs fetch failed: column x does not exist");
    expect(r.status).toBe(500);
    expect((await r.json()).error).toBe("subs fetch failed: column x does not exist");
    expect(stderr.some((l) => l.startsWith("[cron/renewals]"))).toBe(true);
  });
});

describe("wiring — the crons that failed on live use it at their first read", () => {
  it.each([
    "gmail-inbox", "ai-reply-retry", "attendance-reminders", "renewals", "billing", "invoice-dunning",
    "trial-expiry", "birthday-greetings", "compliance-reminders", "attendance-retention",
  ])("%s", (job) => {
    const src = readFileSync(join(__dirname, "..", job, "route.ts"), "utf8");
    expect(src).toContain(`cronDbFailure("${job}"`);
  });
});
