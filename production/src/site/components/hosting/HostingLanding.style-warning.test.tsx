// @vitest-environment jsdom
//
// R-1460 (16 Oct 2026, Pawan via staging AI Help): the hosting page logged a React
// style warning. The page first renders at a desktop width, measures the window,
// then re-renders for a phone. The plan-cards row swapped a desktop style
// `{ marginTop }` for a phone style `{ margin, padding }`, so React warned about a
// shorthand and a longhand of the same property changing on one element. Every
// re-render between widths must keep the same property names.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fonts", () => ({
  hostingSans: { variable: "hf-sans" },
  hostingSerif: { variable: "hf-serif" },
  hostingMono: { variable: "hf-mono" },
}));
vi.mock("@/site/components/cart/CartProvider", () => ({
  useCart: () => ({ lines: [], add: vi.fn(), remove: vi.fn(), closeDrawer: vi.fn() }),
}));

import { HostingLanding } from "./HostingLanding";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: px });
}

function styleWarnings(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .map((args: unknown[]) => args.map(String).join(" "))
    .filter((m: string) => /style property during rerender|conflicting property/i.test(m));
}

describe("Hosting page — no React style warning when the width changes (R-1460)", () => {
  it("phone width after the first measure: no shorthand/longhand warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setWidth(375);
    render(<HostingLanding />);
    expect(styleWarnings(spy)).toEqual([]);
  });

  it("resizing phone → desktop → phone: no shorthand/longhand warning", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    setWidth(375);
    render(<HostingLanding />);
    for (const px of [1280, 375, 900, 375]) {
      act(() => {
        setWidth(px);
        window.dispatchEvent(new Event("resize"));
      });
    }
    expect(styleWarnings(spy)).toEqual([]);
  });
});
