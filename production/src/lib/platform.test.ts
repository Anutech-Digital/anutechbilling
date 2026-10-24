/**
 * R-730 — the platform-admin allowlist reads the SERVER-ONLY env PLATFORM_ADMIN_EMAILS; the old
 * NEXT_PUBLIC_ name is only a server-side fallback while deploys are renamed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { isPlatformAdmin, platformAdminEmails } from "./platform";

const LEGACY = ["NEXT", "PUBLIC", "PLATFORM", "ADMIN", "EMAILS"].join("_");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("R-730 platform admin allowlist", () => {
  it("defaults to the operator only", () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "");
    vi.stubEnv(LEGACY, "");
    expect(platformAdminEmails()).toEqual(["pardeep@anutech.in"]);
  });

  it("reads PLATFORM_ADMIN_EMAILS (trimmed, lower-cased)", () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", " A@x.com , b@y.com ");
    expect(platformAdminEmails()).toEqual(["a@x.com", "b@y.com"]);
    expect(isPlatformAdmin("B@Y.com")).toBe(true);
    expect(isPlatformAdmin("pardeep@anutech.in")).toBe(false);
  });

  it("the new server-only name wins over the old public one", () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "new@x.com");
    vi.stubEnv(LEGACY, "old@x.com");
    expect(platformAdminEmails()).toEqual(["new@x.com"]);
  });

  it("falls back to the old name on the server so a deploy without the rename keeps working", () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "");
    vi.stubEnv(LEGACY, "old@x.com");
    expect(platformAdminEmails()).toEqual(["old@x.com"]);
  });

  it("never reads the old public name in a browser", () => {
    vi.stubEnv("PLATFORM_ADMIN_EMAILS", "");
    vi.stubEnv(LEGACY, "old@x.com");
    vi.stubGlobal("window", {});
    expect(platformAdminEmails()).toEqual(["pardeep@anutech.in"]);
  });

  it("no email → not admin", () => {
    expect(isPlatformAdmin(null)).toBe(false);
    expect(isPlatformAdmin("")).toBe(false);
  });
});
