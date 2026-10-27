// @vitest-environment jsdom
/**
 * R-1986 follow-up (Pardeep, 26 Oct 2026): the order summary's first line shows the per-user rate —
 * annual "10 users × ₹270/user/month × 12 months", monthly "10 users × ₹325/user/month × 1 month" —
 * the same words on the GST invoice preview; the summary title is the full plan name.
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

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG = [row("s", "Google Workspace Business Starter", 270, 325), row("d", "Google Workspace Business Standard", 1080, 1300)];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = () => render(<BuyWorkspaceClient catalogItems={CATALOG} paymentMode="simulation" brand={null} initialTierId="starter" initialSeats={10} />);
const summary = () => screen.getByRole("complementary", { name: "Order summary" });

describe("R-1986 follow-up: the rate on the summary line", () => {
  it("annual: '10 users × ₹270/user/month × 12 months' ₹32,400, in the summary and the invoice preview", () => {
    page();
    expect(within(summary()).getByText("10 users × ₹270/user/month × 12 months")).toBeTruthy();
    expect(within(summary()).getByText("₹32,400")).toBeTruthy();
    expect(within(screen.getByTestId("invoice-preview")).getByText("10 users × ₹270/user/month × 12 months")).toBeTruthy();
  });

  it("monthly: '10 users × ₹325/user/month × 1 month' ₹3,250", () => {
    page();
    fireEvent.click(screen.getAllByRole("button", { name: "Monthly" })[0]);
    expect(within(summary()).getByText("10 users × ₹325/user/month × 1 month")).toBeTruthy();
    expect(within(summary()).getByText("₹3,250")).toBeTruthy();
  });

  it("the summary title is the full plan name", () => {
    page();
    expect(within(summary()).getByText("Google Workspace Business Starter")).toBeTruthy();
  });
});
