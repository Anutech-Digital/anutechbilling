// @vitest-environment jsdom
/**
 * R-2833 — a screen reader heard nothing while the Renewals "Last bill" column or the header Remind
 * button was still loading (a bare "…" and a greyed button). Now the cell is a polite status
 * "Loading…" (aria-busy, with a title) and the Remind button is aria-busy while the contacts load.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { LastInvoiceCell } from "./row-cells";
import { RenewalRemindButton } from "./reminder-dialog";
import { reminderPlan, reminderScope, type RenewalRowLike } from "./reminders";

afterEach(cleanup);

describe("R-2833 Last bill cell while loading", () => {
  it("is a role=status, aria-busy 'Loading…' with a title", () => {
    render(<LastInvoiceCell docs={undefined} loading failed={false} canInvoices canQuotes todayIst="2026-11-15" />);
    const el = screen.getByRole("status");
    expect(el.textContent).toBe("Loading…");
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.getAttribute("title")).toBeTruthy();
  });
  it("is not a status once loaded (failed shows the plain message)", () => {
    render(<LastInvoiceCell docs={undefined} loading={false} failed canInvoices canQuotes todayIst="2026-11-15" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("R-2833 header Remind button while contacts load", () => {
  const rows: RenewalRowLike[] = [];
  const plan = reminderPlan(rows, { today: new Date("2026-11-15T06:30:00Z"), emailOf: () => "a@x.in" });
  it("is aria-busy while loading, not otherwise", () => {
    const { rerender } = render(<RenewalRemindButton scope={reminderScope(0, "8–30", 0)} plan={plan} loading onClick={() => {}} />);
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
    rerender(<RenewalRemindButton scope={reminderScope(0, "8–30", 0)} plan={plan} onClick={() => {}} />);
    expect(screen.getByRole("button").hasAttribute("aria-busy")).toBe(false);
  });
});
