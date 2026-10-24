/**
 * R-1827 (24 Oct 2026) — /google-workspace had no page and answered 404 on staging. The Google
 * Workspace page is /lp/google-workspace; /google-workspace/pricing is its own page and must keep
 * working. This pins the alias and that it does not swallow the pricing page.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — next.config.mjs is plain JS with no type declarations.
import nextConfig from "../next.config.mjs";

type Redirect = { source: string; destination: string; permanent: boolean };
type ConfigWithRedirects = { redirects: () => Promise<Redirect[]> };

const app = path.join(__dirname, "app");

describe("/google-workspace alias (R-1827)", () => {
  it("permanently redirects /google-workspace to /lp/google-workspace", async () => {
    const list = await (nextConfig as ConfigWithRedirects).redirects();
    const r = list.find((x) => x.source === "/google-workspace");
    expect(r, "/google-workspace has no redirect").toBeDefined();
    expect(r?.destination).toBe("/lp/google-workspace");
    expect(r?.permanent).toBe(true);
  });

  it("the redirect target is a real page", () => {
    expect(fs.existsSync(path.join(app, "(lp)", "lp", "google-workspace", "page.tsx"))).toBe(true);
  });

  it("leaves /google-workspace/pricing alone (exact path, no wildcard)", async () => {
    const list = await (nextConfig as ConfigWithRedirects).redirects();
    const claims = list.filter((x) => x.source.startsWith("/google-workspace"));
    expect(claims.map((x) => x.source)).toEqual(["/google-workspace"]);
    expect(fs.existsSync(path.join(app, "(marketing)", "google-workspace", "pricing", "page.tsx"))).toBe(true);
  });

  it("no page.tsx sits at /google-workspace (a page there would make the redirect ambiguous)", () => {
    expect(fs.existsSync(path.join(app, "(marketing)", "google-workspace", "page.tsx"))).toBe(false);
  });
});
