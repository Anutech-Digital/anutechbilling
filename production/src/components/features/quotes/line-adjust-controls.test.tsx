// @vitest-environment jsdom
//
// R-1674 (owner, 19 Oct 2026): the quote builder no longer offers "Customer can ☐ change
// seats" on a line, and a duplicated quote does not inherit seats_adjustable from its source.
//
// R-1754 (owner, 22 Oct 2026): "Customer can ☐ add / remove this" no longer sits on EVERY
// line; it lives in the line's ⋯ menu ("Make optional for customer").
//
// R-1755 (owner, 22 Oct 2026): no big chip in the description column — an optional line shows
// a one-word "Optional" tag after its name; "Starts ticked for the customer" and "Make required"
// are in the ⋯ menu. A plan / seat line can be optional (a second plan as an extra), but only
// after a warning; an add-on / one-time line needs none. Data and Accept page unchanged.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { LineMoreMenu, OptionalTag, dropSeatsAdjustable } from "./line-adjust-controls";

/* The app-wide confirm dialog (a Radix Dialog) opened from a Radix menu item makes jsdom's
   focus scopes recurse forever, so the test stands in for useConfirm and checks what it is
   asked and what happens on each answer. The real dialog is checked on localhost. */
const confirmMock = vi.fn<(o: { title: string; body?: string; confirmLabel?: string }) => Promise<boolean>>();
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => confirmMock }));

const line = (over: Partial<QuoteLineItem> = {}): QuoteLineItem =>
  ({ id: "l1", name: "Google Workspace Business Starter", description: "Google Workspace", qty: 5, rate: 100, ...over }) as QuoteLineItem;

afterEach(() => { cleanup(); confirmMock.mockReset(); });

const openMenu = () => fireEvent.keyDown(screen.getByRole("button", { name: /more options/i }), { key: "Enter" });
const renderMenu = (ui: React.ReactElement) => render(ui);

describe("OptionalTag (R-1755 owner examples)", () => {
  it("Google Workspace Starter × 10 (required): no tag, nothing at all", () => {
    const { container } = render(<OptionalTag line={line({ qty: 10 })} />);
    expect(container.textContent).toBe("");
  });

  it("Support Charges, optional: one small word 'Optional' — no chip text, no Ticked / Unticked", () => {
    const { container } = render(<OptionalTag line={line({ name: "Support Charges", optional: true })} />);
    expect(container.textContent).toBe("Optional");
    expect(screen.queryByText(/customer can remove/i)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("LineMoreMenu (R-1754 / R-1755)", () => {
  it("Support Charges (one-time) → ⋯ → Make optional: no question, starts unticked", () => {
    const onChange = vi.fn();
    renderMenu(<LineMoreMenu line={line({ name: "Support Charges", one_time: true })} onChange={onChange} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /make optional for customer/i }));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith({ optional: true, included_by_default: false });
    expect(onChange.mock.calls[0][0]).not.toHaveProperty("seats_adjustable");
  });

  it("Google Workspace Starter × 10 → ⋯ → Make optional: warning first; Cancel keeps it required", async () => {
    const onChange = vi.fn();
    confirmMock.mockResolvedValue(false);   // owner presses Cancel
    renderMenu(<LineMoreMenu line={line({ qty: 10, commitment: "annual_yearly" })} onChange={onChange} confirmOptional />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /make optional for customer/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      body: "The customer can remove these seats. Use this only for an extra plan they may or may not take.",
      confirmLabel: "Make optional",
      cancelLabel: "Cancel",
    });
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a second plan (Standard × 5) → warning → Make optional: it becomes optional", async () => {
    const onChange = vi.fn();
    confirmMock.mockResolvedValue(true);    // owner presses Make optional
    renderMenu(<LineMoreMenu line={line({ name: "Google Workspace Business Standard", commitment: "annual_yearly" })} onChange={onChange} confirmOptional />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /make optional for customer/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ optional: true, included_by_default: false }));
  });

  it("optional line: 'Starts ticked for the customer' is a checkable menu item", () => {
    const onChange = vi.fn();
    const { rerender } = renderMenu(<LineMoreMenu line={line({ optional: true })} onChange={onChange} />);
    openMenu();
    const item = screen.getByRole("menuitemcheckbox", { name: /starts ticked for the customer/i });
    expect(item.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(item);
    expect(onChange).toHaveBeenLastCalledWith({ included_by_default: true });
    rerender(<LineMoreMenu line={line({ optional: true, included_by_default: true })} onChange={onChange} />);
    openMenu();
    const on = screen.getByRole("menuitemcheckbox", { name: /starts ticked for the customer/i });
    expect(on.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(on);
    expect(onChange).toHaveBeenLastCalledWith({ included_by_default: undefined });
  });

  it("optional line: 'Make required' clears optional and its default; no 'Make optional'", () => {
    const onChange = vi.fn();
    renderMenu(<LineMoreMenu line={line({ optional: true, included_by_default: true })} onChange={onChange} />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /make optional/i })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /make required/i }));
    expect(onChange).toHaveBeenCalledWith({ optional: undefined, included_by_default: undefined });
  });

  it("has no 'change seats' option, even on a line that already carries the flag (R-1674)", () => {
    renderMenu(<LineMoreMenu line={line({ optional: true, seats_adjustable: true })} onChange={() => {}} />);
    openMenu();
    expect(screen.queryByText(/change seats/i)).toBeNull();
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

describe("quote builder uses these controls (R-1674 / R-1754 / R-1755 guard)", () => {
  it("quote-builder.tsx: ⋯ menu + 'Optional' tag on both layouts, no big chip, seat lines ask first", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "quote-builder.tsx"), "utf8");
    expect(src).toMatch(/from "\.\/line-adjust-controls"/);
    expect(src).not.toMatch(/change seats/i);
    expect(src).not.toMatch(/add \/ remove this/i);
    expect(src).not.toMatch(/seats_adjustable\s*:\s*(true|e\.target)/);
    expect(src).not.toMatch(/<LineAdjustControls\b/);
    expect(src).not.toMatch(/customer can remove/i);
    // Phone cards + desktop table: one ⋯ menu (asking on seat lines) and one tag per layout.
    expect(src.match(/<LineMoreMenu\b/g)?.length).toBe(2);
    expect(src.match(/<LineMoreMenu\b[^>]*confirmOptional=\{optionalNeedsConfirm\(/g)?.length).toBe(2);
    expect(src.match(/<OptionalTag\b/g)?.length).toBe(2);
    // The tag sits in the name line, right after {line.name}.
    expect(src.match(/\{line\.name\}<OptionalTag line=\{line\} \/>/g)?.length).toBe(2);
  });
});
