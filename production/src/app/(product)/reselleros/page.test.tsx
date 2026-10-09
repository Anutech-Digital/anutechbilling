/**
 * R-520: the ResellerOS homepage renders as a product page only — what it is, who it is for,
 * features, the one pricing line, Log in + Start free trial — and none of the company site's
 * offer (domains / hosting prices / custom software) or the R-461/R-463 problems.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const auth = { user: null as null | { id: string } };
const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); });

vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
}));

import Page, { metadata } from "./page";
import ProductLayout from "../layout";
import { HOME, PRICING_LINE } from "@/site/lib/data/reselleros-home";

async function render(preview?: string): Promise<string> {
  const el = await Page({ searchParams: Promise.resolve(preview ? { preview } : {}) });
  return renderToStaticMarkup(<ProductLayout>{el}</ProductLayout>);
}

beforeEach(() => { auth.user = null; redirect.mockClear(); });

describe("ResellerOS homepage", () => {
  it("says what it is, who it is for, and shows the features", async () => {
    const html = await render();
    expect(html).toContain("<h1");
    expect(html).toContain(HOME.headline);
    for (const w of HOME.who) expect(html).toContain(w.title);
    for (const f of HOME.features) expect(html).toContain(f.title);
    expect(html).toContain('id="features"');
  });

  it("has Log in and Start free trial, pointing at the app's own pages", async () => {
    const html = await render();
    expect(html).toMatch(/href="\/login"[^>]*>Log in</);
    expect(html).toMatch(/href="\/signup"[^>]*>Start free trial</);
    expect(html).toContain('href="/pricing"');
  });

  it("one pricing message only (R-463) and no demo that needs a login (R-461)", async () => {
    const html = await render();
    expect(html).toContain(PRICING_LINE);
    expect(html).not.toMatch(/14-day/i);
    expect(html).not.toMatch(/interactive demo/i);
    expect(html).not.toContain("resellersos.in");
    expect(html).not.toMatch(/Resellersos/); // brand is spelled ResellerOS
  });

  it("is ResellerOS only — no company offer on this site", async () => {
    const html = await render();
    expect(html).not.toMatch(/₹249|₹49\.99|custom software|office automation/i);
    expect(html).not.toContain('href="/domains"');
    expect(html).not.toContain('href="/hosting"');
    expect(html).not.toContain("AI sales agent");
  });

  it("canonical is the product origin", () => {
    expect(metadata.alternates?.canonical).toBe("https://reselleros.anutech.in/");
  });

  it("a signed-in user goes to the dashboard unless ?preview=1", async () => {
    auth.user = { id: "u1" };
    await expect(render()).rejects.toThrow("REDIRECT /dashboard");
    await expect(render("1")).resolves.toContain(HOME.headline);
  });
});
