// @vitest-environment jsdom
/**
 * R-1478 (Pawan, staging 16 Oct): on /quote (1) the product list showed hosting as "₹50/site"
 * with no period, (2) Domain transfer said "no fee" while priced ₹649 (.in), (3) the page-bottom
 * band offered "Get a quote" on the quote page itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const path = { current: "/quote" };
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => path.current }));

import { QuoteBuilder } from "./QuoteBuilder";
import { CtaBand } from "../chrome/Chrome";
import { QUOTE_PRODUCTS, QUOTE_TLDS } from "@/site/lib/data/quote-catalog";

afterEach(() => { cleanup(); path.current = "/quote"; });

describe("R-1478 /quote: price periods, transfer wording, no self-CTA", () => {
  it("every priced row in the product list names its period (/mo or /yr)", () => {
    render(<QuoteBuilder />);
    const prices = Array.from(document.querySelectorAll("span.mono"))
      .map((s) => s.textContent ?? "")
      .filter((t) => /^₹[\d,]+\/\w+/.test(t));
    expect(prices.length).toBeGreaterThan(5);
    for (const t of prices) expect(t).toMatch(/^₹[\d,]+\/\w+\/(mo|yr)$/);
    expect(prices).toContain("₹50/site/mo"); // Hosting Starter, ₹49.99 a month
  });

  it("Domain transfer no longer says 'no fee' — the price includes a year's renewal", () => {
    const transfer = QUOTE_PRODUCTS.find((p) => p.name === "Domain transfer")!;
    expect(transfer.note).not.toMatch(/no fee|free/i);
    expect(transfer.note).toMatch(/includes 1 year renewal/i);
    expect(QUOTE_TLDS.find((t) => t.tld === ".in")?.transfer).toBe(649); // price unchanged
  });

  it("the page-bottom 'Get a quote' band is not shown on /quote, still shown elsewhere", () => {
    path.current = "/quote";
    const { container, unmount } = render(<CtaBand />);
    expect(container.textContent).not.toMatch(/Get a quote/);
    unmount();
    path.current = "/hosting";
    render(<CtaBand />);
    expect(screen.getByRole("link", { name: "Get a quote" })).toBeTruthy();
  });
});
