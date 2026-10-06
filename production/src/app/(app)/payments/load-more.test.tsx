// @vitest-environment jsdom
//
// R-104 — the Payments list paints 50 at a time (R-024 rule); totals stay over every row.
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { usePagedRows, LoadMore } from "./load-more";

type Pay = { id: string; amount: number };
const all: Pay[] = Array.from({ length: 120 }, (_, i) => ({ id: `PAY-${i + 1}`, amount: 1000 }));

afterEach(cleanup);

function List({ rows, filterKey }: { rows: Pay[]; filterKey: string }) {
  const paged = usePagedRows(rows, 50, filterKey);
  const total = rows.reduce((s, p) => s + p.amount, 0);   // like the page's KPIs: the whole list
  return (
    <div>
      <p data-testid="total">{total}</p>
      <ul>{paged.shown.map((p) => <li key={p.id}>{p.id}</li>)}</ul>
      <LoadMore hidden={paged.hidden} pageSize={50} noun="payments" onLoadMore={paged.loadMore} />
    </div>
  );
}

describe("Payments paging (R-104)", () => {
  it("paints 50 of 120, then 50 more, then the last 20", () => {
    render(<List rows={all} filterKey="" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getByText("70 more payments below")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "Load 20 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(120);
    expect(screen.queryByRole("button", { name: /Load .* more/ })).toBeNull();
  });

  it("totals are over the whole list, not the painted page", () => {
    render(<List rows={all} filterKey="" />);
    expect(screen.getByTestId("total").textContent).toBe("120000");
  });

  it("a new filter starts again at one page", () => {
    const { rerender } = render(<List rows={all} filterKey="tab=all" />);
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(100);
    rerender(<List rows={all.slice(0, 90)} filterKey="tab=received" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
  });

  it("a short list shows everything and no button", () => {
    render(<List rows={all.slice(0, 12)} filterKey="" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(12);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
