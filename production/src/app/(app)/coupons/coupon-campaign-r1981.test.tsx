// @vitest-environment jsdom
/**
 * R-1981 (26 Oct 2026, G-ADS): a coupon can belong to a marketing campaign
 * (coupons.campaign_id → marketing_campaigns, migration *_r1981_*). The owner's path:
 *   Coupons → New coupon → pick "Diwali offer" → Create → the list shows the campaign,
 *   and the redemption log says which campaign the code belongs to.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor, cleanup } from "@testing-library/react";

const createSpy = vi.fn(async (_input: Record<string, unknown>) => ({}));

const COUPONS = [
  { code: "DIWALI15", tenant_id: "t", description: null, discount_type: "percent", discount_value: 15,
    applies_to_tier: null, applies_to_vendor: "google", min_seats: 1, max_seats: null, max_redemptions: null,
    redemption_count: 2, valid_from: "2026-10-01", valid_until: null, is_active: true, created_by: null,
    created_at: "2026-10-01", updated_at: "2026-10-01", campaign_id: "camp-1" },
  { code: "PLAIN5", tenant_id: "t", description: null, discount_type: "percent", discount_value: 5,
    applies_to_tier: null, applies_to_vendor: "google", min_seats: 1, max_seats: null, max_redemptions: null,
    redemption_count: 0, valid_from: "2026-10-01", valid_until: null, is_active: true, created_by: null,
    created_at: "2026-10-01", updated_at: "2026-10-01", campaign_id: null },
];

const CAMPAIGNS = [
  { id: "camp-1", name: "Diwali offer", code: "diwali-26", start_date: "2026-10-01", end_date: "2026-10-31", cancelled: false },
  { id: "camp-2", name: "Old promo",    code: "old-promo", start_date: "2026-08-01", end_date: "2026-08-31", cancelled: true },
];

vi.mock("@/lib/queries/coupons", () => ({
  useCoupons: () => ({ data: COUPONS, isLoading: false, error: null, refetch: vi.fn() }),
  useCouponRedemptions: () => ({ data: [], isLoading: false, error: null }),
  useToggleCoupon: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteCoupon: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateCoupon: () => ({ mutateAsync: createSpy, isPending: false }),
}));
vi.mock("@/lib/queries/marketing-campaigns", () => ({
  useCampaignOptions: () => ({ data: CAMPAIGNS, isLoading: false }),
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => async () => true }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import CouponsPage from "./page";
import CreateCouponDialog from "@/components/features/coupons/create-coupon-dialog";
import CouponRedemptionsDialog from "@/components/features/coupons/coupon-redemptions-dialog";

beforeEach(() => createSpy.mockClear());
afterEach(() => cleanup());

describe("Coupons list — Campaign column (R-1981)", () => {
  it("shows the campaign a coupon belongs to, and 'No campaign' when none", () => {
    render(<CouponsPage />);
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Campaign" })).toBeTruthy();
    const diwali = within(table).getByText("DIWALI15").closest("tr")!;
    expect(within(diwali).getByText("Diwali offer")).toBeTruthy();
    const plain = within(table).getByText("PLAIN5").closest("tr")!;
    expect(within(plain).getByText("No campaign")).toBeTruthy();
  });
});

describe("New coupon — optional campaign (R-1981)", () => {
  it("saves the picked campaign; cancelled campaigns are not offered", async () => {
    render(<CreateCouponDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Code *"), { target: { value: "DIWALI20" } });
    const pick = screen.getByLabelText("Campaign (optional)") as HTMLSelectElement;
    const options = Array.from(pick.options).map((o) => o.text);
    expect(options).toEqual(["No campaign", "Diwali offer"]);
    fireEvent.change(pick, { target: { value: "camp-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Create coupon/ }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ code: "DIWALI20", campaign_id: "camp-1" });
  });

  it("no campaign picked → campaign_id null", async () => {
    render(<CreateCouponDialog open onOpenChange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Code *"), { target: { value: "PLAIN10" } });
    fireEvent.click(screen.getByRole("button", { name: /Create coupon/ }));
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({ code: "PLAIN10", campaign_id: null });
  });
});

describe("Redemption log names the campaign (R-1981)", () => {
  it("shows the coupon's campaign", () => {
    render(<CouponRedemptionsDialog open onOpenChange={() => {}} code="DIWALI15" campaignName="Diwali offer" />);
    expect(screen.getByText(/Campaign:/).textContent).toContain("Diwali offer");
  });
});
