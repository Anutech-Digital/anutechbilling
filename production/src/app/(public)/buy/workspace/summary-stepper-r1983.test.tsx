// @vitest-environment jsdom
/**
 * R-1983 (Pardeep, 26 Oct 2026, localhost checkout): change users — and Annual / Monthly — right
 * in the checkout's Order summary, without going back up. It is the ONE shared state: the hero
 * price card, the plan cards and the phone bar move with it. 301 users → Enterprise (no online
 * buy). Trial mode: at most 10 users (Google's trial cap). Money: planSum, unchanged.
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
];
const BRAND: BuyBrand = {
  name: "Tenant Seller Pvt Ltd", logoUrl: null, gstin: "07AAAAA0000A1Z5",
  address: "Rohini, Delhi 110085", stateCode: "07", phone: null, email: null,
};

let calls: Array<{ url: string; body: Record<string, unknown> }> = [];
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body });
    if (String(url).includes("coupons/validate")) {
      return new Response(JSON.stringify({ ok: true, code: "SAVE10", discount: Math.round(Number(body.gross_amount) * 0.1), discount_type: "percent", discount_value: 10 }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = () => render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialTierId="standard" initialSeats={10} />);
const summary = () => screen.getByRole("complementary", { name: "Order summary" });
const sumTotal = () => within(summary()).getByTestId("summary-total").textContent;
const seatsBox = () => within(summary()).getByLabelText("Users in this order") as HTMLInputElement;

describe("R-1983 users and billing in the order summary", () => {
  it("+ in the summary → 11 users; summary, hero card and phone bar all move together", () => {
    page();
    // 10 × 1,080 × 12 = 1,29,600 + 23,328 GST = 1,52,928
    expect(sumTotal()).toBe("₹1,52,928");
    fireEvent.click(within(summary()).getByRole("button", { name: "More users" }));
    expect(seatsBox().value).toBe("11");
    // 11 × 1,080 × 12 = 1,42,560 + 25,661 = 1,68,221
    expect(sumTotal()).toBe("₹1,68,221");
    expect(within(summary()).getByText("11 users × 12 months")).toBeTruthy();
    expect((document.getElementById("hero-seats") as HTMLInputElement).value).toBe("11");
    expect(screen.getByTestId("phone-bar").textContent).toContain("₹1,68,221");
    fireEvent.click(within(summary()).getByRole("button", { name: "Fewer users" }));
    expect(sumTotal()).toBe("₹1,52,928");
  });

  it("typing a number in the summary works too", () => {
    page();
    fireEvent.change(seatsBox(), { target: { value: "2" } });
    expect((document.getElementById("hero-seats") as HTMLInputElement).value).toBe("2");
    // 2 × 1,080 × 12 = 25,920 + 4,666 = 30,586
    expect(sumTotal()).toBe("₹30,586");
  });

  it("Monthly in the summary → the monthly bill, everywhere", () => {
    page();
    fireEvent.click(within(summary()).getByRole("button", { name: "Monthly" }));
    // 10 × 1,300 = 13,000 + 2,340 = 15,340
    expect(sumTotal()).toBe("₹15,340");
    expect(within(summary()).getByText("10 users × 1 month")).toBeTruthy();
    const heroMonthly = screen.getAllByRole("button", { name: "Monthly" }).filter((b) => !summary().contains(b));
    expect(heroMonthly.every((b) => b.getAttribute("aria-pressed") === "true")).toBe(true);
  });

  it("301 users → Enterprise: no online buy, the 300-user message", () => {
    page();
    fireEvent.change(seatsBox(), { target: { value: "300" } });
    expect(within(document.getElementById("checkout") as HTMLElement).queryByText(/Enterprise is quoted/)).toBeNull();
    fireEvent.click(within(summary()).getByRole("button", { name: "More users" }));
    expect(seatsBox().value).toBe("301");
    expect(within(summary()).getByText(/Over 300 users is Enterprise/)).toBeTruthy();
    expect(within(document.getElementById("checkout") as HTMLElement).getByText(/Enterprise is quoted/)).toBeTruthy();
    expect(within(summary()).queryByTestId("summary-total")).toBeNull();
  });

  it("a coupon is checked again when users change in the summary", async () => {
    page();
    fireEvent.change(within(summary()).getByPlaceholderText("Coupon code"), { target: { value: "SAVE10" } });
    fireEvent.click(within(summary()).getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(within(summary()).getByText("Coupon SAVE10 applied")).toBeTruthy());
    const before = calls.filter((c) => c.url.includes("coupons/validate")).length;
    fireEvent.click(within(summary()).getByRole("button", { name: "More users" }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("coupons/validate")).length).toBeGreaterThan(before), { timeout: 2000 });
    expect(calls.filter((c) => c.url.includes("coupons/validate")).at(-1)!.body).toMatchObject({ seats: 11 });
  });

  it("trial mode: at most 10 users from the summary, with Google's trial cap said", () => {
    page();
    fireEvent.click(screen.getByRole("button", { name: /Start 14-day free trial/ }));
    expect(seatsBox().value).toBe("10");
    fireEvent.click(within(summary()).getByRole("button", { name: "More users" }));
    expect(seatsBox().value).toBe("10");
    expect(within(summary()).getByText(/at most 10 users on a trial/)).toBeTruthy();
  });
});
