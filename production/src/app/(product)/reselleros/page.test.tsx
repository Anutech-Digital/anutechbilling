/**
 * R-520: the ResellerOS homepage renders as a product page only — what it is, who it is for,
 * features, the one pricing line, Log in + Get started free — and none of the company site's
 * offer (domains / hosting prices / custom software) or the R-461/R-463 problems.
 * R-524 (owner decisions): Free during beta, no trial wording (homepage + /signup), no price
 * figure, "Try the demo" only when DEMO_ENABLED=1, screenshot slots only when the file exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

const auth = { user: null as null | { id: string } };
const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); });
const disk = vi.hoisted(() => ({ files: new Set<string>() }));

vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
}));
/* Screenshot files: the page asks existsSync; the test decides which ones are "on disk". */
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  const existsSync = (p: unknown) => [...disk.files].some((f) => String(p).replace(/\\/g, "/").endsWith(f));
  return { ...real, existsSync, default: { ...real, existsSync } };
});

import Page, { metadata } from "./page";
import ProductLayout from "../layout";
import { HOME, PRICING_LINE, SCREENS } from "@/site/lib/data/reselleros-home";

async function render(preview?: string, demo?: string): Promise<string> {
  const el = await Page({ searchParams: Promise.resolve({ ...(preview ? { preview } : {}), ...(demo ? { demo } : {}) }) });
  return renderToStaticMarkup(<ProductLayout>{el}</ProductLayout>);
}

beforeEach(() => { auth.user = null; redirect.mockClear(); disk.files.clear(); delete process.env.DEMO_ENABLED; });
afterEach(() => { delete process.env.DEMO_ENABLED; });

describe("ResellerOS homepage", () => {
  it("says what it is, who it is for, and shows the features", async () => {
    const html = await render();
    expect(html).toContain("<h1");
    expect(html).toContain(HOME.headline);
    for (const w of HOME.who) expect(html).toContain(w.title);
    for (const f of HOME.features) expect(html).toContain(f.title);
    expect(html).toContain('id="features"');
  });

  it("has Log in and Get started free, pointing at the app's own pages", async () => {
    const html = await render();
    expect(html).toMatch(/href="\/login"[^>]*>Log in</);
    expect(html).toMatch(/href="\/signup"[^>]*>Get started free</);
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

  it("R-524: Free during beta, and no trial wording — homepage and /signup", async () => {
    const html = await render();
    expect(PRICING_LINE).toMatch(/Free during beta/);
    expect(html).toContain("Free during beta");
    expect(html).not.toMatch(/trial/i);
    const signup = readFileSync("src/app/(auth)/signup/page.tsx", "utf8");
    expect(signup).not.toMatch(/14-day|free trial|start.{0,10}trial/i);
    expect(signup).toContain("{PRICING_LINE}");
  });

  it("R-524: no price figure on the homepage (the /pricing page keeps the plans)", async () => {
    const html = await render();
    expect(html).not.toContain("₹");
    expect(html).not.toMatch(/\bfrom\s+(₹|Rs)/i);
    expect(html).toContain('href="/pricing"');
  });

  it("R-524: no demo button while DEMO_ENABLED is off (the default)", async () => {
    const html = await render();
    expect(html).not.toContain(HOME.ctaDemo);
    expect(html).not.toContain("/api/demo/session");
  });

  it("R-524: with DEMO_ENABLED=1, Try the demo is a POST form to /api/demo/session", async () => {
    process.env.DEMO_ENABLED = "1";
    const html = await render();
    expect(html).toMatch(/<form action="\/api\/demo\/session" method="post"><button type="submit"[^>]*>Try the demo<\/button><\/form>/);
    expect(html).toContain(HOME.demoNote);
  });

  it("R-524: says why the demo did not open (?demo=…) and ignores unknown reasons", async () => {
    expect(await render(undefined, "ended")).toContain(HOME.demoMessages.ended);
    expect(await render(undefined, "busy")).toContain(HOME.demoMessages.busy);
    expect(await render(undefined, "<script>")).not.toContain('data-testid="demo-message"');
  });

  it("R-524: screenshot slots show only when the file is in public/site/screens, with alt text", async () => {
    expect(await render()).not.toContain('data-testid="screens"');
    disk.files.add(SCREENS[0].src);
    const html = await render();
    expect(html).toContain('data-testid="screens"');
    expect(html).toContain(`src="${SCREENS[0].src}"`);
    expect(html).toContain(`alt="${SCREENS[0].alt}"`);
    expect(html).not.toContain(SCREENS[1].src);
    for (const s of SCREENS) {
      expect(s.src).toMatch(/^\/site\/screens\/[a-z-]+\.png$/);
      expect(s.alt.length).toBeGreaterThan(20);
    }
  });
});
