// @vitest-environment jsdom
/**
 * R-2024 (27 Oct 2026): when the server could not read the website company's row (cold start),
 * the page itself asks GET /api/public/brand after it loads and fills the header and the tab
 * title — the desktop page, the phone flow and the thank-you page alike. Until the answer comes
 * the header shows a neutral placeholder, never the words "Google Workspace" as if that were the
 * seller and never another company.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient } from "./buy-workspace-client";
import { BuyMobileClient } from "./_mobile/buy-mobile-client";
import { ThanksClient, type ThanksOrder } from "./thanks/thanks-client";
import type { BuyBrand } from "./_parts/brand";

const BRAND: BuyBrand = {
  name: "Tenant Seller Pvt Ltd", logoUrl: null, gstin: "07AAAAA0000A1Z5",
  address: "12 Test Road, Rohini, Delhi 110085", stateCode: "07", phone: null, email: null,
};
const ORDER: ThanksOrder = {
  quoteId: "Q-T-27-0001", invoiceNumber: null, customerName: "Ravi Traders", buyerFirstName: "Ravi", tierName: "Business Standard",
  seats: 2, amount: 3068, subtotal: 2600, paymentStatus: "received", paymentState: "paid",
  amountReceived: 3068, paymentDate: null,
};

let brandCalls: string[] = [];
let release: (() => void) | null = null;
const fetchWith = (brand: BuyBrand | null, opts: { hold?: boolean } = {}) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/public/brand")) {
      brandCalls.push(u);
      if (opts.hold) await new Promise<void>((r) => { release = r; });
      return new Response(JSON.stringify({ brand }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }));

const header = () => document.querySelector("header") as HTMLElement;

beforeEach(() => {
  brandCalls = []; release = null;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  document.title = "Buy Google Workspace";
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-2024 desktop /buy/workspace", () => {
  it("no brand from the server → the page fetches it and fills header + title", async () => {
    fetchWith(BRAND);
    render(<BuyWorkspaceClient paymentMode="simulation" brand={null} />);
    await waitFor(() => expect(header().textContent).toContain("Tenant Seller Pvt Ltd"));
    expect(document.title).toBe("Buy Google Workspace · Tenant Seller Pvt Ltd");
    expect(brandCalls).toHaveLength(1);
    expect((document.querySelector("footer") as HTMLElement).textContent).toContain("GSTIN 07AAAAA0000A1Z5");
  });

  it("while it loads the header shows a placeholder, not 'Google Workspace' as the seller", async () => {
    fetchWith(BRAND, { hold: true });
    render(<BuyWorkspaceClient paymentMode="simulation" brand={null} />);
    expect(header().querySelector("[data-brand-loading]")).toBeTruthy();
    expect(header().textContent).not.toMatch(/Google Workspace/);
    await waitFor(() => expect(release).toBeTruthy());
    release!();
    await waitFor(() => expect(header().textContent).toContain("Tenant Seller Pvt Ltd"));
    expect(header().querySelector("[data-brand-loading]")).toBeNull();
  });

  it("the fetch finds nothing → the neutral header, no invented company", async () => {
    fetchWith(null);
    render(<BuyWorkspaceClient paymentMode="simulation" brand={null} />);
    await waitFor(() => expect(header().querySelector("[data-brand-loading]")).toBeNull());
    expect(header().textContent).toContain("Google Workspace");
    expect(document.title).toBe("Buy Google Workspace");
  });

  it("brand already from the server → no extra request", async () => {
    fetchWith(null);
    render(<BuyWorkspaceClient paymentMode="simulation" brand={BRAND} />);
    expect(header().textContent).toContain("Tenant Seller Pvt Ltd");
    await new Promise((r) => setTimeout(r, 20));
    expect(brandCalls).toHaveLength(0);
    expect(header().textContent).toContain("Tenant Seller Pvt Ltd");
  });
});

describe("R-2024 phone flow", () => {
  it("no brand from the server → the top bar fills in after the fetch", async () => {
    fetchWith(BRAND, { hold: true });
    render(<BuyMobileClient paymentMode="simulation" brand={null} />);
    expect(header().querySelector("[data-brand-loading]")).toBeTruthy();
    expect(header().textContent).not.toMatch(/Google Workspace/);
    await waitFor(() => expect(release).toBeTruthy());
    release!();
    await waitFor(() => expect(header().textContent).toContain("Tenant Seller Pvt Ltd"));
    expect(document.title).toBe("Buy Google Workspace · Tenant Seller Pvt Ltd");
  });
});

describe("R-2024 thank-you page", () => {
  it("no brand from the server → header filled after the fetch, title says Order confirmed", async () => {
    fetchWith(BRAND);
    render(<ThanksClient order={ORDER} isSimulation={false} brand={null} />);
    await waitFor(() => expect(header().textContent).toContain("Tenant Seller Pvt Ltd"));
    expect(document.title).toBe("Order confirmed · Tenant Seller Pvt Ltd");
  });

  it("a malformed answer is ignored (neutral header)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ brand: { name: 42 } }), { status: 200 })));
    render(<ThanksClient order={ORDER} isSimulation={false} brand={null} />);
    await waitFor(() => expect(header().querySelector("[data-brand-loading]")).toBeNull());
    expect(header().textContent).toContain("Google Workspace");
  });
});
