// @vitest-environment jsdom
/**
 * R-1971 (26 Oct 2026, design v2): checkout on the page, no popup. The owner's paths:
 *   - Buy now → the page's checkout (three steps + order summary), never a dialog.
 *   - Standard, 2 users, Monthly, a Maharashtra buyer → ₹2,600 + IGST ₹468 = ₹3,068; the route
 *     gets only the CHOICES (commitment monthly, tier, users) — never a rate or an amount.
 *   - A Delhi buyer from a Delhi seller → CGST 9% + SGST 9%.
 *   - No terms tick → no order. Coupon in the summary. Business Plus → a GST quote request.
 *   - The invoice preview carries the buyer; the phone bar carries the total.
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

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let respond: (url: string) => unknown = () => ({});

beforeEach(() => {
  calls = [];
  respond = (url) => (url.includes("checkout/workspace") ? { simulated: true, quoteId: "Q-T-27-0001", publicToken: "tok" } : {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(respond(String(url))), { status: 200 });
  }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = (over: Partial<React.ComponentProps<typeof BuyWorkspaceClient>> = {}) =>
  render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} {...over} />);

const checkout = () => document.getElementById("checkout") as HTMLElement;
const type = (label: RegExp | string, value: string) => fireEvent.change(within(checkout()).getByLabelText(label, { selector: "input,select" }), { target: { value } });

function fillSteps(stateCode: string) {
  type("Your domain", "ravitraders.in");
  fireEvent.click(within(checkout()).getByRole("button", { name: "Continue" }));
  type("Your name", "Ravi Kumar");
  type(/Company or business name/, "Ravi Traders");
  type("Email for invoice and login", "ravi@example.invalid");
  type("Mobile (WhatsApp)", "9811122233");
  fireEvent.change(within(checkout()).getByLabelText("State (place of supply)"), { target: { value: stateCode } });
  // "Continue to payment" — or "Continue" when the last step is a quote (Plus, payment off)
  fireEvent.click(within(checkout()).getByRole("button", { name: /^Continue( to payment)?$/ }));
}
const summary = () => screen.getByRole("complementary", { name: "Order summary" });

describe("R-1971 inline checkout", () => {
  it("Buy now goes to the page's checkout — no dialog anywhere", () => {
    page();
    fireEvent.click(within(document.querySelector("header") as HTMLElement).getByRole("button", { name: "Buy now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(checkout()).getByRole("region", { name: "Your domain" })).toBeTruthy();
    expect(within(checkout()).getByRole("region", { name: "Business and GST details" })).toBeTruthy();
  });

  it("Standard, 2 users, Monthly, Maharashtra: ₹2,600 + IGST ₹468 = ₹3,068 — and the route gets choices only", async () => {
    page({ initialTierId: "standard", initialSeats: 2 });
    fireEvent.click(screen.getAllByRole("button", { name: "Monthly" })[0]);
    fillSteps("27");
    const s = summary();
    expect(within(s).getByText("2 users × ₹1,300/user/month × 1 month")).toBeTruthy();
    expect(within(s).getByText("IGST 18%")).toBeTruthy();
    expect(within(s).getByText("₹468")).toBeTruthy();
    expect(within(s).getByTestId("summary-total").textContent).toBe("₹3,068");
    fireEvent.click(within(checkout()).getByLabelText(/I agree to the/));
    fireEvent.click(within(checkout()).getByRole("button", { name: "Place test order · ₹3,068" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(true));
    const body = calls.find((c) => c.url === "/api/public/checkout/workspace")!.body;
    expect(body).toMatchObject({ tierId: "standard", seats: 2, commitment: "monthly", domain: "ravitraders.in", stateCode: "27", simulate: true, companyName: "Ravi Traders" });
    for (const k of ["rate", "amount", "subtotal", "monthlyRate", "total"]) expect(body).not.toHaveProperty(k);
  });

  it("Delhi buyer, Delhi seller: CGST 9% + SGST 9%; Starter 1 user annual still ₹3,823", () => {
    page({ initialTierId: "starter", initialSeats: 1 });
    fillSteps("07");
    const s = summary();
    expect(within(s).getByText("CGST 9%")).toBeTruthy();
    expect(within(s).getByText("SGST 9%")).toBeTruthy();
    expect(within(s).queryByText("IGST 18%")).toBeNull();
    expect(within(s).getByTestId("summary-total").textContent).toBe("₹3,823");
  });

  it("no terms tick → an error and no order", () => {
    page({ initialTierId: "starter", initialSeats: 1 });
    fillSteps("07");
    fireEvent.click(within(checkout()).getByRole("button", { name: /Place test order/ }));
    expect(within(checkout()).getByText(/Tick the box to agree/)).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(false);
  });

  /* R-1977: on ANNUAL a new domain is searched live and bought with the order (new-domain-r1977
     .test.tsx); on MONTHLY the name + ending go to the team, billed separately — as here. */
  it("step 1 needs a domain; on Monthly 'I need a new domain' sends name + ending as a new domain", async () => {
    page({ initialTierId: "starter", initialSeats: 1 });
    fireEvent.click(screen.getAllByRole("button", { name: "Monthly" })[0]);
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue" }));
    expect(within(checkout()).getByText("Enter a domain like yourcompany.in")).toBeTruthy();
    fireEvent.click(within(checkout()).getByRole("radio", { name: /I need a new domain/ }));
    type("The domain you want", "ravitraders");
    fireEvent.change(within(checkout()).getByLabelText("Domain ending"), { target: { value: ".co.in" } });
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue" }));
    type("Your name", "Ravi Kumar");
    type("Email for invoice and login", "ravi@example.invalid");
    type("Mobile (WhatsApp)", "9811122233");
    fireEvent.change(within(checkout()).getByLabelText("State (place of supply)"), { target: { value: "07" } });
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue to payment" }));
    fireEvent.click(within(checkout()).getByLabelText(/I agree to the/));
    fireEvent.click(within(checkout()).getByRole("button", { name: /Place test order/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(true));
    expect(calls.find((c) => c.url === "/api/public/checkout/workspace")!.body).toMatchObject({ domain: "ravitraders.co.in", domainNew: true, companyName: "Ravi Kumar" });
  });

  it("coupon in the summary: applied before GST, total drops", async () => {
    respond = (url) => (url.includes("coupons/validate") ? { ok: true, code: "SAVE10", discount: 324, discount_type: "percent", discount_value: 10 } : {});
    page({ initialTierId: "starter", initialSeats: 1 });
    fireEvent.change(within(summary()).getByLabelText("Coupon code"), { target: { value: "save10" } });
    fireEvent.click(within(summary()).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(within(summary()).getByText("Coupon SAVE10 applied")).toBeTruthy());
    // 3,240 − 324 = 2,916 + 525 GST = 3,441
    expect(within(summary()).getByTestId("summary-total").textContent).toBe("₹3,441");
  });

  it("Business Plus (price on request, R-328) → the last step sends a GST quote request, not a payment", async () => {
    page({ initialTierId: "plus", initialSeats: 3 });
    fillSteps("07");
    expect(within(checkout()).queryByRole("radiogroup", { name: "Payment method" })).toBeNull();
    fireEvent.click(within(checkout()).getByLabelText(/I agree to the/));
    fireEvent.click(within(checkout()).getByRole("button", { name: "Send me a GST quote" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/public/enquiry/workspace")).toBe(true));
    expect(calls.find((c) => c.url === "/api/public/enquiry/workspace")!.body).toMatchObject({ tierId: "plus", seats: 3, billing: "annual", stateCode: "07" });
    expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(false);
  });

  it("payment method tiles are a radiogroup; the invoice preview shows the buyer; the phone bar shows the total", () => {
    page({ initialTierId: "starter", initialSeats: 1 });
    fillSteps("27");
    const methods = within(checkout()).getByRole("radiogroup", { name: "Payment method" });
    expect(within(methods).getByRole("radio", { name: /UPI/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(methods).getByRole("radio", { name: /Card/ }));
    expect(within(methods).getByRole("radio", { name: /Card/ }).getAttribute("aria-checked")).toBe("true");
    const inv = screen.getByTestId("invoice-preview");
    expect(inv.textContent).toContain("Ravi Traders");
    expect(inv.textContent).toContain("Tenant Seller Pvt Ltd");
    expect(inv.textContent).toContain("IGST 18%");
    expect(screen.getByTestId("phone-bar").textContent).toContain("₹3,823");
  });

  it("payment off (production before go-live): no Pay — a GST quote request instead", () => {
    page({ paymentMode: "disabled", initialTierId: "starter", initialSeats: 1 });
    fillSteps("07");
    expect(within(checkout()).getByRole("button", { name: "Send me a GST quote" })).toBeTruthy();
    expect(within(checkout()).queryByRole("button", { name: /Pay / })).toBeNull();
  });
});
