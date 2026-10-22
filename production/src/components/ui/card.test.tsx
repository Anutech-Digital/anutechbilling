// @vitest-environment jsdom
//
// R-1741 — Card flush keeps its horizontal-scroll wrapper for every existing user; only the
// new flush="clip" (used by DataTable so its sticky header works) swaps it for overflow-x-clip,
// which clips like before but is not a scroll container.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { Card } from "./card";

afterEach(cleanup);

describe("Card flush wrapper (R-1741)", () => {
  it("flush (default) still wraps children in the overflow-x-auto scroller", () => {
    render(<Card flush><table><tbody><tr><td>x</td></tr></tbody></table></Card>);
    const wrap = screen.getByRole("table").parentElement!;
    expect(wrap.className.split(/\s+/)).toEqual(expect.arrayContaining(["overflow-x-auto", "relative"]));
  });

  it('flush="clip" uses overflow-x-clip (no scroll container) and keeps relative', () => {
    render(<Card flush="clip"><table><tbody><tr><td>x</td></tr></tbody></table></Card>);
    const cls = screen.getByRole("table").parentElement!.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["overflow-x-clip", "relative"]));
    expect(cls).not.toContain("overflow-x-auto");
  });

  it("no flush: padded body as before", () => {
    render(<Card><span>body</span></Card>);
    expect(screen.getByText("body").parentElement!.className).toBe("p-4");
  });
});
