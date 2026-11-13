/**
 * Website theme switch — the pure rules: which values exist, who may switch, and how a
 * not-yet-migrated database is recognised.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_WEBSITE_THEME,
  WEBSITE_THEMES,
  isWebsiteThemeColumnMissing,
  parseWebsiteTheme,
  websiteThemeAccess,
} from "./website-theme";

const SITE = "5b0c7a3e-4d2f-4e61-9a8b-2c1d0e9f7a64";
const OTHER = "9d1e2f3a-0b4c-4d5e-8f6a-7b8c9d0e1f2a";

describe("parseWebsiteTheme", () => {
  it("knows exactly classic and warm", () => {
    expect(WEBSITE_THEMES).toEqual(["classic", "warm"]);
    expect(parseWebsiteTheme("classic")).toBe("classic");
    expect(parseWebsiteTheme("warm")).toBe("warm");
  });
  it("never guesses: anything else is null, not a fallback theme", () => {
    for (const v of ["Warm", "blue", "", " warm", null, undefined, 1, {}]) {
      expect(parseWebsiteTheme(v)).toBeNull();
    }
  });
  it("defaults to classic, so deploying the switch changes no website", () => {
    expect(DEFAULT_WEBSITE_THEME).toBe("classic");
  });
});

describe("websiteThemeAccess — owner of the website's workspace only", () => {
  const owner = { signedIn: true, role: "owner", tenantId: SITE, websiteTenantId: SITE };

  it("lets the website workspace's owner switch", () => {
    expect(websiteThemeAccess(owner)).toEqual({ ok: true });
  });
  it("refuses a signed-out caller with 401", () => {
    const r = websiteThemeAccess({ ...owner, signedIn: false });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });
  it("refuses admins, managers and everyone else in the website workspace", () => {
    for (const role of ["admin", "manager", "accountant", "sales", null]) {
      const r = websiteThemeAccess({ ...owner, role });
      expect(r).toMatchObject({ ok: false, status: 403 });
      if (!r.ok) expect(r.error).toMatch(/Only the workspace owner/);
    }
  });
  it("refuses the owner of ANOTHER workspace — it has no website here", () => {
    const r = websiteThemeAccess({ ...owner, tenantId: OTHER });
    expect(r).toMatchObject({ ok: false, status: 403 });
    if (!r.ok) expect(r.error).toMatch(/owns the public website/);
  });
  it("refuses when the server does not know the website company (503, ours to fix), never guessing one", () => {
    const r = websiteThemeAccess({ ...owner, websiteTenantId: null });
    expect(r).toMatchObject({ ok: false, status: 503 });
    if (!r.ok) expect(r.error).toMatch(/BUY_PAGE_TENANT_ID/);
  });
  it("every refusal says what to do next (§24)", () => {
    const cases = [
      websiteThemeAccess({ ...owner, signedIn: false }),
      websiteThemeAccess({ ...owner, role: "admin" }),
      websiteThemeAccess({ ...owner, tenantId: OTHER }),
      websiteThemeAccess({ ...owner, websiteTenantId: null }),
    ];
    for (const r of cases) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(40);
    }
  });
});

describe("isWebsiteThemeColumnMissing", () => {
  it("recognises Postgres and PostgREST 'no such column'", () => {
    expect(isWebsiteThemeColumnMissing({ code: "42703", message: 'column tenants.website_theme does not exist' })).toBe(true);
    expect(isWebsiteThemeColumnMissing({ code: "PGRST204", message: "Could not find the 'website_theme' column" })).toBe(true);
    expect(isWebsiteThemeColumnMissing({ message: "Could not find the 'website_theme' column of 'tenants'" })).toBe(true);
  });
  it("does not mistake other failures for it", () => {
    expect(isWebsiteThemeColumnMissing(null)).toBe(false);
    expect(isWebsiteThemeColumnMissing({ code: "42501", message: "permission denied for table tenants" })).toBe(false);
    expect(isWebsiteThemeColumnMissing({ message: "connect timeout" })).toBe(false);
  });
});
