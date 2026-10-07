// @vitest-environment jsdom
//
// The margin maths is covered in lib/subscriptions/margin.test.ts and the matching in
// plan-match.test.ts. What's checked here is what the OWNER actually ends up reading —
// and it exists because this card cannot be browser-verified: there are zero
// subscriptions in the database after the tenant reset, so the running app renders
// nothing for it. This is the substitute, and it is a real one: the same component,
// really rendered, with the numbers a real row would carry.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MarginAlertsView } from "./margin-alerts-card";
import type { MarginAlert } from "@/lib/queries/margin-alerts";

afterEach(cleanup);

const P = (rupees: number) => rupees * 100;

const alert = (over: Partial<MarginAlert> = {}): MarginAlert => ({
  subscriptionId: "sub-1",
  customerName:   "Bright Systems",
  plan:           "Google Workspace Business Starter",
  vendor:         "google",
  seats:          10,
  unmatched:      false,
  unmatchedReason: null,
  sellPerSeatMonthPaise: P(270),
  costPerSeatMonthPaise: P(300),
  status:         "loss",
  marginBps:      -1_111,
  grossPerSeatMonthPaise: P(-30),
  grossMonthlyPaise:      P(-300),
  grossAnnualPaise:       P(-3_600),
  isLoss:         true,
  needsRepricing: true,
  costRose:       false,
  costRisePerSeatPaise: null,
  marginAtSaleBps: null,
  erodedBps:      null,
  ...over,
});

describe("MarginAlertsView — a loss", () => {
  it("names the customer, the margin and the yearly bleed", () => {
    render(<MarginAlertsView alerts={[alert()]} />);
    expect(screen.getByText("Bright Systems")).toBeDefined();
    expect(screen.getByText("-11.1%")).toBeDefined();
    // ₹30/seat/month × 10 seats × 12 — the number that decides if this is urgent.
    expect(screen.getByText(/losing.*3,600\/yr/)).toBeDefined();
    expect(screen.getByText("Loss")).toBeDefined();
  });

  it("shows both sides of the trade, so the figure can be checked by eye", () => {
    render(<MarginAlertsView alerts={[alert()]} />);
    expect(screen.getByText(/₹270\/seat sell vs ₹300 cost/)).toBeDefined();
  });

  it("says what to DO, and that mid-term is not it (§24)", () => {
    render(<MarginAlertsView alerts={[alert()]} />);
    expect(screen.getByText(/Reprice at\s+renewal/i)).toBeDefined();
  });

  it("totals the bleed across subscriptions in the header", () => {
    render(<MarginAlertsView alerts={[
      alert({ subscriptionId: "a", grossAnnualPaise: P(-3_600) }),
      alert({ subscriptionId: "b", customerName: "Softgen", grossAnnualPaise: P(-1_400) }),
    ]} />);
    expect(screen.getByText(/2 subscriptions at or below the margin floor/)).toBeDefined();
    expect(screen.getByText(/₹5,000\/yr going out the door/)).toBeDefined();
  });
});

describe("MarginAlertsView — an unpriceable row", () => {
  const unpriced = alert({
    subscriptionId: "sub-2",
    plan:           "Google Workspace Enterprise Plus",
    unmatched:      true,
    unmatchedReason: "no_such_plan",
    costPerSeatMonthPaise: null,
    status:         undefined,
    marginBps:      undefined,
    needsRepricing: false,
  });

  it("says the margin is UNKNOWN, not healthy — the whole point of showing it", () => {
    render(<MarginAlertsView alerts={[unpriced]} />);
    expect(screen.getByText(/margin is unknown, not healthy/i)).toBeDefined();
    expect(screen.getByText(/Google Workspace Enterprise Plus/)).toBeDefined();
  });

  it("points at the catalog, where the missing price is actually entered", () => {
    render(<MarginAlertsView alerts={[unpriced]} />);
    const links = screen.getAllByRole("link", { name: /^Products$/i });
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.getAttribute("href") === "/items")).toBe(true);
  });

  it("does not claim a risk count when only unpriced rows exist", () => {
    render(<MarginAlertsView alerts={[unpriced]} />);
    expect(screen.getByText(/No priced subscription is at risk/i)).toBeDefined();
  });
});

describe("MarginAlertsView — staying quiet", () => {
  it("renders NOTHING when every subscription is healthy", () => {
    // An always-visible card that usually says "all good" gets scrolled past — and
    // then gets scrolled past on the day it doesn't.
    const { container } = render(<MarginAlertsView alerts={[
      alert({ status: "healthy", marginBps: 5_926, needsRepricing: false, isLoss: false,
              grossAnnualPaise: P(19_200) }),
    ]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<MarginAlertsView alerts={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a thin margin as a warning rather than a loss", () => {
    render(<MarginAlertsView alerts={[
      alert({ status: "thin", marginBps: 500, isLoss: false, grossAnnualPaise: P(6_000),
              costPerSeatMonthPaise: P(950), sellPerSeatMonthPaise: P(1_000) }),
    ]} />);
    expect(screen.getByText("Thin")).toBeDefined();
    expect(screen.queryByText("Loss")).toBeNull();
    // Positive gross → no "losing" prefix on a thin-but-profitable line.
    expect(screen.queryByText(/losing/)).toBeNull();
  });
});
