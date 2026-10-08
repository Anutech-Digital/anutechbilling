// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FAB } from "./fab";

afterEach(() => cleanup());

/* R-268: the FAB was pinned at bottom-20 (80px) with its own safe-area margin — a second,
   drifting copy of the bottom-nav height — and stayed on screen on top of the bulk bar. */
describe("FAB — phone position (R-268)", () => {
  it("anchors above the shared --bottom-nav-h, not a hard-coded offset", () => {
    render(<FAB icon="plus" label="New" ariaLabel="New thing" onClick={() => {}} />);
    const wrapper = screen.getByRole("button", { name: "New thing" }).parentElement!;
    expect(wrapper.className).toContain("bottom-[calc(var(--bottom-nav-h,56px)+1rem)]");
    expect(wrapper.className).not.toContain("bottom-20");
  });

  it("hides while a bulk selection bar is open", () => {
    render(<FAB icon="plus" label="New" ariaLabel="New thing" onClick={() => {}} />);
    const wrapper = screen.getByRole("button", { name: "New thing" }).parentElement!;
    expect(wrapper.className).toContain("[body:has([data-bulk-bar])_&]:hidden");
  });
});
