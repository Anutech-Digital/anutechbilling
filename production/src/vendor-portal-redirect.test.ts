/**
 * R-1545 (19 Oct 2026, owner decision HATAO) — /vendor-portal was only a "not built yet"
 * notice. The page is removed; the URL redirects to the real vendor screen so old bookmarks
 * still land somewhere useful. This pins the redirect and that the page and its role/route
 * entries do not come back half-way.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — next.config.mjs is plain JS with no type declarations.
import nextConfig from "../next.config.mjs";
import { OFF_MENU_ROLES, NOT_IN_NAV } from "@/lib/nav";

type Redirect = { source: string; destination: string; permanent: boolean };
type ConfigWithRedirects = { redirects: () => Promise<Redirect[]> };

describe("/vendor-portal redirect (R-1545)", () => {
  it("sends /vendor-portal and anything under it to /accounting/vendors", async () => {
    const list = await (nextConfig as ConfigWithRedirects).redirects();
    for (const source of ["/vendor-portal", "/vendor-portal/:path*"]) {
      const r = list.find((x) => x.source === source);
      expect(r, `${source} has no redirect`).toBeDefined();
      expect(r?.destination).toBe("/accounting/vendors");
    }
  });

  it("has no page file and no nav/role entries left", () => {
    expect(fs.existsSync(path.join(__dirname, "app", "(app)", "vendor-portal"))).toBe(false);
    expect(OFF_MENU_ROLES["/vendor-portal"]).toBeUndefined();
    expect(NOT_IN_NAV["/vendor-portal"]).toBeUndefined();
  });
});
