// @vitest-environment jsdom
// R-1774 — the term badge on a /subscriptions row speaks the chip words, and a 3-month TERM
// (the owner's staging row, Google Workspace ₹1,620 a quarter) says "Check term" with
// Correct details one click away. Nothing is changed by showing it.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SubCycleBadge } from "./sub-cycle-badge";
import { subscriptionCycle, type CycleSub } from "@/lib/subscriptions/billing-cycle";

afterEach(cleanup);

const sub = (over: Partial<CycleSub> = {}): CycleSub => ({
  billing_cycle: "yearly", term_months: 12, start_date: "2026-01-01", renewal_date: "2027-01-01", ...over,
});

describe("SubCycleBadge", () => {
  it("annual billed yearly, with the amount", () => {
    render(<SubCycleBadge cyc={subscriptionCycle(sub())} amount="₹1,39,500" />);
    expect(screen.getByText("Annual · billed yearly · ₹1,39,500")).toBeTruthy();
  });

  it("annual billed in parts names the part", () => {
    render(<SubCycleBadge cyc={subscriptionCycle(sub({ billing_cycle: "quarterly" }))} amount="₹7,646" />);
    expect(screen.getByText("Annual · billed quarterly · ₹7,646")).toBeTruthy();
  });

  it("monthly flexible shows no amount (the MRR is already on the row)", () => {
    render(<SubCycleBadge cyc={subscriptionCycle(sub({ billing_cycle: "monthly", term_months: 1 }))} amount="₹1,350" />);
    expect(screen.getByText("Monthly (Flexible)")).toBeTruthy();
  });

  it("the owner's quarterly-term row: Check term + Correct details opens the dialog", () => {
    const onCorrect = vi.fn();
    const row = sub({ billing_cycle: "quarterly", term_months: 3, start_date: "2026-07-19", renewal_date: "2026-10-19" });
    const rowClick = vi.fn();
    render(
      <div onClick={rowClick}>
        <SubCycleBadge cyc={subscriptionCycle(row)} amount="₹1,620" onCorrect={onCorrect} />
      </div>,
    );
    expect(screen.getByText("Check term — vendors sell annual or monthly")).toBeTruthy();
    expect(screen.queryByText(/Quarterly/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Correct details" }));
    expect(onCorrect).toHaveBeenCalledTimes(1);
    expect(rowClick).not.toHaveBeenCalled();   // the row's drawer does not open on top
  });

  it("no term → nothing", () => {
    const { container } = render(
      <SubCycleBadge cyc={subscriptionCycle(sub({ start_date: null, renewal_date: null }))} amount={null} />,
    );
    expect(container.textContent).toBe("");
  });
});
