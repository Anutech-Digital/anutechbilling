/**
 * R-1836 (24 Oct 2026) — the local smoke check went red on /customers/<id> and /accounting/pnl
 * with "A tree hydrated but some attributes of the server rendered HTML didn't match".
 *
 * The differing attribute was the Radix `id` on the shell's dropdown triggers (sidebar account
 * menu, Demo data, More) — React useId values, not a date. A useId probe showed the split was
 * already at the (app) layout itself, below <Providers>: Next's dev-only segment explorer wraps
 * each segment in SegmentViewNode, and on a cold turbopack load the browser often hydrated
 * without one of them. With `experimental.devtoolSegmentExplorer: false`: 0 of 6 cold pages
 * red; with it on: 4 of 6 (same server, same code). This keeps it off.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — next.config.mjs is plain JS with no type declarations.
import nextConfig from "../next.config.mjs";

describe("R-1836: Next dev segment explorer stays off", () => {
  it("experimental.devtoolSegmentExplorer is false (it breaks hydration of the shell's useIds in dev)", () => {
    const experimental = (nextConfig as { experimental?: Record<string, unknown> }).experimental ?? {};
    expect(experimental.devtoolSegmentExplorer).toBe(false);
  });
});
