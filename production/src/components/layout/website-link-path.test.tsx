// @vitest-environment jsdom
/**
 * R-1500 — Pawan (staging report 74591baa): a signed-in user clicks account menu → "Website ↗"
 * and the new tab shows the dashboard, not the public homepage. R-1453 pointed the link at
 * PRODUCT_HOME_ROUTE (/reselleros), but that page sends every signed-in user to /dashboard
 * unless the URL carries ?preview=1 — and the link did not.
 *
 * This test follows the whole path of the link's real href, the way the request travels:
 *   staging/local host  → middleware serves /reselleros as is → page;
 *   reselleros.anutech.in → middleware 301s /reselleros to "/" (query kept) → rewrites "/" to
 *                           /reselleros (query kept) → page;
 * and at the end the page must render for a SIGNED-IN user instead of redirecting.
 * The bare product root without ?preview=1 still sends a signed-in user to the dashboard
 * (that behaviour is not this link's to change).
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const auth = { user: null as null | { id: string } };
const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); });
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
/* R-1508: the page also reads the website-preview cookie; this browser has not opened the preview. */
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
}));

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AccountMenuItems } from "./account-menu-items";
import { decideSite, PRODUCT_HOME_ROUTE } from "@/site/lib/site-split";
import ResellerOsHome from "@/app/(product)/reselleros/page";

beforeEach(() => { auth.user = { id: "signed-in-user" }; redirect.mockClear(); });
afterEach(() => cleanup());

function websiteHref(): string {
  render(
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Account</DropdownMenuTrigger>
      <DropdownMenuContent>
        <AccountMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  const href = screen.getByRole("menuitem", { name: /website/i }).closest("a")?.getAttribute("href");
  expect(href).toBeTruthy();
  return href as string;
}

/** Follow middleware decisions for a GET on `host` until the page route is reached. */
function followMiddleware(host: string, href: string): URL {
  let url = new URL(href, `https://${host}`);
  for (let hop = 0; hop < 5; hop++) {
    const d = decideSite(url.host, url.pathname, url.search, "GET");
    if (d.action === "serve") return url;
    if (d.action === "rewrite") {
      const next = new URL(url.toString());
      next.pathname = d.pathname;
      return next;
    }
    url = new URL(d.location);
  }
  throw new Error("redirect loop");
}

async function pageFor(url: URL): Promise<void> {
  expect(url.pathname).toBe(PRODUCT_HOME_ROUTE);
  const sp: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { sp[k] = v; });
  await ResellerOsHome({ searchParams: Promise.resolve(sp) });
}

describe("account menu Website link reaches the public homepage for a signed-in user (R-1500)", () => {
  it("staging / local host: the page renders, no bounce to /dashboard", async () => {
    const url = followMiddleware("resellersos-staging-njvk4nxhdq-as.a.run.app", websiteHref());
    await expect(pageFor(url)).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("live product host: 301 + rewrite keep the preview flag, the page renders", async () => {
    const url = followMiddleware("reselleros.anutech.in", websiteHref());
    await expect(pageFor(url)).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("company host anutech.in: 301 to the product host keeps the flag, the page renders", async () => {
    const url = followMiddleware("anutech.in", websiteHref());
    expect(url.host).toBe("reselleros.anutech.in");
    await expect(pageFor(url)).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("unchanged: the bare product root still sends a signed-in user to the dashboard", async () => {
    await expect(pageFor(followMiddleware("localhost:3001", PRODUCT_HOME_ROUTE))).rejects.toThrow("REDIRECT /dashboard");
  });
});
