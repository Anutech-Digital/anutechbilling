// @vitest-environment jsdom
//
// R-105 — the Quotes list paints 50 at a time (R-024 rule); totals stay over every quote.
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { usePagedRows, LoadMore } from "../payments/load-more";
import { QUOTES_PAGE_SIZE, quotesPagingKey } from "./paging";

type Q = { id: string; amount: number; is_renewal: boolean };
const all: Q[] = Array.from({ length: 130 }, (_, i) => ({ id: `Q-${i + 1}`, amount: 2000, is_renewal: i % 2 === 0 }));
const base = { tab: "all", focus: "", search: "", teamMode: "team", onlyMyApprovals: false };

afterEach(cleanup);

function List({ rows, k }: { rows: Q[]; k: string }) {
  const paged = usePagedRows(rows, QUOTES_PAGE_SIZE, k);
  // like the page footer: pipeline value + renewals over the whole filtered list
  const pipeline = rows.reduce((s, q) => s + q.amount, 0);
  const renewals = rows.filter((q) => q.is_renewal).length;
  return (
    <div>
      <p data-testid="pipeline">{pipeline}</p>
      <p data-testid="renewals">{renewals}</p>
      <ul>{paged.shown.map((q) => <li key={q.id}>{q.id}</li>)}</ul>
      <LoadMore hidden={paged.hidden} pageSize={QUOTES_PAGE_SIZE} noun="quotes" onLoadMore={paged.loadMore} />
    </div>
  );
}

describe("Quotes paging (R-105)", () => {
  it("page size is 50", () => {
    expect(QUOTES_PAGE_SIZE).toBe(50);
  });

  it("paints 50 of 130, then 50 more, then the last 30", () => {
    render(<List rows={all} k={quotesPagingKey(base)} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    expect(screen.getByText("80 more quotes below")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "Load 30 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(130);
    expect(screen.queryByRole("button", { name: /Load .* more/ })).toBeNull();
  });

  it("pipeline value and renewals are over the whole list, not the painted page", () => {
    render(<List rows={all} k={quotesPagingKey(base)} />);
    expect(screen.getByTestId("pipeline").textContent).toBe("260000");
    expect(screen.getByTestId("renewals").textContent).toBe("65");
  });

  it("a new tab starts again at one page", () => {
    const { rerender } = render(<List rows={all} k={quotesPagingKey(base)} />);
    fireEvent.click(screen.getByRole("button", { name: "Load 50 more" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(100);
    rerender(<List rows={all.slice(0, 110)} k={quotesPagingKey({ ...base, tab: "sent" })} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
  });

  it("every list-changing filter changes the key; search case/spaces do not", () => {
    const k = quotesPagingKey(base);
    expect(quotesPagingKey({ ...base, focus: "review" })).not.toBe(k);
    expect(quotesPagingKey({ ...base, search: "acme" })).not.toBe(k);
    expect(quotesPagingKey({ ...base, teamMode: "mine" })).not.toBe(k);
    expect(quotesPagingKey({ ...base, onlyMyApprovals: true })).not.toBe(k);
    expect(quotesPagingKey({ ...base, search: " Acme " })).toBe(quotesPagingKey({ ...base, search: "acme" }));
  });

  it("a short list shows everything and no button", () => {
    render(<List rows={all.slice(0, 14)} k={quotesPagingKey(base)} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(14);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
