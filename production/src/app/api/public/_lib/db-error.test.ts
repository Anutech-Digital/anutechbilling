/**
 * Public routes never send Postgres's own error text (R-026, 1 Oct 2026). The helper, and a scan
 * of every public route so a new `error.message` in a response fails here.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { publicDbError } from "./db-error";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

afterEach(() => vi.restoreAllMocks());

describe("publicDbError", () => {
  it("a fault: the caller gets the route's sentence, the raw text goes to the log only", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = publicDbError("x", { code: "23505", message: 'duplicate key value violates unique constraint "coupons_pkey"' }, "Try again.");
    expect(e).toEqual({ status: 500, message: "Try again." });
    expect(String(log.mock.calls[0][0])).toMatch(/\[api\/public\/x\] failed: 23505 duplicate key/);
  });
  it("a message a function raised for this person passes, with the route's status for that code", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(publicDbError("x", { code: "P0001", message: "Wrong PIN" }, "Try again.", { passCodes: { P0001: 400 } })).toEqual({ status: 400, message: "Wrong PIN" });
  });
  it("a code the route did not list is hidden, even a P0001", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(publicDbError("x", { code: "P0001", message: "quote Q-1 does not belong to your tenant" }, "Try again.")).toEqual({ status: 500, message: "Try again." });
  });
});

describe("no public route sends raw database error text", () => {
  const ROOT = join(process.cwd(), "src/app/api/public");
  const routes: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n === "route.ts") routes.push(p); } };
  walk(ROOT);
  it("guard: the scan found the public routes", () => {
    expect(routes.length).toBeGreaterThan(15);
  });
  it("no response body carries a database error's .message", () => {
    const bad = routes.filter((f) => {
      const code = readSource(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      return /json\([^)]*\b\w*(error|Err)\.message/.test(code);
    });
    expect(bad).toEqual([]);
  });
});
