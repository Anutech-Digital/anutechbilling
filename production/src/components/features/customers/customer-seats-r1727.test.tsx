// @vitest-environment jsdom
// R-1727 (owner journey audit 21 Oct): the company page read "MRR … 1 sub · 0/10 seats".
// The 0 is `used` (assigned users, never synced) — the owner could not tell what it meant,
// and there was no way to add seats from there.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Subscription } from "@/lib/supabase/database.types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { SubscriptionList, CustomerMetricBar, deriveCustomerInsights } from "./customer-insights";

afterEach(cleanup);

const sub = {
  id: "sub-tj1", customer_id: "cus-1", customer_name: "T-J1 Traders", plan: "Business Standard",
  vendor: "google", status: "active", seats: 10, used: 0, used_synced_at: null, mrr: 8640,
  outstanding_amount: 0, domain: "tj1.example", start_date: "2026-10-01", renewal_date: "2027-10-01",
} as unknown as Subscription;

describe("R-1727 company page seats line", () => {
  it("subscription card says '10 seats licensed', never '0/10 seats'", () => {
    render(<SubscriptionList subs={[sub]} />);
    expect(screen.queryByText(/0\/10 seats/)).toBeNull();
    expect(screen.getByText("10 seats licensed")).toBeDefined();
  });

  it("subscription card has a Manage seats link that opens the dialog on /subscriptions", () => {
    render(<SubscriptionList subs={[sub]} />);
    const link = screen.getByRole("link", { name: /Manage seats/ });
    expect(link.getAttribute("href")).toBe("/subscriptions?seats=sub-tj1");
  });

  it("MRR tile hint reads '1 subscription · 10 seats licensed'", () => {
    const insights = deriveCustomerInsights({ id: "cus-1", name: "T-J1 Traders" } as never, [sub], []);
    render(<CustomerMetricBar insights={insights} />);
    expect(screen.queryByText(/0\/10 seats/)).toBeNull();
    expect(screen.getByText("1 subscription · 10 seats licensed")).toBeDefined();
  });
});
