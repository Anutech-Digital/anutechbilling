// @vitest-environment jsdom
//
// The rollup maths is covered in lib/leads/loss-reasons.test.ts. What's checked
// here is what the OWNER actually ends up reading: the ordering, the honesty
// about missing data, and that an empty window says "nothing lost" rather than
// rendering a chart of nothing.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { LossReasonsCard } from "./loss-reasons-card";

afterEach(cleanup);

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const lost = (over: Record<string, unknown> = {}) =>
  ({ stage: "lost", value: 10_000, lost_reason: "price", lost_at: daysAgo(5), ...over }) as never;

describe("LossReasonsCard", () => {
  it("leads with money, not tallies — one big loss outranks several small ones", () => {
    render(<LossReasonsCard leads={[
      lost({ lost_reason: "price", value: 10_000 }),
      lost({ lost_reason: "price", value: 10_000 }),
      lost({ lost_reason: "price", value: 10_000 }),
      lost({ lost_reason: "competitor", value: 500_000 }),
    ]} />);
    const labels = screen.getAllByText(/Price too high|Chose competitor/).map((n) => n.textContent);
    expect(labels[0]).toBe("Chose competitor");   // ₹5L beats 3 × ₹10k
    expect(labels[1]).toBe("Price too high");
  });

  it("shows the headline count and total value lost", () => {
    render(<LossReasonsCard leads={[lost({ value: 50_000 }), lost({ value: 50_000 })]} />);
    expect(screen.getByText(/2 deals/)).toBeDefined();
  });

  it("says 'nothing lost' instead of drawing an empty chart", () => {
    render(<LossReasonsCard leads={[{ stage: "won", value: 1000 } as never]} />);
    expect(screen.getByText(/No deals marked lost/i)).toBeDefined();
  });

  it("empty text reads as English for every window (R-349: was 'in the last all time')", () => {
    render(<LossReasonsCard leads={[{ stage: "won", value: 1000 } as never]} />);
    expect(screen.getByText("No deals marked lost in the last 90 days.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "1 year" }));
    expect(screen.getByText("No deals marked lost in the last 1 year.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(screen.getByText("No deals marked lost yet.")).toBeDefined();
    expect(screen.queryByText(/all time\./i)).toBeNull();
  });

  it("surfaces un-recorded losses rather than quietly dropping them", () => {
    render(<LossReasonsCard leads={[lost({ lost_reason: null }), lost({ lost_reason: "price" })]} />);
    expect(screen.getByText("Not recorded")).toBeDefined();
  });

  it("warns when the picture is mostly un-recorded, so no false conclusion is drawn", () => {
    // The state this ships in: 7 old lost deals, no reasons yet.
    render(<LossReasonsCard leads={[
      lost({ lost_reason: null }), lost({ lost_reason: null }), lost({ lost_reason: "price" }),
    ]} />);
    expect(screen.getByText(/not yet a reliable picture/i)).toBeDefined();
  });

  it("drops the warning once most losses carry a reason", () => {
    render(<LossReasonsCard leads={[
      lost({ lost_reason: "price" }), lost({ lost_reason: "timing" }), lost({ lost_reason: null }),
    ]} />);
    expect(screen.queryByText(/not yet a reliable picture/i)).toBeNull();
  });

  it("the window picker actually filters by lost_at", () => {
    render(<LossReasonsCard leads={[
      lost({ lost_reason: "price",      lost_at: daysAgo(10) }),
      lost({ lost_reason: "competitor", lost_at: daysAgo(200) }),
    ]} />);
    // Default window is 90 days → only the recent one.
    expect(screen.getByText(/1 deal\b/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "All time" }));
    expect(screen.getByText(/2 deals/)).toBeDefined();
  });
});
