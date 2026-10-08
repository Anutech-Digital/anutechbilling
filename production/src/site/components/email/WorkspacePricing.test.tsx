// @vitest-environment jsdom
//
// R-232 (6 Oct 2026): every plan card on /google-workspace/pricing led to /quote or /trial —
// a buyer ready to pay had no way to the Razorpay checkout (/buy/workspace) from the page
// Google ads point at. The annual card now offers "Buy now" with the edition and seat count
// already chosen; quote and trial stay as the other ways in.
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import { WorkspacePricing, type PricedPlan } from "./WorkspacePricing";

afterEach(cleanup);

const plans: PricedPlan[] = [
  { key: "starter", edition: "GW Business Starter", annual: 160, monthly: 200 },
  { key: "standard", edition: "GW Business Standard", annual: 800, monthly: 960 },
  { key: "plus", edition: "GW Business Plus", annual: 1300, monthly: 1560 },
  { key: "enterprise", edition: null, annual: null, monthly: null },
];

function card(name: string): HTMLElement {
  const h = screen.getAllByRole("heading", { level: 3 }).find((x) => x.textContent === name);
  if (!h) throw new Error(`no card ${name}`);
  return h.closest("article") as HTMLElement;
}

describe("Workspace pricing → Buy now (R-232)", () => {
  it("Starter, 5 users, annual → /buy/workspace with Starter × 5 and the pay dialog open", () => {
    render(<WorkspacePricing plans={plans} />);
    fireEvent.change(screen.getByLabelText("Number of users"), { target: { value: "5" } });
    const buy = within(card("Business Starter")).getByRole("link", { name: "Buy now" });
    expect(buy.getAttribute("href")).toBe("/buy/workspace?tier=starter&seats=5&buy=1");
  });

  it("every Business plan has Buy now first, then quote and trial", () => {
    render(<WorkspacePricing plans={plans} />);
    for (const [name, tier] of [["Business Starter", "starter"], ["Business Standard", "standard"]]) {
      const links = within(card(name)).getAllByRole("link");
      expect(links[0].textContent).toBe("Buy now");
      expect(links[0].getAttribute("href")).toBe(`/buy/workspace?tier=${tier}&seats=1&buy=1`);
      expect(links.some((l) => l.getAttribute("href")?.startsWith("/quote?"))).toBe(true);
      expect(links.some((l) => l.getAttribute("href")?.startsWith("/trial?"))).toBe(true);
    }
  });

  it("monthly (flexible) term has no online buy — the checkout sells annual only", () => {
    render(<WorkspacePricing plans={plans} />);
    fireEvent.click(screen.getByRole("radio", { name: /Flexible|Monthly/ }));
    expect(within(card("Business Starter")).queryByRole("link", { name: "Buy now" })).toBeNull();
    expect(within(card("Business Starter")).getByRole("link", { name: "Get this plan" }).getAttribute("href")).toMatch(/^\/quote\?/);
  });

  it("R-328: Business Plus shows no price — 'Contact us for pricing', quote + WhatsApp, never Buy now", () => {
    render(<WorkspacePricing plans={plans} />);
    fireEvent.change(screen.getByLabelText("Number of users"), { target: { value: "7" } });
    const c = card("Business Plus");
    expect(c.textContent).toContain("Contact us for pricing");
    expect(c.textContent).not.toMatch(/₹/);
    const links = within(c).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Get a quote", "Ask on WhatsApp"]);
    expect(links[0].getAttribute("href")).toBe("/quote?ed=GW+Business+Plus&seats=7&term=annual");
    expect(links[1].getAttribute("href")).toMatch(/^https:\/\/wa\.me\//);
    expect(links.some((l) => l.getAttribute("href")?.startsWith("/buy/"))).toBe(false);
    /* Starter and Standard keep their prices. */
    expect(card("Business Starter").textContent).toContain("₹160");
    expect(card("Business Standard").textContent).toContain("₹800");
  });

  it("Enterprise stays 'Talk to us'", () => {
    render(<WorkspacePricing plans={plans} />);
    const links = within(card("Enterprise")).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Talk to us"]);
  });
});
