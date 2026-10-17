// @vitest-environment jsdom
/**
 * R-1504 (Pawan, staging report dadfbf2b): /ssl's "Get a quote" opened /quote on Google
 * Workspace Business Starter, so SSL looked missing. The SSL CTAs now carry the product
 * (/quote?product=ssl&ed=<line>) and /quote opens on the SSL category with that line picked.
 * SSL prices come from CERTS (the data /ssl prints) — never typed twice.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const search = { current: new URLSearchParams() };
vi.mock("next/navigation", () => ({
  useSearchParams: () => search.current,
  usePathname: () => "/quote",
  useRouter: () => ({ push: vi.fn() }),
}));

import { QuoteBuilder } from "./QuoteBuilder";
import { CertCards } from "../ssl/CertCards";
import { CERTS } from "@/site/lib/data/catalog";
import { QUOTE_PRODUCTS, quotePrefill, sslQuoteHref } from "@/site/lib/data/quote-catalog";

afterEach(() => { cleanup(); search.current = new URLSearchParams(); });

const checked = () =>
  Array.from(document.querySelectorAll('[role="checkbox"][aria-checked="true"]')).map((b) => b.getAttribute("aria-label"));

describe("R-1504 /ssl → /quote carries SSL", () => {
  it("/ssl's paid-certificate CTAs link to /quote with the SSL product, Free DV stays Included", () => {
    render(<CertCards />);
    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(links).toEqual([
      "/quote?product=ssl&ed=SSL+Positive",
      "/quote?product=ssl&ed=SSL+Wildcard",
      "/quote?product=ssl&ed=SSL+OV%2FEV",
    ]);
    expect(screen.getByRole("button", { name: "Included" }).hasAttribute("disabled")).toBe(true);
  });

  it("SSL quote prices are the ones /ssl prints (CERTS), OV/EV is price on request", () => {
    const by = (n: string) => QUOTE_PRODUCTS.find((p) => p.name === n)!;
    expect(by("SSL Positive").annual).toBe(CERTS.find((c) => c.name === "Positive SSL")!.addPrice);
    expect(by("SSL Wildcard").annual).toBe(CERTS.find((c) => c.name === "Wildcard")!.addPrice);
    expect(by("SSL OV/EV").priceOnRequest).toBe(true);
    expect(by("SSL OV/EV").vendor).toBe("SSL & security");
    expect(sslQuoteHref("Free DV")).toBeNull();
  });

  it("/quote?product=ssl opens on SSL with Positive SSL picked, not Workspace", () => {
    search.current = new URLSearchParams("product=ssl");
    render(<QuoteBuilder />);
    expect(checked()).toEqual(["Select Positive SSL — DV"]);
    expect(screen.getByRole("button", { name: /^SSL & security/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/Free DV/)).toBeTruthy();
    expect(screen.queryByText("Google Workspace Business Starter")).toBeNull();
  });

  it("/quote?product=ssl&ed=SSL+Wildcard picks the Wildcard line", () => {
    search.current = new URLSearchParams("product=ssl&ed=SSL+Wildcard");
    render(<QuoteBuilder />);
    expect(checked()).toEqual(["Select Wildcard SSL — DV"]);
  });

  it("an unknown product falls back to the old default (Workspace Starter, all plans)", () => {
    search.current = new URLSearchParams("product=bogus&ed=nope");
    render(<QuoteBuilder />);
    expect(checked()).toEqual(["Select Google Workspace Business Starter"]);
    expect(screen.getByRole("button", { name: /^All plans/ }).getAttribute("aria-pressed")).toBe("true");
    expect(quotePrefill(new URLSearchParams("product=bogus"), new Map([["GW Business Starter", { vendor: "Google Workspace" }]]))).toEqual({});
  });
});
