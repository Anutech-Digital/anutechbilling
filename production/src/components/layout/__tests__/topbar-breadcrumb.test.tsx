// @vitest-environment jsdom
/**
 * R-1409 (Pawan, staging, 12 Oct 2026): the top-bar breadcrumb was plain text — on
 * /marketing/spend "Sales › Marketing Hub › Spend" could not take you back to Marketing Hub —
 * and /settings ("Settings › Settings") logged React's duplicate-key warning because each
 * crumb was keyed by its label.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { getCrumb } from "@/lib/nav";
import { TopBarBreadcrumb, resolveCrumbLinks } from "../topbar-breadcrumb";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderAt(pathname: string, role?: string) {
  // topbar.tsx wraps the crumbs in this <nav>.
  return render(
    <nav aria-label="Breadcrumb">
      <TopBarBreadcrumb pathname={pathname} crumb={getCrumb(pathname)} role={role} />
    </nav>,
  );
}

describe("TopBarBreadcrumb (R-1409)", () => {
  it("links every parent crumb to its page on /marketing/spend", () => {
    renderAt("/marketing/spend");
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Sales", resolveCrumbLinks("/marketing/spend", getCrumb("/marketing/spend"))[0].href],
      ["Marketing Hub", "/marketing"],
    ]);
    // The section crumb goes to a real page of the Sell section, never to "#" or nowhere.
    expect(links[0].getAttribute("href")).toMatch(/^\/[a-z]/);
  });

  it("renders the last crumb as plain text with aria-current=page", () => {
    renderAt("/marketing/spend");
    const current = screen.getByText("Spend");
    expect(current.tagName).not.toBe("A");
    expect(current.closest("a")).toBeNull();
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(screen.getAllByRole("link").every((a) => !a.hasAttribute("aria-current"))).toBe(true);
  });

  it("links a detail page back to its list (/customers/<id> → /customers)", () => {
    const path = "/customers/0b6f3c1e-1111-4222-8333-444455556666";
    renderAt(path);
    const crumb = getCrumb(path);
    expect(crumb.length).toBe(3);
    expect(screen.getByRole("link", { name: crumb[1] }).getAttribute("href")).toBe("/customers");
    // The head is the section's own first page, not a second link to the same list.
    expect(screen.getByRole("link", { name: crumb[0] }).getAttribute("href")).not.toBe("/customers");
  });

  it("has no duplicate-key warning on /settings and does not link the page to itself", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    renderAt("/settings");
    const keyWarnings = err.mock.calls.filter((args) => String(args[0]).includes("same key"));
    expect(keyWarnings).toEqual([]);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).queryAllByRole("link").map((a) => a.getAttribute("href"))).not.toContain("/settings");
    expect(within(nav).getAllByText("Settings")).toHaveLength(2);
  });

  it("keeps a parent crumb as text when the role cannot open that page", () => {
    // sales cannot open the Marketing Hub (owner/manager only) — a link would bounce them.
    renderAt("/marketing/spend", "sales");
    expect(screen.queryByRole("link", { name: "Marketing Hub" })).toBeNull();
    expect(screen.getByText("Marketing Hub").closest("a")).toBeNull();
  });

  it("gives links a visible keyboard focus ring from tokens", () => {
    renderAt("/marketing/spend");
    const link = screen.getByRole("link", { name: "Marketing Hub" });
    expect(link.className).toMatch(/focus-visible:ring-2/);
    expect(link.className).toMatch(/focus-visible:ring-amber/);
  });

  it("resolves only real, static routes (never a [id] template)", () => {
    for (const p of ["/marketing/spend", "/customers/abc/edit", "/accounting/banking/xyz", "/settings", "/quotes/Q-1"]) {
      for (const c of resolveCrumbLinks(p, getCrumb(p))) {
        if (c.href) expect(c.href).not.toMatch(/\[|\]/);
      }
    }
  });
});
