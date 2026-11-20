// @vitest-environment jsdom
/* R-2936 — the Overview donut: the ring is one labelled picture; the list beside it carries
   the same numbers as text, and every line is a link into the Tasks list. */
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { OverviewDonut, type DonutSlice } from "./overview-donut";

afterEach(() => cleanup());

const slices: DonutSlice[] = [
  { id: "high", label: "High", count: 1, color: "hsl(var(--rose))", href: "/tasks?tab=all" },
  { id: "medium", label: "Medium", count: 2, color: "hsl(var(--amber))", href: "/tasks?tab=all" },
  { id: "low", label: "Low", count: 0, color: "hsl(var(--ink-3))", href: "/tasks?tab=all" },
];

describe("R-2936 OverviewDonut", () => {
  it("names every slice, its count and share in the picture's label", () => {
    render(<OverviewDonut title="Open tasks by priority" hint="h" slices={slices} />);
    expect(screen.getByRole("img").getAttribute("aria-label"))
      .toBe("Open tasks by priority: High 1 (33%), Medium 2 (67%), Low 0 (0%)");
  });

  it("lists every slice — a zero one too — as a link to the Tasks list, with its count as text", () => {
    render(<OverviewDonut title="Open tasks by priority" hint="h" slices={slices} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/tasks?tab=all", "/tasks?tab=all", "/tasks?tab=all"]);
    expect(links[0].getAttribute("aria-label")).toBe("High: 1 open task, 33% — open the Tasks list");
    expect(links[1].getAttribute("aria-label")).toBe("Medium: 2 open tasks, 67% — open the Tasks list");
    expect(within(links[1]).getByText("2")).toBeTruthy();
    expect(within(links[1]).getByText("67%")).toBeTruthy();
    expect(within(links[2]).getByText("Low")).toBeTruthy();
  });

  it("with nothing open it says so and shows 0 in the middle", () => {
    render(<OverviewDonut title="Open tasks by status" hint="h" slices={slices.map((s) => ({ ...s, count: 0 }))} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("Open tasks by status: no open tasks");
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });
});
