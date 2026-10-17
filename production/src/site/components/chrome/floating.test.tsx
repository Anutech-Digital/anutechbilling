// @vitest-environment jsdom
//
// R-464 (10 Oct 2026): at 390px the floating "AI sales agent" launcher and "WhatsApp us" pill
// covered the homepage form ("Tell us what to automate"), its Name field included, and
// WhatsApp showed twice (hero button + floating pill). Rule: below 980px only ONE floating
// action, and it steps aside while a [data-avoid-floating] block is on screen.
// R-1498 (17 Oct 2026): desktop too floats ONE launcher; WhatsApp lives in its menu.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { floatingLauncher } from "./floating";
import { AgentChat } from "@/site/components/agent/AgentChat";

const LAUNCHER = /^Talk to us/;

describe("floatingLauncher (pure rule)", () => {
  const base = { pathname: "/", isMobile: false, avoidOnScreen: false };

  it("desktop always shows the one launcher, form or not", () => {
    expect(floatingLauncher(base)).toBe(true);
    expect(floatingLauncher({ ...base, avoidOnScreen: true })).toBe(true);
  });

  it("a phone shows it too", () => {
    expect(floatingLauncher({ ...base, isMobile: true })).toBe(true);
  });

  it("on a phone the launcher steps aside while the form is on screen", () => {
    expect(floatingLauncher({ ...base, isMobile: true, avoidOnScreen: true })).toBe(false);
  });

  it("…but not while its menu or chat panel is open (the visitor must be able to close it)", () => {
    expect(floatingLauncher({ ...base, isMobile: true, avoidOnScreen: true, chatOpen: true })).toBe(true);
  });

  it("nothing floats on /checkout and /done, any width", () => {
    for (const isMobile of [true, false]) {
      expect(floatingLauncher({ ...base, isMobile, pathname: "/checkout" })).toBe(false);
      expect(floatingLauncher({ ...base, isMobile, pathname: "/done" })).toBe(false);
    }
  });
});

/* ── jsdom: the real components with a fake viewport + IntersectionObserver ───────────── */

let ioCallbacks: Array<(entries: Array<{ target: Element; isIntersecting: boolean }>) => void> = [];
let observed: Element[] = [];

function setViewport(mobile: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: mobile && q.includes("max-width: 979px"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  ioCallbacks = [];
  observed = [];
  class FakeIO {
    constructor(cb: (e: Array<{ target: Element; isIntersecting: boolean }>) => void) { ioCallbacks.push(cb); }
    observe(el: Element) { observed.push(el); }
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

function Page() {
  return (
    <>
      <div data-avoid-floating="">
        <form aria-label="Tell us what to automate"><input aria-label="Name" /></form>
      </div>
      <AgentChat />
    </>
  );
}

function formScrolls(onScreen: boolean) {
  act(() => {
    for (const cb of ioCallbacks) cb(observed.map((target) => ({ target, isIntersecting: onScreen })));
  });
}

describe("floating launcher on the homepage (R-464)", () => {
  it("390px: no WhatsApp pill, and the launcher hides while the form is on screen", () => {
    setViewport(true);
    render(<Page />);
    expect(screen.queryByRole("link", { name: "WhatsApp us" })).toBeNull();
    expect(screen.getByRole("button", { name: LAUNCHER })).toBeTruthy();
    expect(observed.length).toBeGreaterThan(0);

    formScrolls(true);
    expect(screen.queryByRole("button", { name: LAUNCHER })).toBeNull();

    formScrolls(false);
    expect(screen.getByRole("button", { name: LAUNCHER })).toBeTruthy();
  });

  it("desktop: the one launcher stays, form on screen or not, and no floating WhatsApp pill", () => {
    setViewport(false);
    render(<Page />);
    formScrolls(true);
    expect(screen.queryByRole("link", { name: "WhatsApp us" })).toBeNull();
    expect(screen.getAllByRole("button", { name: LAUNCHER })).toHaveLength(1);
  });
});
