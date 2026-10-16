// @vitest-environment jsdom
/**
 * R-1410 — the active tab must be obvious at a glance (Pawan, staging /settings, 12 Oct 2026).
 * Before: active and inactive tabs were both font-medium, and the 2px amber underline sat 1px
 * into the row's border while the row had overflow-y-hidden, so half the underline was clipped.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TabBar } from "./tabs";

const ITEMS = [
  { id: "company", label: "Company" },
  { id: "integrations", label: "Integrations" },
  { id: "security", label: "Security" },
];

beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
});
afterEach(() => { cleanup(); });

function classesOf(name: string): string[] {
  return screen.getByRole("tab", { name }).className.split(/\s+/);
}

describe("TabBar active tab", () => {
  it("marks only the active tab aria-selected", () => {
    render(<TabBar value="integrations" onChange={() => {}} items={ITEMS} />);
    expect(screen.getByRole("tab", { name: "Integrations" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Company" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "Security" }).getAttribute("aria-selected")).toBe("false");
  });

  it("gives the active tab bolder ink text and an amber underline; inactive tabs get neither", () => {
    render(<TabBar value="integrations" onChange={() => {}} items={ITEMS} />);
    const active = classesOf("Integrations");
    expect(active).toEqual(expect.arrayContaining(["font-semibold", "text-ink", "border-amber"]));
    expect(active).not.toContain("font-medium");
    for (const name of ["Company", "Security"]) {
      const c = classesOf(name);
      expect(c).toEqual(expect.arrayContaining(["font-medium", "text-ink-3", "border-transparent"]));
      expect(c).not.toContain("font-semibold");
      expect(c).not.toContain("border-amber");
    }
  });

  it("does not pull the underline into the clipped row border", () => {
    render(<TabBar value="company" onChange={() => {}} items={ITEMS} />);
    expect(screen.getByRole("tablist").className).toContain("overflow-y-hidden");
    for (const name of ["Company", "Integrations", "Security"]) {
      expect(classesOf(name)).not.toContain("-mb-px");
    }
  });
});
