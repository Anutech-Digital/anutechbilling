/**
 * getWebsiteTheme — the (marketing) layout's read of tenants.website_theme: one narrow read of
 * the website company's row, cached; a missing column (before the migration) and a failed read
 * both show the classic look, and a failed read keeps the last good answer first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const db = vi.hoisted(() => ({
  calls: [] as { table: string; columns: string; filters: [string, unknown][] }[],
  result: { data: null as unknown, error: null as { code?: string; message: string } | null },
  throws: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (columns: string) => {
        const call = { table, columns, filters: [] as [string, unknown][] };
        db.calls.push(call);
        const chain = {
          eq: (c: string, v: unknown) => { call.filters.push([c, v]); return chain; },
          maybeSingle: () => (db.throws ? Promise.reject(new Error("connect timeout")) : Promise.resolve(db.result)),
        };
        return chain;
      },
    }),
  }),
}));

import { WEBSITE_THEME_TTL_MS, forgetWebsiteThemeForTests, getWebsiteTheme, rememberWebsiteTheme } from "./website-theme.server";

const T = "5b0c7a3e-4d2f-4e61-9a8b-2c1d0e9f7a64";

beforeEach(() => {
  forgetWebsiteThemeForTests();
  db.calls.length = 0;
  db.result = { data: null, error: null };
  db.throws = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("getWebsiteTheme", () => {
  it("reads only website_theme, only on the website company's row", async () => {
    db.result = { data: { website_theme: "warm" }, error: null };
    expect(await getWebsiteTheme(T)).toBe("warm");
    expect(db.calls).toEqual([{ table: "tenants", columns: "website_theme", filters: [["id", T]] }]);
  });

  it("with no website company configured: classic, and no read at all", async () => {
    expect(await getWebsiteTheme(null)).toBe("classic");
    expect(db.calls).toHaveLength(0);
  });

  it("caches for the TTL, then reads again", async () => {
    db.result = { data: { website_theme: "warm" }, error: null };
    await getWebsiteTheme(T, 1_000);
    await getWebsiteTheme(T, 1_000 + WEBSITE_THEME_TTL_MS - 1);
    expect(db.calls).toHaveLength(1);
    db.result = { data: { website_theme: "classic" }, error: null };
    expect(await getWebsiteTheme(T, 1_000 + WEBSITE_THEME_TTL_MS)).toBe("classic");
    expect(db.calls).toHaveLength(2);
  });

  it("before the migration (no such column): classic, quietly — that is the expected state", async () => {
    db.result = { data: null, error: { code: "42703", message: "column tenants.website_theme does not exist" } };
    expect(await getWebsiteTheme(T)).toBe("classic");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("a failed read keeps the last good theme, and says so", async () => {
    db.result = { data: { website_theme: "warm" }, error: null };
    await getWebsiteTheme(T, 1_000);
    db.throws = true;
    expect(await getWebsiteTheme(T, 1_000 + WEBSITE_THEME_TTL_MS)).toBe("warm");
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/read failed \(connect timeout\) — keeping the warm theme/));
  });

  it("a failed read with nothing to keep shows classic and logs an error, never a silent guess", async () => {
    db.throws = true;
    expect(await getWebsiteTheme(T)).toBe("classic");
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/read failed \(connect timeout\) — showing the classic theme/));
  });

  it("an unknown stored value is a failure, not a theme", async () => {
    db.result = { data: { website_theme: "violet" }, error: null };
    expect(await getWebsiteTheme(T)).toBe("classic");
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/unknown website_theme value "violet"/));
  });

  it("a missing company row is a failure that names BUY_PAGE_TENANT_ID", async () => {
    db.result = { data: null, error: null };
    expect(await getWebsiteTheme(T)).toBe("classic");
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/BUY_PAGE_TENANT_ID/));
  });

  it("after a switch, this server answers the new theme at once", async () => {
    db.result = { data: { website_theme: "classic" }, error: null };
    await getWebsiteTheme(T, 1_000);
    rememberWebsiteTheme(T, "warm", 2_000);
    expect(await getWebsiteTheme(T, 2_001)).toBe("warm");
    expect(db.calls).toHaveLength(1);
  });
});
