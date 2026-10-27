// @vitest-environment jsdom
/**
 * R-1978 (26 Oct 2026, G-ADS): the buy page sends the ad it was reached from with every order,
 * trial and quote — the first ad landing URL of the visit (utm_*, utm_content, utm_term, fbclid,
 * gclid) as pageUrl and document.referrer as pageReferrer (site/lib/ad-attribution.ts
 * landingForForm) — instead of trusting the Referer. And ?coupon=CODE on a buy link fills the
 * coupon box and checks it.
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
import { parseBuyParams } from "@/lib/checkout/buy-link";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG = [row("s", "Google Workspace Business Starter", 270, 325), row("d", "Google Workspace Business Standard", 1080, 1300)];
const AD = "/buy/workspace?utm_source=facebook&utm_medium=paid_social&utm_campaign=ws-oct&utm_content=ad1&utm_term=gsuite&fbclid=FB.123";

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
beforeEach(() => {
  calls = [];
  window.sessionStorage.clear();
  window.history.replaceState(null, "", AD);
  Object.defineProperty(document, "referrer", { value: "https://l.facebook.com/", configurable: true });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body });
    if (String(url).includes("coupons/validate")) {
      return new Response(JSON.stringify({ ok: true, code: "SAVE10", discount: Math.round(Number(body.gross_amount) * 0.1), discount_type: "percent", discount_value: 10 }), { status: 200 });
    }
    if (String(url).includes("checkout/workspace")) return new Response(JSON.stringify({ simulated: true, quoteId: "Q-T-27-0001", publicToken: "tok" }), { status: 200 });
    return new Response("{}", { status: 200 });
  }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

const checkout = () => document.getElementById("checkout") as HTMLElement;
const type = (label: RegExp | string, value: string) => fireEvent.change(within(checkout()).getByLabelText(label, { selector: "input,select" }), { target: { value } });

describe("R-1978 the buy page sends the ad with the order", () => {
  it("Place order → pageUrl is the ad landing URL (utm_content, utm_term, fbclid), pageReferrer the referrer", async () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} initialTierId="starter" initialSeats={1} />);
    // the visitor moves on inside the page — the FIRST ad URL is what counts
    window.history.replaceState(null, "", "/buy/workspace#checkout");
    type("Your domain", "ravitraders.in");
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue" }));
    type("Your name", "Ravi Kumar");
    type("Email for invoice and login", "ravi@example.invalid");
    type("Mobile (WhatsApp)", "9811122233");
    fireEvent.change(within(checkout()).getByLabelText("State (place of supply)"), { target: { value: "07" } });
    fireEvent.click(within(checkout()).getByRole("button", { name: "Continue to payment" }));
    fireEvent.click(within(checkout()).getByLabelText(/I agree to the/));
    fireEvent.click(within(checkout()).getByRole("button", { name: /Place test order/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/public/checkout/workspace")).toBe(true));
    const body = calls.find((c) => c.url === "/api/public/checkout/workspace")!.body;
    expect(String(body.pageUrl)).toMatch(/utm_source=facebook/);
    expect(String(body.pageUrl)).toMatch(/utm_content=ad1/);
    expect(String(body.pageUrl)).toMatch(/utm_term=gsuite/);
    expect(String(body.pageUrl)).toMatch(/fbclid=FB\.123/);
    expect(body.pageReferrer).toBe("https://l.facebook.com/");
  });
});

describe("R-1978 ?coupon= on a buy link", () => {
  it("parseBuyParams reads a clean coupon code; junk is ignored", () => {
    expect(parseBuyParams({ coupon: "save10" }).coupon).toBe("SAVE10");
    expect(parseBuyParams({ coupon: "<script>" }).coupon).toBeNull();
    expect(parseBuyParams({}).coupon).toBeNull();
  });

  it("the coupon box is filled and checked on arrival", async () => {
    render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} initialTierId="starter" initialSeats={1} initialCoupon="SAVE10" />);
    const summary = screen.getByRole("complementary", { name: "Order summary" });
    await waitFor(() => expect(within(summary).getByText("Coupon SAVE10 applied")).toBeTruthy());
    expect(calls.find((c) => c.url.includes("coupons/validate"))!.body).toMatchObject({ code: "SAVE10", tier: "starter", seats: 1 });
    // 3,240 − 324 = 2,916 + 525 GST = 3,441
    expect(within(summary).getByTestId("summary-total").textContent).toBe("₹3,441");
  });
});
