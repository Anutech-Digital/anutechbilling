// @vitest-environment jsdom
/**
 * R-1986 (Pardeep, 26 Oct 2026, localhost "Choose a plan"): the priced plan cards say
 * "Buy Business Starter" / "Buy Business Standard" (not "Continue with Starter" / "Choose Standard"). The button
 * picks that plan and opens the PAY checkout — never the trial (R-1975). Plus and Enterprise
 * keep their quote buttons.
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const page = () => render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} />);
const plans = () => document.getElementById("plans") as HTMLElement;
const card = (name: string) => within(plans()).getByRole("article", { name });
const checkout = () => document.getElementById("checkout") as HTMLElement;
const summary = () => screen.getByRole("complementary", { name: "Order summary" });

describe("R-1986 plan cards: Buy <Google plan name>", () => {
  it("Starter says 'Buy Starter', Standard says 'Buy Standard' — no 'Continue with' / 'Choose'", () => {
    page();
    expect(within(card("Business Starter")).getByRole("button", { name: "Buy Business Starter" })).toBeTruthy();
    expect(within(card("Business Standard")).getByRole("button", { name: "Buy Business Standard" })).toBeTruthy();
    expect(within(plans()).queryByRole("button", { name: /^(Continue with|Choose) / })).toBeNull();
  });

  it("Monthly too: 'Buy Starter' / 'Buy Standard'", () => {
    page();
    fireEvent.click(within(plans()).getByRole("button", { name: "Monthly" }));
    expect(within(card("Business Starter")).getByRole("button", { name: "Buy Business Starter" })).toBeTruthy();
    expect(within(card("Business Standard")).getByRole("button", { name: "Buy Business Standard" })).toBeTruthy();
  });

  it("'Buy Starter' picks Starter and opens the PAY checkout, even after a trial was started", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: /Start 14-day free trial/ }));
    vi.advanceTimersByTime(100);
    fireEvent.click(within(card("Business Starter")).getByRole("button", { name: "Buy Business Starter" }));
    vi.advanceTimersByTime(100);
    expect(within(checkout()).getByRole("heading", { level: 2 }).textContent).toBe("Checkout");
    expect(within(summary()).getByText("Google Workspace Business Starter")).toBeTruthy();
  });

  it("both priced buttons are the primary (amber) style", () => {
    page();
    for (const [c, b] of [["Business Starter", "Buy Business Starter"], ["Business Standard", "Buy Business Standard"]]) {
      expect(within(card(c)).getByRole("button", { name: b }).className).toMatch(/\bbg-amber\b/);
    }
  });

  it("Plus and Enterprise both say 'Get a quote'", () => {
    page();
    expect(within(card("Business Plus")).getByRole("button", { name: "Get a quote" })).toBeTruthy();
    expect(within(card("Enterprise")).getByRole("button", { name: "Get a quote" })).toBeTruthy();
  });
});

/* R-1986 (Pardeep): Plus (price hidden, R-328) and Enterprise say "Talk to sales", with a Call
   link (the tenant phone) and a WhatsApp link naming the plan and the users; the quote button stays. */
describe("R-1986 Plus / Enterprise: Talk to sales", () => {
  const withPhone = () => render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={{ ...BRAND, phone: "98111 22233" }} initialSeats={12} />);

  it("Plus and Enterprise: heading 'Talk to sales', no price figure", () => {
    withPhone();
    for (const id of ["plus", "enterprise"]) {
      expect(screen.getByTestId(`plan-price-${id}`).textContent).toBe("Talk to sales");
    }
    expect(card("Business Plus").textContent).not.toMatch(/1,500|1,800|Contact us for pricing/);
    expect(card("Enterprise").textContent).not.toMatch(/\bCustom\b/);
  });

  it("Call = the tenant phone as tel:, WhatsApp = wa.me with the plan and the users", () => {
    withPhone();
    for (const [name, plan] of [["Business Plus", "Business Plus"], ["Enterprise", "Enterprise"]]) {
      const c = card(name);
      const call = within(c).getByRole("link", { name: /^Call / });
      expect(call.getAttribute("href")).toBe("tel:+919811122233");
      const wa = within(c).getByRole("link", { name: "WhatsApp us" }).getAttribute("href") ?? "";
      expect(wa.startsWith("https://wa.me/")).toBe(true);
      expect(decodeURIComponent(wa)).toContain(`Google Workspace ${plan} quote for 12 users`);
    }
  });

  it("the quote buttons and the 'Written GST quote' line stay", () => {
    withPhone();
    expect(within(card("Business Plus")).getByRole("button", { name: "Get a quote" })).toBeTruthy();
    expect(within(card("Enterprise")).getByRole("button", { name: "Get a quote" })).toBeTruthy();
    expect(card("Business Plus").textContent).toMatch(/Written GST quote within 1 working day/);
  });

  it("priced plans show no sales links", () => {
    withPhone();
    expect(screen.queryByTestId("plan-sales-starter")).toBeNull();
    expect(screen.queryByTestId("plan-sales-standard")).toBeNull();
  });
});

/* R-1986 (Pardeep): the buttons and feature lists line up across the 4 cards — each card is 8 rows
   of one grid (subgrid) from sm up, so text length above the button cannot push it down. */
describe("R-1986 plan cards line up", () => {
  it("every card is a subgrid spanning 8 rows: wordmark, name, blurb, price, contact, total, button, features", () => {
    page();
    const grid = screen.getByTestId("plan-grid");
    expect(grid.className).toMatch(/sm:gap-y-0/);
    const cards = within(grid).getAllByRole("article");
    expect(cards).toHaveLength(4);
    for (const c of cards) {
      expect(c.className).toMatch(/sm:grid-rows-subgrid/);
      expect(c.className).toMatch(/sm:row-span-8/);
      const inFlow = [...c.children].filter((el) => !el.className.includes("absolute"));
      expect(inFlow).toHaveLength(8);
      expect(inFlow[6].tagName).toBe("BUTTON");
      expect(inFlow[7].tagName).toBe("UL");
    }
  });
});

/* R-1986 (Pardeep): the grey total box shows the working, from the hero card's helper. */
describe("R-1986 plan card total box shows the working", () => {
  const box = (name: string) => card(name).querySelector(".font-mono")?.textContent;
  it("annual, 10 users: '₹270/user/month × 10 users × 12 = ₹32,400/year + GST'", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialSeats={10} />);
    expect(box("Business Starter")).toBe("₹270/user/month × 10 users × 12 = ₹32,400/year + GST");
    expect(box("Business Standard")).toBe("₹1,080/user/month × 10 users × 12 = ₹1,29,600/year + GST");
  });
  it("monthly, 10 users: '₹325/user/month × 10 users = ₹3,250/month + GST'", () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialSeats={10} />);
    fireEvent.click(within(plans()).getByRole("button", { name: "Monthly" }));
    expect(box("Business Starter")).toBe("₹325/user/month × 10 users = ₹3,250/month + GST");
  });
  it("the same words as the hero price card's helper", async () => {
    const { priceHeadline } = await import("./price-headline");
    expect(priceHeadline({ rate: 270, seats: 10, billing: "annual", subtotal: 32400, gst: 5832, total: 38232 }).working)
      .toBe("₹270/user/month × 10 users × 12 = ₹32,400/year + GST");
  });
});
