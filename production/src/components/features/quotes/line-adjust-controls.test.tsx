// @vitest-environment jsdom
//
// R-1674 (owner, 19 Oct 2026): the quote builder no longer offers "Customer can ☐ change
// seats" on a line, and a duplicated quote does not inherit seats_adjustable from its source.
//
// R-1754 (owner, 22 Oct 2026): "Customer can ☐ add / remove this" no longer sits on EVERY
// line. Most lines are required; the box was noise, and a stray tick let the customer drop a
// required line and pay less. It moved into the line's ⋯ menu ("Make optional for customer");
// an optional line shows a chip "Optional · customer can remove" with its "Starts ticked /
// unticked" choice. Data (optional, included_by_default) and the public Accept page are unchanged.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { LineAdjustControls, LineMoreMenu, dropSeatsAdjustable } from "./line-adjust-controls";

const line = (over: Partial<QuoteLineItem> = {}): QuoteLineItem =>
  ({ id: "l1", name: "Google Workspace Business Starter", description: "Google Workspace", qty: 5, rate: 100, ...over }) as QuoteLineItem;

afterEach(cleanup);

const openMenu = () => fireEvent.keyDown(screen.getByRole("button", { name: /more options/i }), { key: "Enter" });

describe("LineAdjustControls (R-1754 owner examples)", () => {
  it("Workspace line (required): no optional box, no 'Customer can', nothing at all", () => {
    const { container } = render(<LineAdjustControls line={line()} onChange={() => {}} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(/customer can/i)).toBeNull();
    expect(screen.queryByText(/add \/ remove this/i)).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("a quote that already has an optional line opens with the chip and the starts choice", () => {
    render(<LineAdjustControls line={line({ name: "Google Drive Storage", optional: true })} onChange={() => {}} />);
    expect(screen.getByText("Optional · customer can remove")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unticked" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Ticked" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("'Starts ticked' sets included_by_default; 'Unticked' clears it", () => {
    const onChange = vi.fn();
    const { rerender } = render(<LineAdjustControls line={line({ optional: true })} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Ticked" }));
    expect(onChange).toHaveBeenLastCalledWith({ included_by_default: true });
    rerender(<LineAdjustControls line={line({ optional: true, included_by_default: true })} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Ticked" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Unticked" }));
    expect(onChange).toHaveBeenLastCalledWith({ included_by_default: undefined });
  });

  it("has no 'change seats' option, even on a line that already carries the flag (R-1674)", () => {
    render(<LineAdjustControls line={line({ optional: true, seats_adjustable: true })} onChange={() => {}} />);
    expect(screen.queryByText(/change seats/i)).toBeNull();
  });
});

describe("LineMoreMenu (R-1754)", () => {
  it("Drive Storage line → ⋯ → 'Make optional for customer' sets optional, starts unticked", () => {
    const onChange = vi.fn();
    render(<LineMoreMenu line={line({ name: "Google Drive Storage" })} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "More options for Google Drive Storage" })).toBeTruthy();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /make optional for customer/i }));
    expect(onChange).toHaveBeenCalledWith({ optional: true, included_by_default: false });
    expect(onChange.mock.calls[0][0]).not.toHaveProperty("seats_adjustable");
  });

  it("on an optional line the menu offers 'Make required', which clears the default too", () => {
    const onChange = vi.fn();
    render(<LineMoreMenu line={line({ optional: true, included_by_default: true })} onChange={onChange} />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /make optional/i })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /make required/i }));
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

describe("quote builder uses these controls (R-1674 / R-1754 guard)", () => {
  it("quote-builder.tsx renders no 'change seats' / 'add / remove this' of its own, and has the ⋯ menu on both layouts", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "quote-builder.tsx"), "utf8");
    expect(src).toMatch(/from "\.\/line-adjust-controls"/);
    expect(src).not.toMatch(/change seats/i);
    expect(src).not.toMatch(/add \/ remove this/i);
    expect(src).not.toMatch(/seats_adjustable\s*:\s*(true|e\.target)/);
    // Phone cards + desktop table: one ⋯ menu and one chip slot per layout.
    expect(src.match(/<LineMoreMenu\b/g)?.length).toBe(2);
    expect(src.match(/<LineAdjustControls\b/g)?.length).toBe(2);
    // On phones the chip must not be folded inside the "More · starts …" <details>.
    const phone = src.slice(src.indexOf('<div className="md:hidden divide-y'), src.indexOf("{/* Desktop / tablet table */}"));
    const detailsBody = phone.slice(phone.indexOf("<details"), phone.indexOf("</details>"));
    expect(detailsBody).not.toMatch(/<LineAdjustControls\b/);
  });
});
