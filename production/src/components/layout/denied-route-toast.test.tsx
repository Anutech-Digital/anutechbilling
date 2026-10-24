// @vitest-environment jsdom
/**
 * R-1810 — arriving with ?denied=<path> shows "You don't have access to <page>. Ask the owner
 * for access." with a Dismiss button, once, and the param is taken off the URL.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const nav = vi.hoisted(() => ({ search: "denied=%2Faccounting%2Fbalance-sheet&tab=open", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/invoices",
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
}));
const info = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info, dismiss: vi.fn() } }));

import { DeniedRouteToast, deniedMessage, deniedPageName } from "./denied-route-toast";

afterEach(() => { cleanup(); info.mockReset(); nav.replace.mockReset(); });

describe("R-1810 — denied-route toast", () => {
  it("names the refused page from the menu", () => {
    expect(deniedMessage("/accounting/balance-sheet")).toBe(
      "You don't have access to Balance Sheet. Ask the owner for access.",
    );
  });

  it("an unknown or odd path says 'that page', never a wrong page name", () => {
    expect(deniedPageName("/no-such-screen")).toBe("that page");
    expect(deniedPageName("//evil.example")).toBe("that page");
    expect(deniedPageName("javascript:alert(1)")).toBe("that page");
  });

  it("on arrival: one toast with a Dismiss button, and the param leaves the URL (others kept)", () => {
    nav.search = "denied=%2Faccounting%2Fbalance-sheet&tab=open";
    render(<DeniedRouteToast />);
    expect(info).toHaveBeenCalledTimes(1);
    const [msg, opts] = info.mock.calls[0];
    expect(msg).toBe("You don't have access to Balance Sheet. Ask the owner for access.");
    expect(opts.cancel.label).toBe("Dismiss");
    expect(nav.replace).toHaveBeenCalledWith("/invoices?tab=open", { scroll: false });
  });

  it("no denied param → nothing shown, URL untouched", () => {
    nav.search = "tab=open";
    render(<DeniedRouteToast />);
    expect(info).not.toHaveBeenCalled();
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
