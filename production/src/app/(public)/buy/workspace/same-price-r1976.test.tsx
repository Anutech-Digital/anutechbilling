// @vitest-environment jsdom
/**
 * R-1976 (Pardeep, 26 Oct 2026): the old "Same price · more service" section is back, right under
 * "Compare all features": the website tenant vs Google direct, the SAME per-user price on both,
 * read from the selected plan and Annual / Monthly — never a typed ₹1,080. Plus (price hidden,
 * R-328) or Enterprise selected → Standard's price. The name is the tenant's, never typed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";
import type { BuyBrand } from "./_parts/brand";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG: CatalogItem[] = [
  row("s", "Google Workspace Business Starter", 270, 325),
  row("d", "Google Workspace Business Standard", 1080, 1300),
  { id: "p", name: "Google Workspace Business Plus", msrp: 0, wholesale: 0, margin_pct: null, is_active: true, prices: {} },
];
const BRAND: BuyBrand = {
  name: "Tenant Seller Pvt Ltd", logoUrl: null, gstin: "07AAAAA0000A1Z5",
  address: "Rohini, Delhi 110085", stateCode: "07", phone: null, email: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = (over: Partial<React.ComponentProps<typeof BuyWorkspaceClient>> = {}) =>
  render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} {...over} />);
const section = () => screen.getByRole("region", { name: /Same price, more service/ });
const prices = () => within(section()).getAllByTestId("same-price").map((e) => e.textContent);

describe("R-1976 Same price · more service", () => {
  it("sits right under Compare all features", () => {
    page();
    const compare = document.getElementById("compare") as HTMLElement;
    expect(compare.nextElementSibling).toBe(section());
  });

  it("tenant vs Google direct, both at Standard annual ₹1,080 by default", () => {
    page();
    const s = section();
    expect(within(s).getByRole("heading", { level: 3, name: "Tenant Seller Pvt Ltd" })).toBeTruthy();
    expect(within(s).getByRole("heading", { level: 3, name: "Google direct" })).toBeTruthy();
    expect(prices()).toEqual(["₹1,080", "₹1,080"]);
    expect(s.textContent).toMatch(/Both cost ₹1,080/);
    expect(s.textContent).toMatch(/Dedicated account manager/);
  });

  it("Starter selected → ₹270 on both", () => {
    page({ initialTierId: "starter" });
    expect(prices()).toEqual(["₹270", "₹270"]);
  });

  it("Monthly → the monthly price on both", () => {
    page();
    fireEvent.click(screen.getAllByRole("button", { name: "Monthly" })[0]);
    expect(prices()).toEqual(["₹1,300", "₹1,300"]);
  });

  it("Plus (price hidden, R-328) selected → Standard's price, never Plus's", () => {
    page({ initialTierId: "plus" });
    expect(prices()).toEqual(["₹1,080", "₹1,080"]);
    expect(section().textContent).not.toMatch(/1,500|1,800/);
  });

  it("no tenant row → no invented company name", () => {
    page({ brand: null });
    expect(within(section()).getByRole("heading", { level: 3, name: "Us" })).toBeTruthy();
    expect(section().textContent).not.toMatch(/ANUTECH/i);
  });

  it("phone width: the two columns stack (one column below md)", () => {
    page();
    const grid = within(section()).getByTestId("same-price-grid");
    expect(grid.className).toMatch(/grid-cols-1/);
    expect(grid.className).toMatch(/md:grid-cols-2/);
  });
});
