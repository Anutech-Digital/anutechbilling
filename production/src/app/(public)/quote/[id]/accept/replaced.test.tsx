// @vitest-environment jsdom
/**
 * R-448 — an old quote link shows "This quote was replaced", never Accept.
 */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import { QuoteReplaced, replacementHref } from "./replaced";

afterEach(cleanup);

describe("replacementHref", () => {
  it("links to the new quote with its own token", () => {
    expect(replacementHref({ id: "Q-X-0005-R2", status: "sent", public_token: "abc" }))
      .toBe("/quote/Q-X-0005-R2/accept?t=abc");
  });
  it("never links to a draft or a quote without a token", () => {
    expect(replacementHref({ id: "Q-X-0005-R2", status: "draft", public_token: "abc" })).toBeNull();
    expect(replacementHref({ id: "Q-X-0005-R2", status: "sent", public_token: null })).toBeNull();
    expect(replacementHref(null)).toBeNull();
  });
});

describe("QuoteReplaced", () => {
  it("says the quote was replaced and has no Accept button", () => {
    render(<QuoteReplaced quoteId="Q-X-0005" newId="Q-X-0005-R2" href="/quote/Q-X-0005-R2/accept?t=abc" tenantName="Anutech" />);
    expect(screen.getByText("This quote was replaced")).toBeTruthy();
    expect(screen.getByRole("link", { name: /open the latest quote/i }).getAttribute("href")).toBe("/quote/Q-X-0005-R2/accept?t=abc");
    expect(screen.queryByText(/accept this quote/i)).toBeNull();
  });
});

describe("the accept page checks for a replacement before rendering", () => {
  it("returns QuoteReplaced when superseded_by is set, before the Accept view", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    const guard = src.indexOf("rev?.superseded_by");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(src.indexOf("<QuoteAcceptView"));
    expect(guard).toBeLessThan(src.indexOf("recordQuoteView("));
  });
});
