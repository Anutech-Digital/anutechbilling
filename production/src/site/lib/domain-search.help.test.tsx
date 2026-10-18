// @vitest-environment jsdom
//
// R-1494 (17 Oct 2026, Pawan via staging AI Help): "Domain search does not work. Product
// flow blocked here completely." Staging's /api/domains/availability answers 502 because
// neither registrar path is set up there (config, not code). The site must still give a
// visitor a way on (CLAUDE.md §24): when the check fails, BOTH search boxes — the /domains
// page and the always-on dock — show the honest message plus "Ask us about <name>" (/quote)
// and a WhatsApp link with the name already written in. "Type a name" gets no actions.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fonts", () => ({
  domainSans: { variable: "df-sans" },
  domainSerif: { variable: "df-serif" },
  domainMono: { variable: "df-mono" },
}));
vi.mock("@/site/components/cart/CartProvider", () => ({
  useCart: () => ({ lines: [], add: vi.fn(), remove: vi.fn(), closeDrawer: vi.fn() }),
}));

import { WHATSAPP_URL } from "@/site/lib/config";
import { domainHelpLinks, UNREACHABLE } from "./domain-search";
import { DomainLanding } from "@/site/components/domains/DomainLanding";
import { DomainSearchDock } from "@/site/components/home/DomainSearchDock";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Staging today: the availability proxy answers 502. */
function stub502() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "Could not check availability right now." }), { status: 502 })),
  );
}

function expectHelp(name: string) {
  const ask = screen.getByRole("link", { name: `Ask us about ${name}` });
  expect(ask.getAttribute("href")).toBe("/quote");
  const wa = screen.getByRole("link", { name: /WhatsApp us/i });
  const href = wa.getAttribute("href") ?? "";
  expect(href.startsWith(`${WHATSAPP_URL}?text=`)).toBe(true);
  expect(decodeURIComponent(href.split("?text=")[1])).toContain(name);
}

describe("domainHelpLinks — one place builds the way on (R-1494)", () => {
  it("quote page + WhatsApp with the name written in", () => {
    const l = domainHelpLinks("kalpanaexports");
    expect(l.quoteHref).toBe("/quote");
    expect(l.whatsappHref.startsWith(`${WHATSAPP_URL}?text=`)).toBe(true);
    expect(decodeURIComponent(l.whatsappHref.split("?text=")[1])).toContain("kalpanaexports");
  });
});

describe("/domains page — a failed check still offers a next step (R-1494)", () => {
  it("502 → message + Ask us + WhatsApp", async () => {
    stub502();
    render(<DomainLanding tlds={[]} />);
    fireEvent.change(screen.getByLabelText("Domain name to search"), { target: { value: "anutechtest123" } });
    fireEvent.submit(screen.getByLabelText("Domain name to search").closest("form")!);
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    expectHelp("anutechtest123");
  });

  it("empty name → only 'Type a name', no help links", () => {
    render(<DomainLanding tlds={[]} />);
    fireEvent.submit(screen.getByLabelText("Domain name to search").closest("form")!);
    expect(screen.getByText("Type a name to check.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Ask us about/ })).toBeNull();
  });
});

describe("search dock — the same next step (R-1494)", () => {
  it("502 → message + Ask us + WhatsApp", async () => {
    stub502();
    render(<DomainSearchDock />);
    fireEvent.change(screen.getByLabelText("Search for a domain name"), { target: { value: "anutechtest123" } });
    fireEvent.submit(screen.getByLabelText("Search for a domain name").closest("form")!);
    expect(await screen.findByText(UNREACHABLE)).toBeTruthy();
    expectHelp("anutechtest123");
  });
});
