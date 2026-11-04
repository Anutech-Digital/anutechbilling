// @vitest-environment jsdom
// R-1696 — the Billing cycle chips on /subscriptions: only the cycles in the data, each
// with a count, aria-pressed on the chosen one, and the choice kept in ?cycle=.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { BillingCycleFilter } from "./billing-cycle-filter";
import {
  cycleOptions, cycleFromUrl, CYCLE_FILTERS, CYCLE_URL_VALUES,
  type CycleFilter, type CycleSub, type CycleUrlValue,
} from "@/lib/subscriptions/billing-cycle";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const sub = (over: Partial<CycleSub> = {}): CycleSub => ({
  billing_cycle: "yearly",
  term_months: 12,
  start_date: "2026-01-01",
  renewal_date: "2027-01-01",
  ...over,
});
const rows = [
  sub(),
  sub(),
  sub({ billing_cycle: "monthly", term_months: 1, renewal_date: null }),
  sub({ billing_cycle: "quarterly", term_months: 12 }),
];

describe("BillingCycleFilter", () => {
  it("shows only the cycles present, each with its count, in a labelled group", () => {
    render(<BillingCycleFilter options={cycleOptions(rows, "all")} value="all" onChange={() => {}} />);
    const group = screen.getByRole("group", { name: "Billing cycle" });
    expect(group).toBeTruthy();
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["All cycles4", "Annual · paid yearly2", "Annual · paid monthly/quarterly1", "Flexible (monthly)1"]);
    expect(screen.queryByRole("button", { name: /Quarterly/ })).toBeNull();
  });

  it("marks the chosen cycle with aria-pressed", () => {
    render(<BillingCycleFilter options={cycleOptions(rows, "monthly")} value="monthly" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /^Flexible \(monthly\)/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^All cycles/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("calls onChange with the cycle clicked (real buttons, so Enter/Space work)", () => {
    const onChange = vi.fn();
    render(<BillingCycleFilter options={cycleOptions(rows, "all")} value="all" onChange={onChange} />);
    const btn = screen.getByRole("button", { name: /Annual · paid monthly\/quarterly/ });
    expect(btn.tagName).toBe("BUTTON");
    fireEvent.click(btn);
    expect(onChange).toHaveBeenCalledWith("annual_split");
  });

  it("R-1774: a 3-month term shows as a yellow Check term chip, never as Quarterly", () => {
    const withQtr = [...rows, sub({ billing_cycle: "quarterly", term_months: 3, start_date: "2026-07-19", renewal_date: "2026-10-19" })];
    render(<BillingCycleFilter options={cycleOptions(withQtr, "all")} value="all" onChange={() => {}} />);
    const chip = screen.getByRole("button", { name: /^Check term/ });
    expect(chip.getAttribute("data-tone")).toBe("warning");
    expect(chip.className).toMatch(/bg-amber-soft/);
    expect(chip.getAttribute("title")).toMatch(/Correct details/);
    expect(screen.queryByRole("button", { name: /Quarterly/ })).toBeNull();
  });

  it("hides itself when the data has fewer than two cycles (nothing to choose)", () => {
    const { container } = render(
      <BillingCycleFilter options={cycleOptions([sub()], "all")} value="all" onChange={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("?cycle= in the URL", () => {
  it("reads the cycle from the URL on load", () => {
    window.history.replaceState(null, "", "/subscriptions?tab=active&cycle=monthly");
    const { result } = renderHook(() => useUrlChoice<CycleFilter>("cycle", CYCLE_FILTERS, "all"));
    expect(result.current[0]).toBe("monthly");
  });

  it("R-1774: an old ?cycle=quarterly link still opens — on Check term", () => {
    window.history.replaceState(null, "", "/subscriptions?cycle=quarterly");
    const { result } = renderHook(() => useUrlChoice<CycleUrlValue>("cycle", CYCLE_URL_VALUES, "all"));
    expect(cycleFromUrl(result.current[0])).toBe("check_term");
  });

  it("ignores a cycle it does not know", () => {
    window.history.replaceState(null, "", "/subscriptions?cycle=weekly");
    const { result } = renderHook(() => useUrlChoice<CycleFilter>("cycle", CYCLE_FILTERS, "all"));
    expect(result.current[0]).toBe("all");
  });

  it("writes the choice back next to the other params, and drops it for All", () => {
    window.history.replaceState(null, "", "/subscriptions?tab=active");
    const { result } = renderHook(() => useUrlChoice<CycleFilter>("cycle", CYCLE_FILTERS, "all"));
    act(() => result.current[1]("annual_split"));
    expect(window.location.search).toBe("?tab=active&cycle=annual_split");
    act(() => result.current[1]("all"));
    expect(window.location.search).toBe("?tab=active");
  });
});
