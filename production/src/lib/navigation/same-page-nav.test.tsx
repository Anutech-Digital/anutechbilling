// @vitest-environment jsdom
/**
 * R-2942 — on /tasks?priority=high a click on the "List" tab (or the sidebar "Tasks" row) is a
 * link to /tasks: the address went clean but the list stayed filtered, because the URL hooks
 * read the address only when the page mounts and on Back / Forward. A link to the page you are
 * already on keeps the page mounted and only pushes a new history entry.
 *
 * The contract: when the page already showing is opened again at its BARE address through a
 * navigation (pushState), every URL hook reads the address again — so every filter is back at
 * its default. A hook's own write (replaceState), a navigation to another page, and a push
 * that adds a param to this page (/leads → ?projectQuote=) do not fire it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { onSamePageNav } from "./same-page-nav";
import { useUrlState } from "@/lib/hooks/use-url-state";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { useUrlList } from "@/lib/hooks/use-url-list";

/** What a Next <Link> click or router.push does to the address: a new history entry, no page load. */
async function linkTo(url: string) {
  await act(async () => {
    window.history.pushState({}, "", url);
    await Promise.resolve();
  });
}

beforeEach(() => window.history.replaceState(null, "", "/tasks"));
afterEach(() => cleanup());

describe("onSamePageNav", () => {
  it("fires when the page showing is opened again at its bare address", async () => {
    window.history.replaceState(null, "", "/tasks?priority=high");
    const heard = vi.fn();
    const off = onSamePageNav(heard);
    await linkTo("/tasks");
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    window.history.replaceState(null, "", "/tasks?priority=low");
    await linkTo("/tasks");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for another page, for an address that was already bare, and for replaceState", async () => {
    window.history.replaceState(null, "", "/tasks?priority=high");
    const heard = vi.fn();
    const off = onSamePageNav(heard);
    await linkTo("/leads");
    await linkTo("/leads");
    await linkTo("/tasks?priority=high");
    await act(async () => {
      window.history.replaceState(null, "", "/tasks");
      await Promise.resolve();
    });
    expect(heard).not.toHaveBeenCalled();
    off();
  });

  it("stays quiet when a push ADDS or changes a param on the page (it names one thing, not the rest)", async () => {
    window.history.replaceState(null, "", "/leads?stage=trial");
    const heard = vi.fn();
    const off = onSamePageNav(heard);
    await linkTo("/leads?projectQuote=l1");
    await linkTo("/leads?projectQuote=l2&stage=trial");
    expect(heard).not.toHaveBeenCalled();
    off();
  });

  it("two listeners are each told once (the history is wrapped one time only)", async () => {
    window.history.replaceState(null, "", "/tasks?q=x");
    const a = vi.fn();
    const b = vi.fn();
    const offA = onSamePageNav(a);
    const offB = onSamePageNav(b);
    await linkTo("/tasks");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });
});

describe("URL hooks follow a link to the bare address of the page they are on (R-2942)", () => {
  it("/tasks?priority=high&status=…&assignee=…&q=…&tab=… → 'List' (/tasks) clears every filter", async () => {
    window.history.replaceState(null, "", "/tasks?priority=high&status=in_progress&assignee=u2&q=acme&tab=overdue");
    const priority = renderHook(() => useUrlChoice("priority", ["all", "high", "medium", "low"] as const, "all"));
    const status = renderHook(() => useUrlChoice("status", ["all", "in_progress", "done"] as const, "all"));
    const tab = renderHook(() => useUrlChoice("tab", ["all", "overdue"] as const, "all"));
    const assignee = renderHook(() => useUrlState("assignee", "all"));
    const q = renderHook(() => useUrlState("q", ""));
    const now = () => [priority.result.current[0], status.result.current[0], tab.result.current[0], assignee.result.current[0], q.result.current[0]];
    expect(now()).toEqual(["high", "in_progress", "overdue", "u2", "acme"]);

    await linkTo("/tasks");

    expect(now()).toEqual(["all", "all", "all", "all", ""]);
    expect(window.location.search).toBe("");
  });

  it("useUrlList: /leads?stage=trial,demo → 'Leads' (/leads) empties the list", async () => {
    window.history.replaceState(null, "", "/leads?stage=trial,demo");
    const stage = renderHook(() => useUrlList("stage"));
    expect(stage.result.current[0]).toEqual(["trial", "demo"]);
    await linkTo("/leads");
    expect(stage.result.current[0]).toEqual([]);
    // The setter works from the new value, not the one before the link.
    act(() => stage.result.current[1]((prev) => [...prev, "won"]));
    expect(window.location.search).toBe("?stage=won");
  });

  it("a push that adds a param keeps the filters: /leads?stage=trial&q=acme → ?projectQuote=<id>", async () => {
    window.history.replaceState(null, "", "/leads?stage=trial&q=acme");
    const stage = renderHook(() => useUrlList("stage"));
    const q = renderHook(() => useUrlState("q", ""));
    await linkTo("/leads?projectQuote=l1");
    expect(stage.result.current[0]).toEqual(["trial"]);
    expect(q.result.current[0]).toBe("acme");
  });

  it("a filter the hook itself writes is kept (its own write is not a navigation)", async () => {
    const q = renderHook(() => useUrlState("q", ""));
    const priority = renderHook(() => useUrlChoice("priority", ["all", "high"] as const, "all"));
    await act(async () => {
      q.result.current[1]("acme");
      priority.result.current[1]("high");
      await Promise.resolve();
    });
    expect(q.result.current[0]).toBe("acme");
    expect(priority.result.current[0]).toBe("high");
    expect(window.location.search).toBe("?q=acme&priority=high");
    // …and setting them back by hand empties the address without any navigation.
    await act(async () => {
      q.result.current[1]("");
      priority.result.current[1]("all");
      await Promise.resolve();
    });
    expect(window.location.search).toBe("");
  });

  it("Back / Forward still work as before (popstate)", async () => {
    window.history.replaceState(null, "", "/tasks?q=acme");
    const q = renderHook(() => useUrlState("q", ""));
    expect(q.result.current[0]).toBe("acme");
    await act(async () => {
      window.history.replaceState(null, "", "/tasks?q=beta");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(q.result.current[0]).toBe("beta");
  });

  it("an unmounted hook is no longer told", async () => {
    window.history.replaceState(null, "", "/tasks?q=acme");
    const q = renderHook(() => useUrlState("q", ""));
    q.unmount();
    await expect(linkTo("/tasks")).resolves.toBeUndefined();
  });
});
