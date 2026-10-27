// @vitest-environment jsdom
/**
 * R-2030 (Pardeep, 27 Oct 2026, staging screenshot "1 and 2 should merge and only stay in 1's
 * place"): a priced plan card shows its per-user rate ONCE — inside the working box:
 *   "₹325 /user/month"  (big, serif)
 *   "× [10] users ="  /  "₹3,250/month + GST"   (annual: "× [10] users × 12 =" / "₹32,400/year + GST")
 *   "Billed monthly" / "Billed yearly · 12-month plan"  (small)
 * No big price or "Billed …" line under the title any more — the video/highlights sit right under
 * the description. (Plus / Enterprise: R-2032 below.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "../buy-workspace-client";
import type { BuyBrand } from "./brand";

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

const mount = (seats = 10, tier?: string) =>
  render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialSeats={seats} initialTierId={tier} />);
const plans = () => document.getElementById("plans") as HTMLElement;
const card = (name: string) => within(plans()).getByRole("article", { name });
const box = (id: string) => screen.getByTestId(`plan-total-${id}`);
/* line 2 reads "× [input] users × 12 =" — the input carries no text, so textContent is "×users × 12 =". */
const lines = (id: string) => [...box(id).querySelectorAll("[data-line]")].map((l) => (l.textContent ?? "").replace(/\s+/g, " ").trim());
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const monthly = () => fireEvent.click(within(plans()).getByRole("button", { name: "Monthly" }));

describe("R-2030 one rate block per priced card, in the working box", () => {
  it("monthly: the rate appears once per card, inside the box, with the working and 'Billed monthly'", () => {
    mount();
    monthly();
    for (const [name, id, r] of [["Business Starter", "starter", "₹325"], ["Business Standard", "standard", "₹1,300"]] as const) {
      expect(count(card(name).textContent ?? "", `${r}`)).toBe(1);
      expect(box(id).contains(screen.getByTestId(`plan-price-${id}`))).toBe(true);
      expect(card(name).textContent).not.toMatch(/Billed yearly/);
      expect(count(card(name).textContent ?? "", "Billed monthly")).toBe(1);
      expect(within(box(id)).getByText("Billed monthly")).toBeTruthy();
    }
    expect(lines("starter")).toEqual(["₹325 /user/month", "×users =", "₹3,250/month + GST"]);
  });

  it("annual: '₹270 /user/month' / '× [10] users × 12 =' / '₹32,400/year + GST' / 'Billed yearly · 12-month plan'", () => {
    mount();
    expect(lines("starter")).toEqual(["₹270 /user/month", "×users × 12 =", "₹32,400/year + GST"]);
    expect(lines("standard")).toEqual(["₹1,080 /user/month", "×users × 12 =", "₹1,29,600/year + GST"]);
    expect(count(card("Business Starter").textContent ?? "", "₹270")).toBe(1);
    expect(within(box("starter")).getByText("Billed yearly · 12-month plan")).toBeTruthy();
    expect(count(card("Business Starter").textContent ?? "", "Billed yearly")).toBe(1);
    // the big serif rate line
    expect(box("starter").querySelector("[data-line=\"1\"]")?.className).toMatch(/font-serif/);
  });

  it("the users input sits in line 2 of each box and each card keeps its own count", () => {
    mount(10, "standard");
    const starterIn = box("starter").querySelector("[data-line=\"2\"] input") as HTMLInputElement;
    expect(starterIn).toBeTruthy();
    fireEvent.change(starterIn, { target: { value: "3" } });
    expect(lines("starter")[2]).toBe("₹9,720/year + GST");
    expect(lines("standard")[2]).toBe("₹1,29,600/year + GST");
    expect((box("standard").querySelector("[data-line=\"2\"] input") as HTMLInputElement).value).toBe("10");
  });

  it("nothing priced between the description and the video/highlights", () => {
    mount();
    const c = card("Business Starter");
    const blurb = [...c.children].find((el) => el.tagName === "P") as HTMLElement;
    const next = blurb.nextElementSibling as HTMLElement;
    expect(next.querySelector("[data-testid=plan-media], [data-testid=plan-video]") ?? next.matches("[data-testid=plan-media]")).toBeTruthy();
    expect(next.textContent).not.toMatch(/₹|Billed/);
  });

});

/* R-2032 (Pardeep, 27 Oct: "these look oddly empty"): Plus and Enterprise follow the same pattern
   as a priced card — the Workspace apps image under the description, then ONE box: big serif
   "Price on request" (Plus — the price stays hidden, R-328) / "Custom price" (Enterprise), the
   written-quote line, then small Call · WhatsApp links. No separate "Talk to sales" heading. */
describe("R-2032 Plus / Enterprise cards: same pattern as the price box", () => {
  const BRAND_PHONE = { ...BRAND, phone: "98111 22233" };
  const withPhone = () => render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND_PHONE} initialSeats={12} />);

  it("big serif 'Price on request' (Plus) / 'Custom price' (Enterprise) inside the box", () => {
    withPhone();
    for (const [id, label] of [["plus", "Price on request"], ["enterprise", "Custom price"]] as const) {
      const head = screen.getByTestId(`plan-price-${id}`);
      expect(head.textContent).toBe(label);
      expect(head.className).toMatch(/font-serif/);
      expect(box(id).contains(head)).toBe(true);
    }
  });

  it("the box: the quote line, then the Call and WhatsApp links (moved in from above)", () => {
    withPhone();
    for (const [name, id] of [["Business Plus", "plus"], ["Enterprise", "enterprise"]] as const) {
      expect(box(id).textContent).toContain("Written GST quote within 1 working day");
      const sales = screen.getByTestId(`plan-sales-${id}`);
      expect(box(id).contains(sales)).toBe(true);
      expect(within(sales).getByRole("link", { name: /^Call / }).getAttribute("href")).toMatch(/^tel:\+91.*22233$/); // the tenant phone (no full number here — buy-contact.test scans _parts)
      expect(within(sales).getByRole("link", { name: "WhatsApp us" })).toBeTruthy();
      expect(card(name).textContent).not.toMatch(/Talk to sales/);
    }
  });

  it("the Workspace apps image under the description, like Starter / Standard (no empty slot)", () => {
    withPhone();
    for (const name of ["Business Plus", "Enterprise"]) {
      const c = card(name);
      const blurb = [...c.children].find((el) => el.tagName === "P") as HTMLElement;
      const slot = blurb.nextElementSibling as HTMLElement;
      expect(slot.getAttribute("data-testid")).toBe("plan-media");
      expect(within(slot).getByRole("img").getAttribute("src")).toBe("/buy/workspace-apps.webp");
    }
  });

  it("no price figure on Plus / Enterprise; 'Get a quote' stays", () => {
    withPhone();
    expect(card("Business Plus").textContent).not.toMatch(/₹|1,500|1,800/);
    expect(card("Enterprise").textContent).not.toMatch(/₹/);
    expect(within(card("Business Plus")).getByRole("button", { name: "Get a quote" })).toBeTruthy();
    expect(within(card("Enterprise")).getByRole("button", { name: "Get a quote" })).toBeTruthy();
  });
});
