// @vitest-environment jsdom
/**
 * R-1969 (buy-page audit 26 Oct 2026, Razorpay website review): every screen of /buy/workspace —
 * the laptop page, the PHONE flow (R-2020) and the thank-you page — ends with the same footer:
 * Terms and conditions, Privacy policy, Refund and cancellation, Contact us (the website's own
 * pages), and the seller's registered name, address and GSTIN number read from the tenant row.
 * The company is shown by its real logo; a tenant without a logo is shown by its name, never by a
 * made-up letter tile (the audit saw a lone "R" where the logo should be).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, within } from "@testing-library/react";
import { existsSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";
import { BuyMobileClient } from "./_mobile/buy-mobile-client";
import { ThanksClient, type ThanksOrder } from "./thanks/thanks-client";
import { SiteFooter, FOOTER_LINKS } from "./_parts/info-sections";
import type { BuyBrand } from "./_parts/brand";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG: CatalogItem[] = [
  row("s", "Google Workspace Business Starter", 270, 325),
  row("d", "Google Workspace Business Standard", 1080, 1300),
];
/* A tenant that is NOT the live company — every fact on the footer must come from this row. */
const BRAND: BuyBrand = {
  name: "Tenant Seller Pvt Ltd", logoUrl: null, gstin: "07AAAAA0000A1Z5",
  address: "12 Test Road, Rohini, Delhi 110085", stateCode: "07", phone: null, email: null,
};
const WITH_LOGO: BuyBrand = { ...BRAND, logoUrl: "https://cdn.example.test/tenant-logo.png" };
const ORDER: ThanksOrder = {
  quoteId: "Q-T-27-0001", invoiceNumber: null, customerName: "Ravi Traders", buyerFirstName: "Ravi", tierName: "Business Standard",
  seats: 2, amount: 3068, subtotal: 2600, paymentStatus: "received", paymentState: "paid",
  amountReceived: 3068, paymentDate: null,
};

const LINKS = [
  ["Privacy policy", "/privacy-policy"],
  ["Terms and conditions", "/terms-and-conditions"],
  ["Refund and cancellation", "/refund"],
  ["Contact us", "/contact"],
] as const;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.history.replaceState(null, "", "/buy/workspace");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const footer = () => {
  const all = document.querySelectorAll("footer");
  expect(all.length).toBe(1);
  return all[0] as HTMLElement;
};

/** The four links, the tenant's name, address and GSTIN number — in the footer. */
function expectFullFooter(brand: BuyBrand = BRAND) {
  const f = footer();
  const nav = within(f).getByRole("navigation", { name: "Legal" });
  for (const [label, href] of LINKS) {
    expect(within(nav).getByRole("link", { name: label }).getAttribute("href")).toBe(href);
  }
  expect(f.textContent).toContain(brand.name);
  expect(f.textContent).toContain(brand.address as string);
  expect(f.textContent).toContain(`GSTIN ${brand.gstin}`);
}

/** No square with one capital letter standing in for a logo — in the company mark (link to "/") or the footer. */
function expectNoLetterTile(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll('a[href="/"], footer'));
  expect(marks.length).toBeGreaterThan(0);
  const tiles = marks.flatMap((m) => Array.from(m.querySelectorAll("span"))).filter((s) => /^[A-Z]$/.test((s.textContent ?? "").trim()) && s.children.length === 0);
  expect(tiles.map((t) => t.outerHTML)).toEqual([]);
}

describe("R-1969: the footer on every /buy/workspace screen", () => {
  it("laptop page: 4 links + registered name, address and GSTIN from the tenant row", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} />);
    expectFullFooter();
  });

  it("phone flow (R-2020): the same footer, below the plans", () => {
    render(<BuyMobileClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialSearch={{}} />);
    expectFullFooter();
    /* the sticky Continue bar is untouched and still the page's only fixed bar */
    expect(document.querySelectorAll("[data-m-bar]").length).toBe(1);
  });

  it("phone flow without prices (cold start / none online): the footer is still there", () => {
    render(<BuyMobileClient catalogItems={[]} paymentMode="simulation" brand={BRAND} initialSearch={{}} />);
    expectFullFooter();
  });

  it("thank-you page: the same footer", () => {
    render(<ThanksClient order={ORDER} isSimulation={false} brand={BRAND} />);
    expectFullFooter();
  });

  it("another tenant's row → that tenant's name, address and GSTIN (nothing typed in the code)", () => {
    const other: BuyBrand = { ...BRAND, name: "Other Cloud LLP", address: "5 Lake View, Pune 411001", gstin: "27BBBBB1111B1Z1", stateCode: "27" };
    render(<SiteFooter brand={other} />);
    expectFullFooter(other);
    expect(footer().textContent).not.toContain("Tenant Seller");
  });

  it("the tenant's logo is shown in the footer (alt = company name)", () => {
    render(<SiteFooter brand={WITH_LOGO} />);
    const img = within(footer()).getByRole("img", { name: "Tenant Seller Pvt Ltd" });
    expect(img.getAttribute("src")).toBe(WITH_LOGO.logoUrl);
  });

  it("no logo → the company name, never a letter tile (laptop header + footer, phone header, thanks header)", () => {
    const { unmount } = render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} />);
    expectNoLetterTile(document.body);
    expect(within(document.querySelector("header") as HTMLElement).getByText("Tenant Seller Pvt Ltd")).toBeTruthy();
    unmount();
    const m = render(<BuyMobileClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialSearch={{}} />);
    expectNoLetterTile(document.body);
    m.unmount();
    render(<ThanksClient order={ORDER} isSimulation={false} brand={BRAND} />);
    expectNoLetterTile(document.body);
  });

  it("each footer link is a real page of the website (no 404)", () => {
    expect(FOOTER_LINKS.map((l) => [l.label, l.href])).toEqual(LINKS.map(([l, h]) => [l, h]));
    const app = join(process.cwd(), "src", "app");
    for (const [, href] of LINKS) {
      expect(existsSync(join(app, "(marketing)", href.slice(1), "page.tsx")), href).toBe(true);
    }
  });
});
