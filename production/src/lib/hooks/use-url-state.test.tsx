// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useUrlState } from "./use-url-state";

/* R-272: list filters lived only in useState, so opening a quote and pressing Back came
   home to an unfiltered list. The contract: a filter is written to the address bar as it
   changes (replaceState — no navigation), and a page that mounts again reads it back. */

beforeEach(() => window.history.replaceState(null, "", "/quotes"));
afterEach(() => cleanup());

describe("useUrlState", () => {
  it("starts on the fallback when the URL says nothing", () => {
    const { result } = renderHook(() => useUrlState("q", ""));
    expect(result.current[0]).toBe("");
  });

  it("reads the value the URL already carries", () => {
    window.history.replaceState(null, "", "/quotes?q=acme");
    const { result } = renderHook(() => useUrlState("q", ""));
    expect(result.current[0]).toBe("acme");
  });

  it("writes to the address bar without dropping the other params", () => {
    window.history.replaceState(null, "", "/quotes?tab=sent");
    const { result } = renderHook(() => useUrlState("q", ""));
    act(() => result.current[1]("acme corp"));
    expect(result.current[0]).toBe("acme corp");
    const p = new URLSearchParams(window.location.search);
    expect(p.get("tab")).toBe("sent");
    expect(p.get("q")).toBe("acme corp");
    expect(window.location.pathname).toBe("/quotes");
  });

  it("removes the key when set back to the fallback, so a clean list has a clean URL", () => {
    window.history.replaceState(null, "", "/purchase-orders?vendor=v1");
    const { result } = renderHook(() => useUrlState("vendor", "all"));
    expect(result.current[0]).toBe("v1");
    act(() => result.current[1]("all"));
    expect(window.location.search).toBe("");
  });

  it("does not add a history entry per keystroke (Back must leave the page, not undo a letter)", () => {
    const before = window.history.length;
    const { result } = renderHook(() => useUrlState("q", ""));
    act(() => result.current[1]("a"));
    act(() => result.current[1]("ac"));
    expect(window.history.length).toBe(before);
  });

  it("filter → open a quote → Back: the remounted list gets its filter back", () => {
    const first = renderHook(() => useUrlState("q", ""));
    act(() => first.result.current[1]("acme"));
    first.unmount();
    // Navigating to /quotes/<id> and back restores /quotes?q=acme; the page mounts fresh.
    const again = renderHook(() => useUrlState("q", ""));
    expect(again.result.current[0]).toBe("acme");
  });

  it("follows the URL on popstate", () => {
    const { result } = renderHook(() => useUrlState("q", ""));
    act(() => {
      window.history.replaceState(null, "", "/quotes?q=zen");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("zen");
  });
});
