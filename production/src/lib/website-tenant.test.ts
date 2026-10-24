/**
 * R-1499 — a laptop's website forms never fall back to the LIVE tenant; production is unchanged.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LIVE_WEBSITE_TENANT_ID, WEBSITE_TENANT_MISSING_MESSAGE, websiteTenantId } from "./website-tenant";

const adminCalls = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => {
    adminCalls();
    throw new Error("the database must not be touched");
  },
  createClient: () => { throw new Error("no"); },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  adminCalls.mockReset();
});

describe("websiteTenantId", () => {
  it("env set → that tenant, in every build", () => {
    expect(websiteTenantId({ BUY_PAGE_TENANT_ID: " abc ", NODE_ENV: "development" })).toBe("abc");
    expect(websiteTenantId({ BUY_PAGE_TENANT_ID: "abc", NODE_ENV: "production" })).toBe("abc");
  });
  it("production, unset → the live tenant exactly as before", () => {
    expect(websiteTenantId({ NODE_ENV: "production" })).toBe(LIVE_WEBSITE_TENANT_ID);
  });
  it("laptop / test, unset → null, never the live tenant", () => {
    expect(websiteTenantId({ NODE_ENV: "development" })).toBeNull();
    expect(websiteTenantId({ NODE_ENV: "test", BUY_PAGE_TENANT_ID: "  " })).toBeNull();
  });
  it("the refusal says what to set (§24)", () => {
    expect(WEBSITE_TENANT_MISSING_MESSAGE).toMatch(/nothing was saved/i);
    expect(WEBSITE_TENANT_MISSING_MESSAGE).toContain("BUY_PAGE_TENANT_ID");
    expect(WEBSITE_TENANT_MISSING_MESSAGE).toContain(".env.local");
  });
});

describe("a website form on a laptop without BUY_PAGE_TENANT_ID", () => {
  it("/api/public/enquiry/general refuses with 503 + the message, before any database call", async () => {
    vi.stubEnv("BUY_PAGE_TENANT_ID", "");
    vi.stubEnv("NODE_ENV", "development");
    const { POST } = await import("@/app/api/public/enquiry/general/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest("http://localhost:3001/api/public/enquiry/general", {
      method: "POST",
      body: JSON.stringify({ fullName: "T", email: "t@anutech.test", phone: "9876543210" }),
    }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("WEBSITE_TENANT_MISSING");
    expect(body.error).toContain("BUY_PAGE_TENANT_ID");
    expect(adminCalls).not.toHaveBeenCalled();
  });
});

describe("no website file carries the live tenant id as a fallback any more", () => {
  const ROOTS = ["src/app/api/public", "src/app/(public)", "src/app/api/dms", "src/lib/hosting"].map((r) => join(process.cwd(), r));
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) && !p.includes(".test.") ? [p] : [];
    });
  it("fbb976f1 appears in none of them", () => {
    const offenders = ROOTS.flatMap(walk).filter((f) => readFileSync(f, "utf8").includes("fbb976f1"));
    expect(offenders).toEqual([]);
  });
});
