// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { DashCardBody, loadView, kpiTileState, countText, STILL_LOADING_TEXT, STILL_LOADING_MS } from "./card-load-state";

/* R-2239 (Zoho Billing B1): empty text only when the query resolved empty. */
afterEach(() => { cleanup(); vi.useRealTimers(); });

const EMPTY = "No subscriptions renewing in 30 days";
function body(queries: Parameters<typeof DashCardBody>[0]["queries"], isEmpty: boolean) {
  return (
    <DashCardBody queries={queries} what="Renewals" isEmpty={isEmpty} empty={<p>{EMPTY}</p>}>
      <p>61 subs</p>
    </DashCardBody>
  );
}

describe("loadView (R-2239)", () => {
  it("loading until every query has data", () => {
    expect(loadView({ data: undefined })).toBe("loading");
    expect(loadView({ data: [] }, { data: undefined })).toBe("loading");
  });
  it("error when a query failed with nothing to show — error wins over loading", () => {
    expect(loadView({ data: undefined, isError: true }, { data: undefined })).toBe("error");
  });
  it("ready when all resolved, also with an empty list", () => {
    expect(loadView({ data: [] }, { data: { n: 0 } })).toBe("ready");
  });
  it("a failed refetch that kept its data stays ready", () => {
    expect(loadView({ data: [1], isError: true })).toBe("ready");
  });
});

describe("kpiTileState / countText (R-2239)", () => {
  it("KPI: shimmer, then Still loading…, error says so, ready keeps its trend", () => {
    expect(kpiTileState("loading", "No subs yet", false)).toEqual({ loading: true, trend: "No subs yet" });
    expect(kpiTileState("loading", "No subs yet", true)).toEqual({ loading: false, trend: STILL_LOADING_TEXT });
    expect(kpiTileState("error", "No subs yet", false)).toEqual({ loading: false, trend: "Didn't load" });
    expect(kpiTileState("ready", "No subs yet", false)).toEqual({ loading: false, trend: "No subs yet" });
  });
  it("count: never a false 0", () => {
    expect(countText("loading", 0)).toBe("…");
    expect(countText("error", 0)).toBe("—");
    expect(countText("ready", 0)).toBe(0);
  });
});

describe("DashCardBody (R-2239)", () => {
  it("loading → skeleton, never the empty text", () => {
    render(body([{ data: undefined }], true));
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText("61 subs")).toBeNull();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    expect(screen.queryByText(STILL_LOADING_TEXT)).toBeNull();
  });

  it("still loading after 10 s → says so", () => {
    vi.useFakeTimers();
    render(body([{ data: undefined }], true));
    act(() => { vi.advanceTimersByTime(STILL_LOADING_MS - 1); });
    expect(screen.queryByText(STILL_LOADING_TEXT)).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByText(STILL_LOADING_TEXT)).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("resolved empty → the empty text", () => {
    render(body([{ data: [] }], true));
    expect(screen.getByText(EMPTY)).toBeTruthy();
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("resolved with data → the content", () => {
    render(body([{ data: [1] }], false));
    expect(screen.getByText("61 subs")).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("error → error with Try again (retries the failed query), never the empty text", () => {
    const refetch = vi.fn();
    const ok = vi.fn();
    render(body([{ data: undefined, isError: true, error: new Error("x"), refetch }, { data: [], refetch: ok }], true));
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Renewals didn't load");
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(ok).not.toHaveBeenCalled();
  });
});
