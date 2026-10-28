// @vitest-environment jsdom
/**
 * R-2027 (27 Oct 2026): on the first load after a server start the price read timed out and the
 * page priced itself from FALLBACK_TIERS — typed prices (270 / 1,080, 325 / 1,300) that would be
 * wrong the day the catalogue changes, while checkout charges the catalogue. Now, when the server
 * could not read the price list (catalogItems null), the page shows "Loading prices…" with every
 * buy button locked, asks GET /api/public/catalog/buy-workspace, and fills the real prices; if
 * that fails too it says prices are not available, with Try again and Talk to us — never a typed
 * price. Desktop v2 and the phone flow alike.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";
import { BuyMobileClient } from "./_mobile/buy-mobile-client";
import type { BuyBrand } from "./_parts/brand";

const BRAND: BuyBrand = {
  name: "Tenant Seller Pvt Ltd", logoUrl: null, gstin: "07AAAAA0000A1Z5",
  address: "12 Test Road, Rohini, Delhi 110085", stateCode: "07", phone: "8800000000", email: null,
};
/* What the endpoint sends: only the priced fields (no wholesale, no margin). Prices differ from
   the old typed ones, so a fallback price on screen is caught. */
const WIRE = [
  { id: "s", name: "Google Workspace Business Starter", msrp: 299, prices: { annual: { msrp: 299 }, monthly: { msrp: 360 } } },
  { id: "d", name: "Google Workspace Business Standard", msrp: 1199, prices: { annual: { msrp: 1199 }, monthly: { msrp: 1440 } } },
  { id: "p", name: "Google Workspace Business Plus", msrp: 0, prices: {} },
];
const SERVER: CatalogItem[] = WIRE.map((w) => ({
  ...w, wholesale: 0, margin_pct: null, is_active: true,
  prices: Object.fromEntries(Object.entries(w.prices).map(([k, v]) => [k, { msrp: (v as { msrp: number }).msrp, wholesale: 0 }])),
}));
/** The old typed prices — none may ever be on the page. */
const TYPED = /₹\s?(270|325|1,080|1,300)\b/;

let catalogCalls = 0;
let release: (() => void) | null = null;
const fetchCatalog = (answer: { status: number; body: unknown }, opts: { hold?: boolean } = {}) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/public/catalog/buy-workspace")) {
      catalogCalls++;
      if (opts.hold) await new Promise<void>((r) => { release = r; });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    return new Response("{}", { status: 200 });
  }));
const OK = { status: 200, body: { items: WIRE } };
const DOWN = { status: 503, body: { items: null } };

beforeEach(() => {
  catalogCalls = 0; release = null;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.history.replaceState(null, "", "/buy/workspace");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const text = () => document.body.textContent ?? "";
const buyNow = () => within(document.querySelector("header") as HTMLElement).getByRole("button", { name: /Buy now|Loading prices/ });

describe("R-2027 desktop /buy/workspace — no prices from the server", () => {
  it("shows 'Loading prices…' with Buy locked, then the catalogue prices from the endpoint", async () => {
    fetchCatalog(OK, { hold: true });
    render(<BuyWorkspaceClient catalogItems={null} paymentMode="simulation" brand={BRAND} />);
    expect(screen.getAllByText(/Loading prices/).length).toBeGreaterThan(0);
    expect(text()).not.toMatch(/₹/);
    expect((buyNow() as HTMLButtonElement).disabled).toBe(true);
    /* every buy action is locked (FAQ questions that mention "buy" are not actions) */
    const actions = screen.queryAllByRole("button", { name: /^(Buy now|Buy .+|Choose .+|Continue.*|Checkout.*|Pay.*|Loading prices…)$/ });
    expect(actions.length).toBeGreaterThan(0);
    for (const b of actions) expect((b as HTMLButtonElement).disabled, b.textContent ?? "").toBe(true);
    await waitFor(() => expect(release).toBeTruthy());
    release!();
    await waitFor(() => expect(screen.getByTestId("plan-price-starter").textContent).toContain("₹299"));
    expect(screen.getByTestId("plan-price-standard").textContent).toContain("₹1,199");
    expect(screen.queryByText(/Loading prices/)).toBeNull();
    expect((within(document.querySelector("header") as HTMLElement).getByRole("button", { name: "Buy now" }) as HTMLButtonElement).disabled).toBe(false);
    expect(text()).not.toMatch(TYPED);
    expect(catalogCalls).toBe(1);
  });

  it("the endpoint fails too → 'prices are not available' with Try again and Talk to us — no typed price", async () => {
    fetchCatalog(DOWN);
    render(<BuyWorkspaceClient catalogItems={null} paymentMode="simulation" brand={BRAND} />);
    await waitFor(() => expect(screen.getByText(/Online prices are not available right now/)).toBeTruthy());
    expect(text()).not.toMatch(/₹/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Talk to us|Call|WhatsApp/ }).length).toBeGreaterThan(0);
    /* Try again asks once more and fills the prices */
    fetchCatalog(OK);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("plan-price-starter").textContent).toContain("₹299"));
  });

  it("a malformed answer is not shown as prices", async () => {
    fetchCatalog({ status: 200, body: { items: [{ id: "s", name: "Google Workspace Business Starter", msrp: "free" }] } });
    render(<BuyWorkspaceClient catalogItems={null} paymentMode="simulation" brand={BRAND} />);
    await waitFor(() => expect(screen.getByText(/Online prices are not available right now/)).toBeTruthy());
    expect(text()).not.toMatch(/₹/);
  });

  it("an empty catalogue → not available (contact us), never the typed plans", async () => {
    fetchCatalog(OK);
    render(<BuyWorkspaceClient catalogItems={[]} paymentMode="simulation" brand={BRAND} />);
    expect(screen.getByText(/Online prices are not available right now/)).toBeTruthy();
    expect(text()).not.toMatch(/₹/);
    expect(catalogCalls).toBe(0);
  });

  it("prices from the server → no extra request, page priced at once", () => {
    fetchCatalog(OK);
    render(<BuyWorkspaceClient catalogItems={SERVER} paymentMode="simulation" brand={BRAND} />);
    expect(screen.getByTestId("plan-price-starter").textContent).toContain("₹299");
    expect(catalogCalls).toBe(0);
  });
});

describe("R-2027 phone flow — no prices from the server", () => {
  it("'Loading prices…' with Continue locked, then the catalogue prices", async () => {
    fetchCatalog(OK, { hold: true });
    render(<BuyMobileClient catalogItems={null} paymentMode="simulation" brand={BRAND} initialSearch={{ intent: "new", seats: "1", tier: "starter" }} />);
    expect(screen.getAllByText(/Loading prices/).length).toBeGreaterThan(0);
    expect(text()).not.toMatch(/₹/);
    const locked = screen.getByRole("button", { name: /Loading prices/ }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    await waitFor(() => expect(release).toBeTruthy());
    release!();
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy());
    expect(text()).toMatch(/₹/);
    expect(text()).not.toMatch(TYPED);
  });

  it("the endpoint fails → not available + Try again, no price", async () => {
    fetchCatalog(DOWN);
    render(<BuyMobileClient catalogItems={null} paymentMode="simulation" brand={BRAND} initialSearch={{ intent: "new" }} />);
    await waitFor(() => expect(screen.getByText(/Online prices are not available right now/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(text()).not.toMatch(/₹/);
  });
});

describe("R-2027 no typed prices in the page's runtime code", () => {
  const DIR = __dirname;
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  it("FALLBACK_TIERS is gone from every non-test file of /buy/workspace", () => {
    for (const f of files(DIR)) expect(readFileSync(f, "utf8"), f).not.toMatch(/FALLBACK_TIERS/);
  });
  it("page.tsx passes null (unknown) to the clients when the read failed — it uses readBuyCatalog", () => {
    const page = readFileSync(join(DIR, "page.tsx"), "utf8");
    expect(page).toMatch(/fetchBuyCatalog\(\)/);
    expect(page).not.toMatch(/\.from\("items"\)/);
  });
});
