// @vitest-environment jsdom
//
// R-1674 (owner, 19 Oct 2026): the quote builder no longer offers "Customer can ☐ change
// seats" on a line. "add / remove this" and its "ticked to start" stay exactly as before,
// and a duplicated quote does not inherit seats_adjustable from its source.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { LineAdjustControls, dropSeatsAdjustable } from "./line-adjust-controls";

const line = (over: Partial<QuoteLineItem> = {}): QuoteLineItem =>
  ({ id: "l1", description: "Google Workspace", qty: 5, rate: 100, ...over }) as QuoteLineItem;

afterEach(cleanup);

describe("LineAdjustControls (R-1674)", () => {
  it("has no 'change seats' option, even on a line that already carries the flag", () => {
    render(<LineAdjustControls line={line({ seats_adjustable: true })} onChange={() => {}} />);
    expect(screen.queryByText(/change seats/i)).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("still offers 'add / remove this', and ticking it sets optional", () => {
    const onChange = vi.fn();
    render(<LineAdjustControls line={line()} onChange={onChange} />);
    expect(screen.getByText("add / remove this")).toBeTruthy();
    expect(screen.queryByText("ticked to start")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith({ optional: true, included_by_default: false });
    expect(onChange.mock.calls[0][0]).not.toHaveProperty("seats_adjustable");
  });

  it("an optional line still shows 'ticked to start'", () => {
    const onChange = vi.fn();
    render(<LineAdjustControls line={line({ optional: true })} onChange={onChange} />);
    expect(screen.getByText("ticked to start")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(onChange).toHaveBeenCalledWith({ included_by_default: true });
  });

  it("un-ticking 'add / remove this' clears the default too", () => {
    const onChange = vi.fn();
    render(<LineAdjustControls line={line({ optional: true, included_by_default: true })} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(onChange).toHaveBeenCalledWith({ optional: undefined, included_by_default: undefined });
  });
});

describe("dropSeatsAdjustable (duplicate / revise)", () => {
  it("drops seats_adjustable and its bounds, keeps everything else", () => {
    const out = dropSeatsAdjustable(line({ seats_adjustable: true, min_seats: 2, max_seats: 9, optional: true }));
    expect(out).not.toHaveProperty("seats_adjustable");
    expect(out).not.toHaveProperty("min_seats");
    expect(out).not.toHaveProperty("max_seats");
    expect(out).toMatchObject({ id: "l1", qty: 5, rate: 100, optional: true });
  });
});

describe("quote builder uses these controls (R-1674 guard)", () => {
  it("quote-builder.tsx renders no 'change seats' option of its own and never sets seats_adjustable: true", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "quote-builder.tsx"), "utf8");
    expect(src).toMatch(/from "\.\/line-adjust-controls"/);
    expect(src).not.toMatch(/change seats/i);
    expect(src).not.toMatch(/seats_adjustable\s*:\s*(true|e\.target)/);
  });
});
