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

  it("Plus and Enterprise: no price figure (R-2032: 'Price on request' / 'Custom price' in the box, no 'Talk to sales' heading)", () => {
    withPhone();
    expect(screen.getByTestId("plan-price-plus").textContent).toBe("Price on request");
    expect(screen.getByTestId("plan-price-enterprise").textContent).toBe("Custom price");
    expect(card("Business Plus").textContent).not.toMatch(/1,500|1,800|Contact us for pricing/);
    expect(card("Enterprise").textContent).not.toMatch(/₹/); // R-2032: "Custom price" is the label now — still no figure
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

/* R-1986 (Pardeep): the buttons and feature lists line up across the 4 cards — each card is 7 rows (R-2030; was 8)
   of one grid (subgrid) from sm up, so text length above the button cannot push it down. */
describe("R-1986 plan cards line up", () => {
  it("every card is a subgrid spanning 7 rows: wordmark, name, blurb, media/contact, rate+total box, button, features (R-2030)", () => {
    page();
    const grid = screen.getByTestId("plan-grid");
    expect(grid.className).toMatch(/sm:gap-y-0/);
    const cards = within(grid).getAllByRole("article");
    expect(cards).toHaveLength(4);
    for (const c of cards) {
      expect(c.className).toMatch(/sm:grid-rows-subgrid/);
      expect(c.className).toMatch(/sm:row-span-7/);
      const inFlow = [...c.children].filter((el) => !el.className.includes("absolute"));
      expect(inFlow).toHaveLength(7);
      expect(inFlow[5].tagName).toBe("BUTTON");
      expect(inFlow[6].tagName).toBe("UL");
    }
  });
});

/* R-1986 (Pardeep): the grey total box shows the working, from the hero card's helper, and the
   users number in it is an input — each card keeps its OWN count. */
const working = (id: string) => screen.getByTestId(`plan-total-${id}`).getAttribute("data-working");
const usersIn = (name: string) => within(card(name)).getByLabelText(`Number of users for ${name}`) as HTMLInputElement;
const mount = (seats = 10, tier?: string) =>
  render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialSeats={seats} initialTierId={tier} />);

describe("R-1986 plan card total box shows the working", () => {
  it("annual, 10 users: '₹270/user/month × 10 users × 12 = ₹32,400/year + GST'", () => {
    mount();
    expect(working("starter")).toBe("₹270/user/month × 10 users × 12 = ₹32,400/year + GST");
    expect(working("standard")).toBe("₹1,080/user/month × 10 users × 12 = ₹1,29,600/year + GST");
    // R-1986 + R-2030: three fixed lines — "₹270 /user/month" / "× [10] users × 12 =" / "₹32,400/year + GST"
    const lines = [...screen.getByTestId("plan-total-starter").querySelectorAll("[data-line]")].map((l) => l.textContent);
    expect(lines).toEqual(["₹270 /user/month", "×users × 12 =", "₹32,400/year + GST"]); // R-2030: the rate line is the big one
    expect(screen.getByTestId("plan-total-starter").querySelector("[data-line=\"2\"] input")).toBeTruthy();
    expect(usersIn("Business Starter").value).toBe("10");
  });
  it("monthly, 10 users: '₹325/user/month × 10 users = ₹3,250/month + GST'", () => {
    mount();
    fireEvent.click(within(plans()).getByRole("button", { name: "Monthly" }));
    expect(working("starter")).toBe("₹325/user/month × 10 users = ₹3,250/month + GST");
  });
  it("the same words as the hero price card's helper", async () => {
    const { priceHeadline } = await import("./price-headline");
    const h = priceHeadline({ rate: 270, seats: 10, billing: "annual", subtotal: 32400, gst: 5832, total: 38232 });
    expect(h.working).toBe("₹270/user/month × 10 users × 12 = ₹32,400/year + GST");
    expect(`${h.workingParts.before} 10 ${h.workingParts.mid} ${h.workingParts.after}`).toBe(h.working);
  });
});

describe("R-1986 users inside each card — each card keeps its own count", () => {
  it("no separate users row at the top of the plan section; Annual/Monthly stays", () => {
    mount();
    expect(screen.queryByTestId("plan-seats")).toBeNull();
    expect(within(plans()).getByRole("button", { name: "Monthly" })).toBeTruthy();
  });

  it("editing Starter's box changes only Starter's total — Standard keeps its own", () => {
    mount(10, "standard");
    fireEvent.change(usersIn("Business Starter"), { target: { value: "3" } });
    expect(working("starter")).toBe("₹270/user/month × 3 users × 12 = ₹9,720/year + GST");
    expect(working("standard")).toBe("₹1,080/user/month × 10 users × 12 = ₹1,29,600/year + GST");
    expect((document.getElementById("hero-seats") as HTMLInputElement).value).toBe("10");
  });

  it("'Buy Business Starter' carries Starter's own count into the checkout; Standard keeps its count", () => {
    mount(10, "standard");
    fireEvent.change(usersIn("Business Starter"), { target: { value: "3" } });
    fireEvent.click(within(card("Business Starter")).getByRole("button", { name: "Buy Business Starter" }));
    expect(within(summary()).getByText("Google Workspace Business Starter")).toBeTruthy();
    expect(within(summary()).getByText("3 users × ₹270/user/month × 12 months")).toBeTruthy();
    expect((document.getElementById("hero-seats") as HTMLInputElement).value).toBe("3");
    expect(working("standard")).toBe("₹1,080/user/month × 10 users × 12 = ₹1,29,600/year + GST");
  });

  it("the selected plan's box is the page's count: hero and box move together", () => {
    mount(10, "starter");
    fireEvent.change(usersIn("Business Starter"), { target: { value: "4" } });
    expect((document.getElementById("hero-seats") as HTMLInputElement).value).toBe("4");
    fireEvent.change(document.getElementById("hero-seats") as HTMLInputElement, { target: { value: "6" } });
    expect(usersIn("Business Starter").value).toBe("6");
  });

  it("301 in a box → that card says 'Max 300 users — see Enterprise', the input stays", () => {
    mount(10, "standard");
    fireEvent.change(usersIn("Business Starter"), { target: { value: "301" } });
    expect(within(screen.getByTestId("plan-total-starter")).getByText("Max 300 users — see Enterprise")).toBeTruthy();
    expect(usersIn("Business Starter").value).toBe("301");
    expect(working("standard")).toMatch(/× 10 users/);
  });
});

describe("R-1986 fixed three-line working box", () => {
  const lines = (id: string) => [...screen.getByTestId(`plan-total-${id}`).querySelectorAll("[data-line]")].map((l) => l.textContent);
  it("Starter and Standard have the same three lines whatever the digits; each line never wraps", () => {
    mount(10, "standard");
    fireEvent.change(usersIn("Business Starter"), { target: { value: "3" } });
    expect(lines("starter")).toEqual(["₹270 /user/month", "×users × 12 =", "₹9,720/year + GST"]);
    expect(lines("standard")).toEqual(["₹1,080 /user/month", "×users × 12 =", "₹1,29,600/year + GST"]);
    // R-2030: the working lines (2, 3) never wrap; line 1 is the big rate, whose "/user/month" may drop under it on a narrow card
    for (const l of screen.getByTestId("plan-total-starter").querySelectorAll("[data-line=\"2\"], [data-line=\"3\"]")) expect(l.className).toMatch(/block whitespace-nowrap/);
  });
  it("monthly: line 2 'users =', line 3 '/month + GST'", () => {
    mount(10, "standard");
    fireEvent.click(within(plans()).getByRole("button", { name: "Monthly" }));
    expect(lines("starter")).toEqual(["₹325 /user/month", "×users =", "₹3,250/month + GST"]);
  });
});
