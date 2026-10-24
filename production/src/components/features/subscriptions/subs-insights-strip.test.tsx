// @vitest-environment jsdom
// R-1727 (owner journey audit 21 Oct, /subscriptions at 1280px): three boxes sat above the
// list — the analytics banner, "Margin at risk" and "License leakage" — and pushed the table
// below the first screen. Owner expects: the first rows of the table on the first screen.
// They now live in ONE strip, closed by default, whose closed line still carries the counts.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { SubsInsightsStrip, INSIGHTS_OPEN_KEY } from "./subs-insights-strip";

/* jsdom here has no working localStorage — an in-memory stand-in (same as attendance-reminder.test). */
const mem = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
  },
});

afterEach(cleanup);
beforeEach(() => mem.clear());

const counts = {
  mrr: 8640, arr: 103680, seats: "10 seats licensed",
  marginAtRisk: 2, marginUnchecked: 1,
  leakingMonthly: 1200, leakingCount: 1, neverReconciled: 3,
};

describe("R-1727 SubsInsightsStrip", () => {
  it("starts CLOSED, and the closed line still says the counts", () => {
    render(<SubsInsightsStrip {...counts}><p>BOXES</p></SubsInsightsStrip>);
    const toggle = screen.getByRole("button", { name: /Insights/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("BOXES")).toBeNull();
    expect(screen.getByText(/Margin at risk/).textContent).toMatch(/2/);
    expect(screen.getByText(/Leaking/).textContent).toMatch(/1,200\/mo/);
    expect(screen.getByText(/Never reconciled/).textContent).toMatch(/3/);
    expect(screen.getByText(/10 seats licensed/)).toBeDefined();
  });

  it("opens on click and remembers it for this viewer", () => {
    render(<SubsInsightsStrip {...counts}><p>BOXES</p></SubsInsightsStrip>);
    fireEvent.click(screen.getByRole("button", { name: /Insights/ }));
    expect(screen.getByText("BOXES")).toBeDefined();
    expect(window.localStorage.getItem(INSIGHTS_OPEN_KEY)).toBe("open");
    cleanup();
    render(<SubsInsightsStrip {...counts}><p>BOXES</p></SubsInsightsStrip>);
    expect(screen.getByText("BOXES")).toBeDefined();
  });

  it("nothing wrong → says so instead of zero-chips", () => {
    render(<SubsInsightsStrip {...counts} marginAtRisk={0} marginUnchecked={0} leakingCount={0} leakingMonthly={0} neverReconciled={0}><p>B</p></SubsInsightsStrip>);
    expect(screen.queryByText(/Margin at risk/)).toBeNull();
    expect(screen.getByText(/No margin or leakage warnings/)).toBeDefined();
  });
});

describe("R-1727 /subscriptions — the list is not pushed below the fold", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/subscriptions/page.tsx"), "utf8");
  it("Margin at risk and License leakage render INSIDE the closed strip", () => {
    const open = src.indexOf("<SubsInsightsStrip");
    const close = src.indexOf("</SubsInsightsStrip>");
    expect(open).toBeGreaterThan(-1);
    for (const box of ["<MarginAlertsCard", "<LicenseLeakageCard"]) {
      const at = src.indexOf(box);
      expect(at).toBeGreaterThan(open);
      expect(at).toBeLessThan(close);
    }
  });
  it("the old separate analytics banner is gone", () => {
    expect(src).not.toMatch(/Subscriptions Revenue Analytics/);
  });
});
