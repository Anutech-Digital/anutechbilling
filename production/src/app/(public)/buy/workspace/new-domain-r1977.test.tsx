// @vitest-environment jsdom
/**
 * R-1977 (Pardeep, 26 Oct 2026): "I need a new domain" on the checkout — name + ending → Check →
 * LIVE availability and 1-year price (the site's /api/domains/availability), choose one, and it
 * is a line in the order: Starter 1 user annual ₹3,240 + ravitraders.in ₹649 = ₹3,889 + GST ₹700
 * = ₹4,589. The route gets the CHOICE (domain, domainNew, the owner's address) — never a price.
 * "Couldn't check" says so (no guess) and offers a way on. Monthly: the domain is billed
 * separately, the Workspace monthly total is unchanged. Thanks page: "registering".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
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
const dom = (domain: string, available: boolean, price: number) => ({ domain, available, price: available ? price : 0, currency: "INR", years: 1, priceKnown: available });
const LOOKUP = {
  base: "ravitraders",
  domains: [dom("ravitraders.in", true, 649), dom("ravitraders.com", false, 0), dom("ravitraders.co.in", true, 449), dom("ravitraders.org", true, 999), dom("ravitraders.net", true, 1099)],
};

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let lookupStatus = 200;
beforeEach(() => {
  calls = []; lookupStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body });
    if (String(url).startsWith("/api/domains/availability")) {
      return new Response(JSON.stringify(lookupStatus === 200 ? LOOKUP : { error: "x" }), { status: lookupStatus });
    }
    if (String(url).includes("checkout/workspace")) return new Response(JSON.stringify({ simulated: true, quoteId: "Q-T-27-0001", publicToken: "tok" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = () => render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialTierId="starter" initialSeats={1} />);
const checkout = () => document.getElementById("checkout") as HTMLElement;
const summary = () => screen.getByRole("complementary", { name: "Order summary" });
const type = (label: RegExp | string, value: string) => fireEvent.change(within(checkout()).getByLabelText(label, { selector: "input,select" }), { target: { value } });

async function searchRavi() {
  fireEvent.click(within(checkout()).getByRole("radio", { name: /I need a new domain/ }));
  type("The domain you want", "ravitraders");
  fireEvent.click(within(checkout()).getByRole("button", { name: "Check" }));
  await waitFor(() => expect(within(checkout()).getByTestId("domain-results")).toBeTruthy());
}

describe("R-1977 new domain: live search, live price, in the order", () => {
  it("Check shows availability and price; the asked-for free name is chosen; taken ones say Taken", async () => {
    page();
    await searchRavi();
    expect(calls.find((c) => c.url.startsWith("/api/domains/availability"))!.url).toMatch(/name=ravitraders&tlds=in,com,co\.in,org,net/);
    const results = within(checkout()).getByTestId("domain-results");
    expect(results.textContent).toMatch(/ravitraders\.in₹649\/yr/);
    expect(results.textContent).toMatch(/ravitraders\.comTaken/);
    expect(within(results).getByRole("radio", { name: "Choose ravitraders.in" }).getAttribute("aria-checked")).toBe("true");
  });

  it("the chosen domain is a line in the summary and the total: ₹3,240 + ₹649 = ₹3,889 + ₹700 GST = ₹4,589", async () => {
    page();
    await searchRavi();
    const s = summary();
    expect(within(s).getByText("Domain ravitraders.in · 1 year")).toBeTruthy();
    expect(within(s).getByText("₹649")).toBeTruthy();
    expect(within(s).getByTestId("summary-total").textContent).toBe("₹4,589");
    // choosing another ending changes it
    fireEvent.click(within(checkout()).getByRole("radio", { name: "Choose ravitraders.co.in" }));
    // 3,240 + 449 = 3,689 + 664 = 4,353
    expect(within(s).getByTestId("summary-total").textContent).toBe("₹4,353");
  });

  it("Continue without choosing → told to check and choose; the owner's address is asked in step 2; the route gets choices only", async () => {
    page();
    fireEvent.click(within(checkout()).getByRole("radio", { name: /I need a new domain/ }));
    type("The domain you want", "ravitraders");
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue" }));
    expect(within(checkout()).getByText("Press Check, then choose an available domain")).toBeTruthy();
    fireEvent.click(within(checkout()).getByRole("button", { name: "Check" }));
    await waitFor(() => expect(within(checkout()).getByTestId("domain-results")).toBeTruthy());
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue" }));
    type("Your name", "Ravi Kumar");
    type("Email for invoice and login", "ravi@example.invalid");
    type("Mobile (WhatsApp)", "9811122233");
    fireEvent.change(within(checkout()).getByLabelText("State (place of supply)"), { target: { value: "07" } });
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue to payment" }));
    expect(within(checkout()).getByText("Enter your 6-digit PIN code")).toBeTruthy();
    type(/^Address/, "12 Main Road, Rohini");
    type("City", "New Delhi");
    type("PIN code", "110085");
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue to payment" }));
    fireEvent.click(within(checkout()).getByLabelText(/I agree to the/));
    fireEvent.click(within(checkout()).getByRole("button", { name: "Place test order · ₹4,589" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(true));
    const body = calls.find((c) => c.url === "/api/public/checkout/workspace")!.body;
    expect(body).toMatchObject({ domain: "ravitraders.in", domainNew: true, addressLine1: "12 Main Road, Rohini", city: "New Delhi", pinCode: "110085", commitment: "annual" });
    for (const k of ["price", "domainPrice", "rate", "amount", "total"]) expect(body).not.toHaveProperty(k);
  });

  it("the registry can't be reached → 'Couldn't check' with a way on, nothing chosen, no guessed price", async () => {
    lookupStatus = 502;
    page();
    fireEvent.click(within(checkout()).getByRole("radio", { name: /I need a new domain/ }));
    type("The domain you want", "ravitraders");
    fireEvent.click(within(checkout()).getByRole("button", { name: "Check" }));
    await waitFor(() => expect(within(checkout()).getByRole("alert").textContent).toMatch(/Couldn't check right now/));
    expect(within(checkout()).getByRole("link", { name: "WhatsApp us" })).toBeTruthy();
    expect(within(summary()).queryByText(/Domain ravitraders/)).toBeNull();
    expect(within(summary()).getByTestId("summary-total").textContent).toBe("₹3,823");
  });

  it("Monthly: the domain is billed separately; the Workspace monthly total is unchanged (₹325 + ₹59 = ₹384)", async () => {
    page();
    fireEvent.click(screen.getAllByRole("button", { name: "Monthly" })[0]);
    await searchRavi();
    const s = summary();
    expect(within(s).getByText("Domain ravitraders.in · billed separately")).toBeTruthy();
    expect(within(s).getByTestId("summary-total").textContent).toBe("₹384");
  });

  it("annual without a new domain: ₹3,823, unchanged", () => {
    page();
    expect(within(summary()).getByTestId("summary-total").textContent).toBe("₹3,823");
  });
});

describe("R-1977 thanks page", () => {
  const ORDER: ThanksOrder = {
    quoteId: "Q-T-27-0001", invoiceNumber: null, customerName: "Ravi Traders", tierName: "Business Starter",
    seats: 1, amount: 4589, subtotal: 3889, paymentStatus: "received", paymentState: "paid",
    amountReceived: 4589, paymentDate: null, newDomain: "ravitraders.in",
  };
  it("shows the new domain as registering", () => {
    render(<ThanksClient order={ORDER} isSimulation={false} brand={BRAND} />);
    expect(screen.getByTestId("thanks-domain").textContent).toMatch(/ravitraders\.in — registering, we will confirm by email/);
  });
  it("no new domain → no domain row", () => {
    render(<ThanksClient order={{ ...ORDER, newDomain: null }} isSimulation={false} brand={BRAND} />);
    expect(screen.queryByTestId("thanks-domain")).toBeNull();
  });
});
