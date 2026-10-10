// @vitest-environment jsdom
//
// R-464 (10 Oct 2026): at 390px the floating "AI sales agent" launcher and "WhatsApp us" pill
// covered the homepage form ("Tell us what to automate"), its Name field included, and
// WhatsApp showed twice (hero button + floating pill). Rule: below 980px only ONE floating
// action (the AI launcher), and it steps aside while a [data-avoid-floating] block is on
// screen. Desktop unchanged.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { floatingButtons } from "./floating";
import { WhatsAppButton } from "./Chrome";
import { AgentChat } from "@/site/components/agent/AgentChat";

describe("floatingButtons (pure rule)", () => {
  const base = { pathname: "/", isMobile: false, avoidOnScreen: false, whatsappReady: true };

  it("desktop keeps both floating buttons, form or not", () => {
    expect(floatingButtons(base)).toEqual({ agent: true, whatsapp: true });
    expect(floatingButtons({ ...base, avoidOnScreen: true })).toEqual({ agent: true, whatsapp: true });
  });

  it("desktop without the real WhatsApp number shows only the agent", () => {
    expect(floatingButtons({ ...base, whatsappReady: false })).toEqual({ agent: true, whatsapp: false });
  });

  it("a phone floats ONE action — never the WhatsApp pill", () => {
    expect(floatingButtons({ ...base, isMobile: true })).toEqual({ agent: true, whatsapp: false });
  });

  it("on a phone the launcher steps aside while the form is on screen", () => {
    expect(floatingButtons({ ...base, isMobile: true, avoidOnScreen: true })).toEqual({ agent: false, whatsapp: false });
  });

  it("…but not while its chat panel is open (the visitor must be able to close it)", () => {
    expect(floatingButtons({ ...base, isMobile: true, avoidOnScreen: true, chatOpen: true }).agent).toBe(true);
  });

  it("nothing floats on /checkout and /done, any width", () => {
    for (const isMobile of [true, false]) {
      expect(floatingButtons({ ...base, isMobile, pathname: "/checkout" })).toEqual({ agent: false, whatsapp: false });
      expect(floatingButtons({ ...base, isMobile, pathname: "/done" })).toEqual({ agent: false, whatsapp: false });
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
      <WhatsAppButton />
      <AgentChat />
    </>
  );
}

function formScrolls(onScreen: boolean) {
  act(() => {
    for (const cb of ioCallbacks) cb(observed.map((target) => ({ target, isIntersecting: onScreen })));
  });
}

describe("floating buttons on the homepage (R-464)", () => {
  it("390px: no WhatsApp pill, and the AI launcher hides while the form is on screen", () => {
    setViewport(true);
    render(<Page />);
    expect(screen.queryByRole("link", { name: "WhatsApp us" })).toBeNull();
    expect(screen.getByRole("button", { name: "Talk to our live AI sales agent" })).toBeTruthy();
    expect(observed.length).toBeGreaterThan(0);

    formScrolls(true);
    expect(screen.queryByRole("button", { name: "Talk to our live AI sales agent" })).toBeNull();

    formScrolls(false);
    expect(screen.getByRole("button", { name: "Talk to our live AI sales agent" })).toBeTruthy();
  });

  it("desktop: both buttons stay, form on screen or not", () => {
    setViewport(false);
    render(<Page />);
    formScrolls(true);
    expect(screen.getAllByRole("link", { name: "WhatsApp us" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Talk to our live AI sales agent" })).toBeTruthy();
  });
});
