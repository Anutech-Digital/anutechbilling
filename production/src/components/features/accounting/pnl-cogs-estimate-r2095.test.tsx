// @vitest-environment jsdom
/* R-2095 (staging P&L, 30 Oct 2026): an estimated licence cost opened "COGS — vendor bills in this
   period: No transactions". The drill now shows the estimate's working and "Add vendor bill". */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
import { CogsEstimateCard } from "./pnl-drilldown-dialog";

afterEach(cleanup);

describe("R-2095 COGS drill — the estimate's basis", () => {
  it("states revenue × ratio, the vendors behind it, and links to Add vendor bill", () => {
    render(<CogsEstimateCard basis={{
      licenceRevenue: 200000, ratioPct: 60, estimated: 120000,
      vendors: [{ vendor: "google", label: "Google Workspace", subscriptions: 9, seats: 200, bookRevenue: 100000, bookCost: 60000 }],
    }} />);
    const card = screen.getByRole("region", { name: /estimated/i });
    expect(card.textContent).toMatch(/₹1,20,000 estimated/);
    expect(card.textContent).toMatch(/₹2,00,000 × 60%/);
    expect(card.textContent).toContain("Google Workspace");
    expect(card.textContent).toContain("9 · 200");
    expect(screen.getByRole("link", { name: /Add vendor bill/ }).getAttribute("href")).toBe("/accounting/bills?add=1");
  });
});
