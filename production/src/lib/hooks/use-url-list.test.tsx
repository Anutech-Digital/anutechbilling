// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { parseUrlList, useUrlList } from "./use-url-list";

/* R-349: /deals Filter (Stage / Priority / Owner) lived only in useState — filter "Trial",
   open a deal, press Back, and the list came back unfiltered. Contract: the selection is
   written to the address bar as it changes, and a page that mounts again reads it back. */

const STAGES = ["quote", "demo", "trial", "won", "lost"] as const;

beforeEach(() => window.history.replaceState(null, "", "/deals"));
afterEach(() => cleanup());

describe("parseUrlList", () => {
  it("splits, trims and de-duplicates", () => {
    expect(parseUrlList("trial, demo,,trial")).toEqual(["trial", "demo"]);
  });
  it("drops values that are not allowed (stale or hand-edited link)", () => {
    expect(parseUrlList("trial,new,bogus", STAGES)).toEqual(["trial"]);
  });
  it("empty / missing → no filter", () => {
    expect(parseUrlList(null)).toEqual([]);
    expect(parseUrlList("")).toEqual([]);
  });
});

describe("useUrlList", () => {
  it("starts empty when the URL says nothing", () => {
    const { result } = renderHook(() => useUrlList("stage", STAGES));
    expect(result.current[0]).toEqual([]);
  });

  it("reads the selection the URL already carries (refresh keeps the filter)", () => {
    window.history.replaceState(null, "", "/deals?stage=trial,demo");
    const { result } = renderHook(() => useUrlList("stage", STAGES));
    expect(result.current[0]).toEqual(["trial", "demo"]);
  });

  it("supports updater functions (the toolbar toggles one item at a time) and keeps other params", () => {
    window.history.replaceState(null, "", "/deals?view=won-mtd");
    const { result } = renderHook(() => useUrlList("stage", STAGES));
    act(() => result.current[1]((prev) => [...prev, "trial"]));
    act(() => result.current[1]((prev) => [...prev, "demo"]));
    expect(result.current[0]).toEqual(["trial", "demo"]);
    const p = new URLSearchParams(window.location.search);
    expect(p.get("stage")).toBe("trial,demo");
    expect(p.get("view")).toBe("won-mtd");
    expect(window.location.pathname).toBe("/deals");
  });

  it("clearing removes the key, so an unfiltered list has a clean URL", () => {
    window.history.replaceState(null, "", "/deals?stage=trial");
    const { result } = renderHook(() => useUrlList("stage", STAGES));
    act(() => result.current[1]([]));
    expect(window.location.search).toBe("");
  });

  it("does not add a history entry per click", () => {
    const before = window.history.length;
    const { result } = renderHook(() => useUrlList("priority"));
    act(() => result.current[1](["high"]));
    act(() => result.current[1](["high", "low"]));
    expect(window.history.length).toBe(before);
  });

  it("filter → open a deal → Back: the remounted list gets its filter back", () => {
    const first = renderHook(() => useUrlList("stage", STAGES));
    act(() => first.result.current[1](["trial"]));
    first.unmount();
    const again = renderHook(() => useUrlList("stage", STAGES));
    expect(again.result.current[0]).toEqual(["trial"]);
  });
});
