// @vitest-environment jsdom
//
// R-464 (10 Oct 2026): at 390px the floating "AI sales agent" launcher and "WhatsApp us" pill
// covered the homepage form ("Tell us what to automate"), its Name field included, and
// WhatsApp showed twice (hero button + floating pill). Rule: only ONE floating action, and it
// steps aside while a [data-avoid-floating] block is under it.
// R-1498 (17 Oct 2026): desktop too floats ONE launcher; WhatsApp lives in its menu.
// R-1495 2nd galat (24 Oct 2026): at 1000–1280px the pill covered the plan cards' buttons — the
// step-aside now works at every width, judged against the launcher's own corner.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup, screen, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { floatingLauncher, launcherZone } from "./floating";
import { AgentChat } from "@/site/components/agent/AgentChat";

const LAUNCHER = /^Talk to us/;

describe("floatingLauncher (pure rule)", () => {
  const base = { pathname: "/", avoidOnScreen: false };

  it("shows the one launcher when nothing marked is under it", () => {
    expect(floatingLauncher(base)).toBe(true);
  });

  it("steps aside while the form / plan cards are under it — any width (R-1495)", () => {
    expect(floatingLauncher({ ...base, avoidOnScreen: true })).toBe(false);
  });

  it("…but not while its menu or chat panel is open (the visitor must be able to close it)", () => {
    expect(floatingLauncher({ ...base, avoidOnScreen: true, chatOpen: true })).toBe(true);
  });

  it("nothing floats on /checkout and /done", () => {
    expect(floatingLauncher({ ...base, pathname: "/checkout" })).toBe(false);
    expect(floatingLauncher({ ...base, pathname: "/done" })).toBe(false);
  });

  it("the corner it guards is the round icon below 980px and the wider pill above", () => {
    expect(launcherZone(390)).toEqual({ width: 76, height: 76 });
    const pill = launcherZone(1000);
    expect(pill.width).toBeGreaterThanOrEqual(22 + 115 + 8);
    expect(pill.height).toBeGreaterThanOrEqual(22 + 45 + 8);
  });
});

/* ── jsdom: the real components with a fake viewport + IntersectionObserver ───────────── */

let ioCallbacks: Array<(entries: Array<{ target: Element; isIntersecting: boolean }>) => void> = [];
let observed: Element[] = [];
let margins: string[] = [];

beforeEach(() => {
  ioCallbacks = [];
  observed = [];
  margins = [];
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  class FakeIO {
    constructor(cb: (e: Array<{ target: Element; isIntersecting: boolean }>) => void, opts?: { rootMargin?: string }) {
      ioCallbacks.push(cb);
      margins.push(opts?.rootMargin ?? "");
    }
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

/** The marked block moves into (true) or out of (false) the launcher's corner. */
function blockUnderLauncher(under: boolean) {
  act(() => {
    for (const cb of ioCallbacks) cb(observed.map((target) => ({ target, isIntersecting: under })));
  });
}

describe("floating launcher on the homepage (R-464)", () => {
  it("no WhatsApp pill, and the launcher hides while the form is under it", () => {
    render(<Page />);
    expect(screen.queryByRole("link", { name: "WhatsApp us" })).toBeNull();
    expect(screen.getByRole("button", { name: LAUNCHER })).toBeTruthy();
    expect(observed.length).toBeGreaterThan(0);

    blockUnderLauncher(true);
    expect(screen.queryByRole("button", { name: LAUNCHER })).toBeNull();

    blockUnderLauncher(false);
    expect(screen.getAllByRole("button", { name: LAUNCHER })).toHaveLength(1);
  });

  it("watches only the launcher's bottom-right corner, not the whole screen (R-1495)", () => {
    render(<Page />);
    // rootMargin "-<top>px 0px 0px -<left>px": the root shrinks to the corner the launcher takes.
    const m = /^-(\d+)px 0px 0px -(\d+)px$/.exec(margins.at(-1) ?? "");
    expect(m, `rootMargin ${margins.at(-1)}`).not.toBeNull();
    const w = document.documentElement.clientWidth || window.innerWidth;
    const h = document.documentElement.clientHeight || window.innerHeight;
    const zone = launcherZone(w);
    expect(Number(m![1])).toBe(Math.max(0, h - zone.height));
    expect(Number(m![2])).toBe(Math.max(0, w - zone.width));
  });
});

/* R-1495 galat (Pawan, 17 Oct, phone): the AI launcher sat over the Workspace plan cards'
   buttons. The hook scanned for [data-avoid-floating] once per route, when the layout's
   pathname changed — a page whose content arrives after that (client navigation, streamed
   server page, a remount) was never watched, so the launcher never stepped aside. */
describe("launcher steps aside for blocks that render after it (R-1495)", () => {
  function LatePage({ show }: { show: boolean }) {
    return (
      <>
        {show && (
          <div data-avoid-floating="" className="wp-cards">
            <a href="/buy">Buy now</a>
          </div>
        )}
        <AgentChat />
      </>
    );
  }

  it("plan cards that appear after mount are still watched", async () => {
    const { rerender } = render(<LatePage show={false} />);
    expect(observed.length).toBe(0);

    rerender(<LatePage show={true} />);
    // MutationObserver callbacks are microtasks; let them (and any frame) run.
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(observed.some((el) => el.classList.contains("wp-cards"))).toBe(true);

    blockUnderLauncher(true);
    expect(screen.queryByRole("button", { name: LAUNCHER })).toBeNull();
  });
});
