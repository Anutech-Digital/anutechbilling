// @vitest-environment jsdom
/**
 * R-1975 (26 Oct 2026, v2 audit — Pardeep hit (1) himself):
 *   1. After "Start free trial", every buy button (header Buy now, hero Continue to checkout,
 *      plan Choose, phone bar Checkout) opens the PAY checkout again — never the trial.
 *      In trial mode a "Pay now instead" link is there from step 1.
 *   2. The thanks page shows the website tenant's brand (name, legal line, the buy page's footer),
 *      not a hard-coded letter and company name.
 *   3. "call or WhatsApp you within 4 working hours" — with the space.
 *   4. Going to the checkout jumps there at once and puts focus on its heading (no slow scroll).
 *   5. The phone bar's total says "incl. GST".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace/thanks",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "./buy-workspace-client";
import { ThanksClient, type ThanksOrder } from "./thanks/thanks-client";
import type { BuyBrand } from "./_parts/brand";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG: CatalogItem[] = [
  row("s", "Google Workspace Business Starter", 270, 325),
  row("d", "Google Workspace Business Standard", 1080, 1300),
];
const BRAND: BuyBrand = {
  name: "Tenant Seller Pvt Ltd", logoUrl: null, gstin: "07AAAAA0000A1Z5",
  address: "Rohini, Delhi 110085", stateCode: "07", phone: null, email: null,
};

let scrolls: Array<{ behavior?: string }> = [];
beforeEach(() => {
  scrolls = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  window.scrollTo = vi.fn((o: ScrollToOptions) => { scrolls.push({ behavior: o?.behavior }); }) as unknown as typeof window.scrollTo;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const page = () => render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} />);
const checkout = () => document.getElementById("checkout") as HTMLElement;
const heading = () => within(checkout()).getByRole("heading", { level: 2 });
const startTrial = () => {
  fireEvent.click(screen.getByRole("button", { name: /Start 14-day free trial/ }));
  vi.advanceTimersByTime(100);
  expect(heading().textContent).toBe("Start your free trial");
};

describe("R-1975 buy buttons always open the pay checkout", () => {
  it("header Buy now after a trial start → Checkout (pay)", () => {
    page();
    startTrial();
    fireEvent.click(within(document.querySelector("header") as HTMLElement).getByRole("button", { name: "Buy now" }));
    vi.advanceTimersByTime(100);
    expect(heading().textContent).toBe("Checkout");
  });

  it("hero Continue to checkout after a trial start → Checkout (pay)", () => {
    page();
    startTrial();
    fireEvent.click(screen.getByRole("button", { name: "Continue to checkout" }));
    vi.advanceTimersByTime(100);
    expect(heading().textContent).toBe("Checkout");
  });

  it("a plan's Choose / Continue button after a trial start → Checkout (pay)", () => {
    page();
    startTrial();
    const plans = document.getElementById("plans") as HTMLElement;
    fireEvent.click(within(plans).getAllByRole("button", { name: /^(Choose|Continue with) / })[0]);
    vi.advanceTimersByTime(100);
    expect(heading().textContent).toBe("Checkout");
  });

  it("phone bar Checkout after a trial start → Checkout (pay)", () => {
    page();
    startTrial();
    fireEvent.click(within(screen.getByTestId("phone-bar")).getByRole("button", { name: "Checkout" }));
    vi.advanceTimersByTime(100);
    expect(heading().textContent).toBe("Checkout");
  });

  it("trial mode shows 'Pay now instead' already at step 1, and it switches back to paying", () => {
    page();
    startTrial();
    const link = within(checkout()).getByRole("button", { name: "Pay now instead" });
    expect(within(checkout()).getByRole("region", { name: "Your domain" })).toBeTruthy();
    fireEvent.click(link);
    expect(heading().textContent).toBe("Checkout");
    expect(within(checkout()).queryByRole("button", { name: "Pay now instead" })).toBeNull();
  });

  it("going to the checkout jumps at once (no smooth scroll) and focuses its heading", () => {
    page();
    fireEvent.click(within(document.querySelector("header") as HTMLElement).getByRole("button", { name: "Buy now" }));
    vi.advanceTimersByTime(100);
    expect(scrolls.at(-1)?.behavior).toBe("auto");
    expect(document.activeElement).toBe(heading());
  });

  it("phone bar total says incl. GST", () => {
    page();
    const bar = screen.getByTestId("phone-bar");
    expect(bar.textContent).toMatch(/incl\. GST/);
  });
});

const ORDER: ThanksOrder = {
  quoteId: "Q-T-27-0001", invoiceNumber: null, customerName: "Ravi Traders", tierName: "Business Standard",
  seats: 2, amount: 3068, subtotal: 2600, paymentStatus: "received", paymentState: "paid",
  amountReceived: 3068, paymentDate: null,
};

describe("R-1975 thanks page: tenant brand, buy page footer, 'you within'", () => {
  it("header and footer carry the tenant's name and GSTIN — no hard-coded company", () => {
    render(<ThanksClient order={ORDER} isSimulation={false} brand={BRAND} />);
    const header = document.querySelector("header") as HTMLElement;
    expect(header.textContent).toContain("Tenant Seller Pvt Ltd");
    expect(header.textContent).not.toMatch(/ANUTECH/i);
    const footer = document.querySelector("footer") as HTMLElement;
    expect(footer.textContent).toContain("GSTIN 07AAAAA0000A1Z5");
    expect(footer.textContent).toContain("Rohini, Delhi 110085");
    expect(within(footer).getByRole("navigation", { name: "Legal" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/ANUTECH DIGITAL/i);
  });

  it("'call or WhatsApp you within 4 working hours' has its space", () => {
    render(<ThanksClient order={ORDER} isSimulation={false} brand={BRAND} />);
    expect(document.body.textContent).toMatch(/WhatsApp you within 4 working hours/);
    expect(document.body.textContent).not.toMatch(/youwithin/);
  });

  it("without a readable tenant row the page still works, with no company name invented", () => {
    render(<ThanksClient order={ORDER} isSimulation={false} brand={null} />);
    expect(document.body.textContent).not.toMatch(/ANUTECH DIGITAL/i);
    expect(screen.getByText(/Welcome aboard, Ravi/)).toBeTruthy();
  });
});
