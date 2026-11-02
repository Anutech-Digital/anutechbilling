// @vitest-environment jsdom
/**
 * R-2355 (2 Nov 2026): on the DESKTOP checkout, Monthly billing + "I need a new domain" + Pay.
 * Step 2 asks for the domain owner's address (useCheckout.buysDomain is true on Monthly too), but
 * checkoutBody() only sent it on an ANNUAL order — while /api/public/checkout/workspace refuses any
 * new-domain order without it (R-1977 / R-1985: "we need your address, city, PIN code"). So the
 * buyer filled the address and the order was refused. This drives the real desktop component
 * (BuyWorkspaceClient → _parts/checkout.tsx → submit-order.ts payOrder) and reads the body sent.
 * route.desktop-monthly-r2355.test.ts posts that same body to the real route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

import { BuyWorkspaceClient, type CatalogItem } from "../buy-workspace-client";
import { checkoutBody, EMPTY_BUYER, EMPTY_DOMAIN, type DomainChoice } from "./checkout-form";
import type { BuyBrand } from "./brand";
import type { BuyPlan } from "./plans";

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
const LOOKUP = {
  base: "ravitraders",
  domains: [{ domain: "ravitraders.in", available: true, price: 649, currency: "INR", years: 1, priceKnown: true }],
};

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body });
    if (String(url).startsWith("/api/domains/availability")) return new Response(JSON.stringify(LOOKUP), { status: 200 });
    if (String(url).includes("checkout/workspace")) return new Response(JSON.stringify({ simulated: true, quoteId: "Q-T-27-0001", publicToken: "tok" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const checkout = () => document.getElementById("checkout") as HTMLElement;
const type = (label: RegExp | string, value: string) => fireEvent.change(within(checkout()).getByLabelText(label, { selector: "input,select" }), { target: { value } });

describe("R-2355 desktop checkout: Monthly + new domain sends the owner's address", () => {
  it("Monthly → new domain → details + address → Place test order: the route gets addressLine1, city, PIN", async () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialTierId="starter" initialSeats={1} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Monthly" })[0]);
    fireEvent.click(within(checkout()).getByRole("radio", { name: /I need a new domain/ }));
    type("The domain you want", "ravitraders");
    fireEvent.click(within(checkout()).getByRole("button", { name: "Check" }));
    await waitFor(() => expect(within(checkout()).getByTestId("domain-results")).toBeTruthy());
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue" }));
    type("Your name", "Ravi Kumar");
    type("Email for invoice and login", "ravi@example.invalid");
    type("Mobile (WhatsApp)", "98111 22233");
    fireEvent.change(within(checkout()).getByLabelText("State (place of supply)"), { target: { value: "07" } });
    // Monthly asks for the address too (same fields + messages as Annual).
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue to payment" }));
    expect(within(checkout()).getByText("Enter your 6-digit PIN code")).toBeTruthy();
    type(/^Address/, "12 Main Road, Rohini");
    type("City", "New Delhi");
    type("PIN code", "110 085");
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue to payment" }));
    fireEvent.click(within(checkout()).getByLabelText(/I agree to the/));
    // ₹384 (month) + ₹766 (domain, own GST invoice) = ₹1,150 — unchanged by this card.
    fireEvent.click(within(checkout()).getByRole("button", { name: "Place test order · ₹1,150" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(true));
    const body = calls.find((c) => c.url === "/api/public/checkout/workspace")!.body;
    expect(body).toMatchObject({
      domain: "ravitraders.in", domainNew: true, commitment: "monthly",
      addressLine1: "12 Main Road, Rohini", city: "New Delhi", pinCode: "110085",
    });
    for (const k of ["price", "domainPrice", "rate", "amount", "total"]) expect(body).not.toHaveProperty(k);
  });
});

describe("R-2355 checkoutBody: the address goes with every new-domain order, never with an existing one", () => {
  const buyer = { ...EMPTY_BUYER, name: "Ravi Kumar", email: "ravi@example.invalid", phone: "98111 22233", stateCode: "07", addressLine1: " 12 Main Road ", city: " New Delhi ", pinCode: "110 085" };
  const picked: DomainChoice = { ...EMPTY_DOMAIN, mode: "new", newName: "ravitraders", picked: { domain: "ravitraders.in", price: 649, testPrice: false } };
  const body = (billing: "annual" | "monthly", domain: DomainChoice = picked) =>
    checkoutBody({ plan: { id: "starter" } as BuyPlan, seats: 1, billing, domain, buyer, couponCode: null, simulate: true });

  it.each(["annual", "monthly"] as const)("%s + new domain → address, city, PIN (trimmed)", (billing) => {
    expect(body(billing)).toMatchObject({ domainNew: true, commitment: billing, addressLine1: "12 Main Road", city: "New Delhi", pinCode: "110085" });
  });

  it.each(["annual", "monthly"] as const)("%s + own domain → no address sent", (billing) => {
    const b = body(billing, { ...EMPTY_DOMAIN, domain: "acme.in" });
    for (const k of ["addressLine1", "city", "pinCode"]) expect(b).not.toHaveProperty(k);
    expect(b.domainNew).toBeUndefined();
  });
});
