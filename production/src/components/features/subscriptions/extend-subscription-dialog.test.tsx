// @vitest-environment jsdom
/* R-809 — the Extend term dialog said "the renewal date will advance by 0 months" while the
   custom month box held an invalid count (12). An invalid count now hides that sentence; the
   red error above already says what is wrong. */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import type { Subscription } from "@/lib/supabase/database.types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ExtendSubscriptionDialog from "./extend-subscription-dialog";

afterEach(cleanup);

const sub = {
  id: "sub-1", tenant_id: "t1", customer_id: "c1", customer_name: "Test Co",
  plan: "Google Workspace Starter", vendor: "google", seats: 2, used: 0, mrr: 528, status: "active",
  start_date: "2026-09-03", renewal_date: "2027-09-02", term_months: 12, billing_cycle: "yearly",
} as unknown as Subscription;

function openMonths() {
  render(<ExtendSubscriptionDialog sub={sub} open onOpenChange={() => {}} />);
  fireEvent.click(screen.getByRole("radio", { name: "Months" }));
  return screen.getByLabelText("Custom months") as HTMLInputElement;
}

describe("Extend term dialog — advance sentence (R-809)", () => {
  it("invalid custom months (12): no 'advance by 0 months'", () => {
    const input = openMonths();
    fireEvent.change(input, { target: { value: "12" } });
    expect(screen.getByRole("alert").textContent).toMatch(/between 1 and 11/);
    expect(screen.queryByTestId("extend-advance")).toBeNull();
    expect(document.body.textContent).not.toMatch(/advance by/);
  });

  it("valid custom months (5): says the real count", () => {
    const input = openMonths();
    fireEvent.change(input, { target: { value: "5" } });
    expect(screen.getByTestId("extend-advance").textContent).toMatch(/advance by\s*5 months\./);
  });

  it("1 month reads '1 month', not '1 months'", () => {
    const input = openMonths();
    fireEvent.change(input, { target: { value: "1" } });
    expect(screen.getByTestId("extend-advance").textContent).toMatch(/advance by\s*1 month\./);
  });
});
