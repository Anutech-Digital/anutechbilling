// @vitest-environment jsdom
//
// R-1513 (17 Oct 2026, Pardeep): from any subscription, one click to its customer and to
// the quote it came from — and no dead link when there is no quote.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { subscriptionLinks, SubCustomerLink, SubQuoteLink } from "./sub-links";

afterEach(cleanup);

describe("R-1513: subscription → customer and quote", () => {
  it("customer link from customer_id; newest quote (renewal first); none without a quote", () => {
    expect(subscriptionLinks({ customer_id: "c-1", quote_id: "Q-1" }, { canQuotes: true }))
      .toEqual({ customerHref: "/customers/c-1", quoteHref: "/quotes/Q-1", quoteId: "Q-1" });
    expect(subscriptionLinks({ customer_id: "c-1", quote_id: "Q-1", renewal_quote_id: "Q-9" }, { canQuotes: true }).quoteHref)
      .toBe("/quotes/Q-9");
    expect(subscriptionLinks({ customer_id: null, quote_id: null }, { canQuotes: true }))
      .toEqual({ customerHref: null, quoteHref: null, quoteId: null });
    // R-237: billing cannot open /quotes — no link rather than a bounce.
    expect(subscriptionLinks({ customer_id: "c-1", quote_id: "Q-1" }, { canQuotes: false }).quoteHref).toBeNull();
  });

  it("renders real links, and nothing for a subscription without a quote", () => {
    render(
      <div>
        <SubCustomerLink sub={{ customer_id: "c-1" }} name="Acme Pvt Ltd" />
        <SubQuoteLink sub={{ customer_id: "c-1", quote_id: "Q-1" }} canQuotes />
        <SubQuoteLink sub={{ customer_id: "c-1", quote_id: null }} canQuotes />
      </div>,
    );
    expect(screen.getByRole("link", { name: "Acme Pvt Ltd" }).getAttribute("href")).toBe("/customers/c-1");
    const q = screen.getAllByRole("link", { name: /Quote/ });
    expect(q).toHaveLength(1);
    expect(q[0].getAttribute("href")).toBe("/quotes/Q-1");
  });

  it("no customer_id → the name is plain text", () => {
    render(<SubCustomerLink sub={{ customer_id: null }} name="Walk-in" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Walk-in")).toBeTruthy();
  });

  it("a click or Enter on the link never reaches the row (no drawer over the page)", () => {
    const rowClick = vi.fn();
    const rowKey = vi.fn();
    render(
      <div role="button" tabIndex={0} onClick={rowClick} onKeyDown={rowKey}>
        <SubCustomerLink sub={{ customer_id: "c-1" }} name="Acme" />
        <SubQuoteLink sub={{ customer_id: "c-1", quote_id: "Q-1" }} canQuotes />
      </div>,
    );
    for (const a of screen.getAllByRole("link")) {
      a.addEventListener("click", (e) => e.preventDefault()); // jsdom: no real navigation
      fireEvent.click(a);
      fireEvent.keyDown(a, { key: "Enter" });
    }
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowKey).not.toHaveBeenCalled();
  });

  it("the page uses the links on the table row, the phone card and the drawer", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src.match(/<SubCustomerLink /g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src.match(/<SubQuoteLink /g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});
