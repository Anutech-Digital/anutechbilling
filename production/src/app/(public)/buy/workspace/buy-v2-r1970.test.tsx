// @vitest-environment jsdom
/**
 * R-1970 (26 Oct 2026, Pardeep's design v2 + DECISIONS.md). The owner's path on /buy/workspace:
 * the header and footer name the website tenant (name, GSTIN, address — from its row), the plan
 * cards show Annual 270 / 1,080 and Monthly 325 / 1,300, Business Plus stays "Contact us for
 * pricing" (R-328, Pardeep 26 Oct), 301 users sends the buyer to Enterprise, the footer links
 * go to the four legal pages, and there is no website cart on this page (R-1966 superseded).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";
import type { BuyBrand } from "./_parts/brand";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
/* What page.tsx sends: Plus with no figures (publicBuyRow, R-328). */
const CATALOG: CatalogItem[] = [
  row("s", "Google Workspace Business Starter", 270, 325),
  row("d", "Google Workspace Business Standard", 1080, 1300),
  { id: "p", name: "Google Workspace Business Plus", msrp: 0, wholesale: 0, margin_pct: null, is_active: true, prices: {} },
];
const BRAND: BuyBrand = {
  name: "Tenant Seller Pvt Ltd", logoUrl: null, gstin: "07AAAAA0000A1Z5",
  address: "12 Test Road, Rohini, Delhi 110085", stateCode: "07", phone: null, email: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = (over: Partial<React.ComponentProps<typeof BuyWorkspaceClient>> = {}) =>
  render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} {...over} />);

const priceOf = (id: string) => screen.getByTestId(`plan-price-${id}`).textContent;

describe("R-1970 /buy/workspace v2", () => {
  it("header and footer carry the tenant's name, GSTIN and address — and no cart", () => {
    page();
    const header = document.querySelector("header") as HTMLElement;
    expect(within(header).getByText("Tenant Seller Pvt Ltd")).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Buy now" })).toBeTruthy();
    expect(within(header).queryByRole("link", { name: /Cart/ })).toBeNull();
    const footer = document.querySelector("footer") as HTMLElement;
    expect(footer.textContent).toContain("Tenant Seller Pvt Ltd");
    expect(footer.textContent).toContain("GSTIN 07AAAAA0000A1Z5");
    expect(footer.textContent).toContain("12 Test Road, Rohini, Delhi 110085");
    expect(screen.queryByRole("button", { name: /Add to cart/ })).toBeNull();
    expect(screen.queryByTestId("header-cart-count")).toBeNull();
  });

  it("footer links: Privacy, Terms, Refund, Contact", () => {
    page();
    const nav = screen.getByRole("navigation", { name: "Legal" });
    const hrefs = within(nav).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/privacy-policy", "/terms-and-conditions", "/refund", "/contact"]);
  });

  it("plan cards: Annual 270 / 1,080, Monthly 325 / 1,300; Plus is a quote (R-328); Enterprise custom", () => {
    page();
    expect(priceOf("starter")).toContain("₹270");
    expect(priceOf("standard")).toContain("₹1,080");
    expect(priceOf("plus")).toBe("Contact us for pricing");
    expect(priceOf("enterprise")).toBe("Custom");
    const plans = document.getElementById("plans") as HTMLElement;
    fireEvent.click(within(plans).getByRole("button", { name: "Monthly" }));
    expect(priceOf("starter")).toContain("₹325");
    expect(priceOf("standard")).toContain("₹1,300");
    expect(priceOf("plus")).toBe("Contact us for pricing");
    expect(within(plans).getByRole("button", { name: "Monthly" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("price card: Starter 1 user annual = ₹3,240 /year + GST, total ₹3,823 (unchanged money)", () => {
    page({ initialTierId: "starter", initialSeats: 1 });
    expect(screen.getByTestId("hero-total").textContent).toBe("₹3,240");
    expect(screen.getByText("+ ₹583 GST (18%) · Total ₹3,823")).toBeTruthy();
    expect(screen.getByTestId("summary-total").textContent).toBe("₹3,823"); // R-1971: the order summary
  });

  it("monthly: Standard 2 users = ₹2,600 /month + GST, ₹3,068 total", () => {
    page({ initialTierId: "standard", initialSeats: 2 });
    fireEvent.click(screen.getAllByRole("button", { name: "Monthly" })[0]);
    expect(screen.getByTestId("hero-total").textContent).toBe("₹2,600");
    expect(screen.getByText("+ ₹468 GST (18%) · Total ₹3,068")).toBeTruthy();
    expect(screen.getByTestId("summary-total").textContent).toBe("₹3,068");
  });

  it("301 users: no Buy — the price card and checkout send the buyer to Enterprise", () => {
    page({ initialTierId: "starter", initialSeats: 301 });
    expect(screen.getAllByText(/Business plans support up to 300 users. For more, choose Enterprise./).length).toBe(1);
    expect(screen.getByRole("button", { name: "Talk to us about Enterprise" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue to checkout" })).toBeNull();
    /* R-1971: checkout shows the Enterprise call / WhatsApp panel instead of the three steps. */
    expect(screen.getByText("Enterprise is quoted, not checked out")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Your domain" })).toBeNull();
    expect(screen.getAllByText("Max 300 users — see Enterprise").length).toBe(2);
  });

  it("a11y: plan, users and billing toggles say which is on; FAQ and compare say open/closed", () => {
    page({ initialTierId: "standard" });
    const plan = screen.getByRole("group", { name: "Plan" });
    expect(within(plan).getByRole("button", { name: "Standard" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(plan).getByRole("button", { name: "Starter" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByLabelText("Users")).toBeTruthy();
    const compare = screen.getByRole("button", { name: /Compare all features/ });
    expect(compare.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(compare);
    expect(compare.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("table")).toBeTruthy();
    const faq = screen.getByRole("button", { name: /Can I add or remove users later/ });
    expect(faq.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(faq);
    expect(faq.getAttribute("aria-expanded")).toBe("true");
  });

  it("no tenant row → a neutral header, no other company's name or GSTIN", () => {
    page({ brand: null });
    const header = document.querySelector("header") as HTMLElement;
    expect(header.textContent).not.toMatch(/Pvt Ltd/);
    expect((document.querySelector("footer") as HTMLElement).textContent).not.toMatch(/GSTIN/);
  });
});
