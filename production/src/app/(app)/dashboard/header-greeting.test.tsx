// @vitest-environment jsdom
/**
 * R-1472 — the dashboard header showed "Monday, 12 October 2026" on Friday 16 October.
 *
 * /dashboard is a "use client" page with no request-time data, so `next build` prerenders it
 * to static HTML once — with the BUILD day's date in it. The date line carried
 * suppressHydrationWarning, and React keeps the server text on a suppressed mismatch, so the
 * browser showed the build day until the next deploy. This test does exactly that: render the
 * HTML on "build day", hydrate it days later, and expect today's IST date on screen.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DashboardGreeting } from "./header-greeting";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

/** Server HTML made at `buildAt`, hydrated in the browser at `openAt`. */
async function buildThenOpen(buildAt: string, openAt: string, firstName: string | null = "Pawan") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(buildAt));
  const html = renderToString(<DashboardGreeting firstName={firstName} />);
  vi.setSystemTime(new Date(openAt));
  host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  const errors: unknown[] = [];
  await act(async () => {
    root = hydrateRoot(host!, <DashboardGreeting firstName={firstName} />, {
      onRecoverableError: (e) => errors.push(e),
    });
  });
  return { text: host.textContent ?? "", errors };
}

describe("DashboardGreeting (R-1472)", () => {
  it("shows today's IST date, not the date the page was built", async () => {
    // Built Monday 12 Oct 10:00 IST, opened Friday 16 Oct 11:00 IST.
    const { text, errors } = await buildThenOpen("2026-10-12T04:30:00Z", "2026-10-16T05:30:00Z");
    expect(text).toContain("Friday");
    expect(text).toContain("16 October 2026");
    expect(text).not.toContain("Monday");
    expect(text).not.toContain("12 October");
    expect(errors).toEqual([]);
  });

  it("uses the IST day, not UTC — 00:30 IST on the 17th is already the 17th", async () => {
    // 2026-10-16T19:00Z = Saturday 17 Oct 00:30 IST.
    const { text } = await buildThenOpen("2026-10-12T04:30:00Z", "2026-10-16T19:00:00Z");
    expect(text).toContain("Saturday");
    expect(text).toContain("17 October 2026");
  });

  it("greets by the IST hour at open time, not build time", async () => {
    // Built 10:00 IST (morning), opened 19:00 IST (evening).
    const { text } = await buildThenOpen("2026-10-12T04:30:00Z", "2026-10-16T13:30:00Z", "Pawan");
    expect(text).toContain("Good evening, Pawan.");
    expect(text).not.toContain("Good morning");
  });
});
