// @vitest-environment jsdom
/* R-2243 — the "Why customers leave (last 12 months)" card on SaaS Metrics. */
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, within } from "@testing-library/react";
import { LeaveReasonsView } from "./leave-reasons-card";

const NOW = new Date("2026-11-17T10:00:00Z");
afterEach(cleanup);

describe("R-2243 Why customers leave card", () => {
  it("counts by reason with Not recorded last, and says how many left", () => {
    render(<LeaveReasonsView now={NOW} rows={[
      { status: "cancelled", cancelled_at: "2026-10-01T00:00:00Z", leave_reason_code: "price" },
      { status: "cancelled", cancelled_at: "2026-09-01T00:00:00Z", leave_reason_code: "price" },
      { status: "active", auto_renew: false, non_renew_set_at: "2026-11-02T00:00:00Z", leave_reason_code: "other_suite" },
      { status: "cancelled", cancelled_at: "2026-03-01T00:00:00Z", leave_reason_code: null },
    ]} />);
    const card = screen.getByTestId("leave-reasons-card");
    expect(within(card).getByText("Why customers leave (last 12 months)")).toBeTruthy();
    expect(within(screen.getByTestId("leave-reason-price")).getByText("Price too high")).toBeTruthy();
    expect(screen.getByTestId("leave-reason-price").textContent).toContain("2");
    expect(screen.getByTestId("leave-reason-other_suite").textContent).toContain("Moved to Microsoft 365 / other suite");
    expect(screen.getByTestId("leave-reason-unrecorded").textContent).toContain("Not recorded");
    const order = within(card).getAllByRole("listitem").map((li) => li.getAttribute("data-testid"));
    expect(order).toEqual(["leave-reason-price", "leave-reason-other_suite", "leave-reason-unrecorded"]);
    expect(card.textContent).toContain("4 left in total");
  });

  it("says so when nobody left", () => {
    render(<LeaveReasonsView now={NOW} rows={[{ status: "active", auto_renew: true }]} />);
    expect(screen.getByText(/No customer has left in the last 12 months/)).toBeTruthy();
  });
});
