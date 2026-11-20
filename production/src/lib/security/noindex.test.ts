/**
 * NOINDEX=true (staging): X-Robots-Tag on every response and robots.txt "Disallow: /".
 * Unset (production): no header, robots.txt unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers({ host: "reselleros.anutech.in" }) }));

import { NOINDEX_HEADER_VALUE, noindexEnabled, withNoindex } from "./noindex";
import robots from "@/app/robots";

afterEach(() => { delete process.env.NOINDEX; });

describe("NOINDEX", () => {
  it("is off unless exactly true", () => {
    expect(noindexEnabled()).toBe(false);
    process.env.NOINDEX = "1";
    expect(noindexEnabled()).toBe(false);
    process.env.NOINDEX = "TRUE";
    expect(noindexEnabled()).toBe(true);
  });

  it("adds X-Robots-Tag only when on", () => {
    expect(withNoindex(new Response("x")).headers.get("x-robots-tag")).toBeNull();
    process.env.NOINDEX = "true";
    expect(withNoindex(new Response("x")).headers.get("x-robots-tag")).toBe(NOINDEX_HEADER_VALUE);
  });

  it("robots.txt disallows everything when on and is unchanged when off", async () => {
    const prod = await robots();
    expect(JSON.stringify(prod.rules)).toContain("/dashboard");
    expect(prod.sitemap).toBeTruthy();
    process.env.NOINDEX = "true";
    const staging = await robots();
    expect(staging).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
  });

  it("middleware wraps every answer with withNoindex", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(`${__dirname}/../../middleware.ts`, "utf8");
    expect(src).toMatch(/export async function middleware\(request: NextRequest\) \{\s*return withNoindex\(await routeRequest\(request\)\);\s*\}/);
  });
});
