/**
 * R-1458 (16 Oct 2026, Pawan): a customer who pressed "login" on the Anutech site, or hit a
 * broken link there, got a ResellerOS-branded screen — ResellerOS logo, ResellerOS tab title,
 * no way back to anutech.in. Rule: the sign-in pages and the 404 take their brand from the
 * host; anutech.in shows Anutech Digital and a "Back to anutech.in" link, every other host
 * (the product domain, staging, local) keeps ResellerOS exactly as before.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { brandForHost, hostFromHeaders } from "./host-brand";
import { NotFoundView } from "@/components/shared/not-found-view";

const code = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("brandForHost", () => {
  it("anutech.in and www.anutech.in are the Anutech Digital brand with a way back to the site", () => {
    for (const host of ["anutech.in", "www.anutech.in", "ANUTECH.IN:443"]) {
      const b = brandForHost(host);
      expect(b.site).toBe("company");
      expect(b.name).toBe("Anutech Digital");
      expect(b.logoSrc).toBe("/lp/anutech-logo.png");
      expect(b.back).toEqual({ href: "/", label: "Back to anutech.in" });
      expect(b.titleTemplate).toBe("%s · Anutech Digital");
      expect(b.titleTemplate).not.toMatch(/ResellerOS/);
    }
  });

  it("the product domain, staging and local keep ResellerOS with no back link (unchanged)", () => {
    for (const host of ["reselleros.anutech.in", "resellersos-staging-njvk4nxhdq-as.a.run.app", "localhost:3000", null, undefined, ""]) {
      const b = brandForHost(host);
      expect(b.site).toBe("product");
      expect(b.name).toBe("ResellerOS");
      expect(b.logoSrc).toBeNull();
      expect(b.back).toBeNull();
      expect(b.titleTemplate).toBe("%s · ResellerOS");
    }
  });

  it("reads x-forwarded-host first, then host", () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(hostFromHeaders(h({ "x-forwarded-host": "anutech.in", host: "x.run.app" }))).toBe("anutech.in");
    expect(hostFromHeaders(h({ host: "reselleros.anutech.in" }))).toBe("reselleros.anutech.in");
    expect(hostFromHeaders(h({}))).toBeNull();
  });
});

describe("404 on the Anutech site", () => {
  it("shows the Anutech brand and a way home — not the ResellerOS dashboard", () => {
    const html = renderToStaticMarkup(createElement(NotFoundView, { brand: brandForHost("anutech.in") }));
    expect(html).toContain("Anutech Digital");
    expect(html).toContain("Back to anutech.in");
    expect(html).not.toContain("/dashboard");
    expect(html).not.toContain("ResellerOS");
  });

  it("on the product domain it is unchanged: dashboard + home page", () => {
    const html = renderToStaticMarkup(createElement(NotFoundView, { brand: brandForHost("reselleros.anutech.in") }));
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Home page");
    expect(html).not.toContain("Anutech");
  });

  it("the root not-found page picks the brand and the tab title from the host", () => {
    const src = code("src/app/not-found.tsx");
    expect(src).toMatch(/export async function generateMetadata/);
    expect(src).toMatch(/brandForHost\(hostFromHeaders\(/);
    expect(src).toMatch(/<NotFoundView brand=\{brand\} \/>/);
  });
});

describe("sign-in pages on the Anutech site (login, signup, forgot-password share (auth)/layout)", () => {
  const layout = code("src/app/(auth)/layout.tsx");

  it("the layout takes the brand from the host, not a hard-coded ResellerOS", () => {
    expect(layout).toMatch(/brandForHost\(hostFromHeaders\(/);
    expect(layout).not.toMatch(/>ResellerOS</);
    expect(layout).toMatch(/\{brand\.name\}/);
  });

  it("the tab title follows the brand (Anutech Digital on anutech.in)", () => {
    expect(layout).toMatch(/export async function generateMetadata/);
    expect(layout).toMatch(/template: brand\.titleTemplate/);
  });

  it("shows the Back to anutech.in link when the brand has one", () => {
    expect(layout).toMatch(/brand\.back &&/);
    expect(layout).toMatch(/\{brand\.back\.label\}/);
  });
});
