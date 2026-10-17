import { describe, it, expect } from "vitest";
import {
  pushUrl, goBack, goForward, seekTo, currentUrl,
  canGoBack, canGoForward, resolvePopState, historyOpFor, isRouterHistoryEntry,
  emptyHistory, type TabHistory,
} from "./history";

/** Build a history directly so each test starts exactly where it means to. */
const hist = (stack: string[], cursor = stack.length - 1): TabHistory => ({ stack, cursor });

describe("pushUrl", () => {
  it("appends and moves the cursor", () => {
    const h = pushUrl(pushUrl(emptyHistory, "/a"), "/b");
    expect(h.stack).toEqual(["/a", "/b"]);
    expect(currentUrl(h)).toBe("/b");
  });

  it("TRUNCATES the forward path, exactly as a browser does", () => {
    // Go back, then navigate somewhere new: the old forward path is gone.
    const h = goBack(hist(["/a", "/b", "/c"]));
    expect(pushUrl(h, "/x").stack).toEqual(["/a", "/b", "/x"]);
  });

  it("ignores a push to the page you are already on", () => {
    // A duplicate entry is how Back appears to do nothing: you press it, the URL
    // does not change, and the app looks frozen.
    const h = hist(["/a", "/b"]);
    expect(pushUrl(h, "/b")).toEqual(h);
  });

  it("still allows returning to a page visited earlier", () => {
    // Only the CURRENT entry is deduplicated — /a → /b → /a is a real sequence.
    const h = pushUrl(pushUrl(pushUrl(emptyHistory, "/a"), "/b"), "/a");
    expect(h.stack).toEqual(["/a", "/b", "/a"]);
  });

  it("ignores an empty url", () => {
    expect(pushUrl(hist(["/a"]), "   ")).toEqual(hist(["/a"]));
  });
});

describe("back and forward", () => {
  it("walks the stack in both directions", () => {
    const h = hist(["/a", "/b", "/c"]);
    expect(currentUrl(goBack(h))).toBe("/b");
    expect(currentUrl(goForward(goBack(h)))).toBe("/c");
  });

  it("stops at the ends instead of running off them", () => {
    const first = hist(["/a", "/b"], 0);
    expect(goBack(first)).toEqual(first);
    expect(canGoBack(first)).toBe(false);

    const last = hist(["/a", "/b"]);
    expect(goForward(last)).toEqual(last);
    expect(canGoForward(last)).toBe(false);
  });

  it("handles an empty history without throwing", () => {
    expect(currentUrl(emptyHistory)).toBeNull();
    expect(goBack(emptyHistory)).toEqual(emptyHistory);
    expect(canGoBack(emptyHistory)).toBe(false);
  });
});

describe("seekTo picks the NEARER entry behind", () => {
  it("finds the closest match backward, not the first from the start", () => {
    // Open a customer, open a quote, come back to the customer: /a appears twice.
    // When Back fires, the entry meant is the one just behind.
    const h = hist(["/a", "/b", "/a", "/c"]);      // cursor at /c
    expect(seekTo(h, "/a")!.cursor).toBe(2);
  });

  it("looks forward when nothing matches behind", () => {
    const h = hist(["/a", "/b", "/c"], 0);
    expect(seekTo(h, "/c")!.cursor).toBe(2);
  });

  it("returns the same history when the url is already current", () => {
    const h = hist(["/a", "/b"]);
    expect(seekTo(h, "/b")).toEqual(h);
  });

  it("returns null for a url that is not in this tab at all", () => {
    expect(seekTo(hist(["/a"]), "/nope")).toBeNull();
  });
});

describe("resolvePopState — what Back actually means", () => {
  const histories = {
    "/tabA": hist(["/a1", "/a2", "/a3"]),
    "/tabB": hist(["/b1", "/b2"]),
  };

  it("stays put when the url belongs to the active tab", () => {
    const r = resolvePopState("/a2", "/tabA", histories);
    expect(r).toEqual({ kind: "within_tab", tabId: "/tabA", url: "/a2" });
  });

  it("switches tabs when Back has walked out of this tab's history", () => {
    // The unavoidable case: one browser stack, two notions of "previous". Tab B
    // runs out and Back lands on an entry owned by A. Cancelling it would make
    // Back silently do nothing, which is worse than moving.
    const r = resolvePopState("/a3", "/tabB", histories);
    expect(r).toEqual({ kind: "switch_tab", tabId: "/tabA", url: "/a3" });
  });

  it("prefers the ACTIVE tab when a url appears in more than one", () => {
    // Being thrown sideways is far more surprising than staying put.
    const shared = {
      "/tabA": hist(["/shared", "/a2"]),
      "/tabB": hist(["/shared", "/b2"]),
    };
    expect(resolvePopState("/shared", "/tabB", shared))
      .toEqual({ kind: "within_tab", tabId: "/tabB", url: "/shared" });
  });

  it("reports leaving the workspace when no tab owns the url", () => {
    // Back has gone past the point where any tab was opened. The browser should
    // have it; fighting that traps the user inside the app.
    expect(resolvePopState("/login", "/tabA", histories))
      .toEqual({ kind: "left_workspace", url: "/login" });
  });

  it("handles no active tab and an empty workspace", () => {
    expect(resolvePopState("/x", null, {}).kind).toBe("left_workspace");
    expect(resolvePopState("/x", null, histories).kind).toBe("left_workspace");
  });
});

describe("isRouterHistoryEntry — R-1506: a #section click is not Back", () => {
  it("is true only for entries the App Router wrote (__NA: true)", () => {
    expect(isRouterHistoryEntry({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: [] })).toBe(true);
  });

  it("is false for the null state a plain <a href=\"#move\"> click leaves behind", () => {
    expect(isRouterHistoryEntry(null)).toBe(false);
    expect(isRouterHistoryEntry(undefined)).toBe(false);
    expect(isRouterHistoryEntry({})).toBe(false);
    expect(isRouterHistoryEntry({ __NA: "yes" })).toBe(false);
  });
});

describe("historyOpFor — the choice that is invisible until someone presses Back", () => {
  it("REPLACES on a tab switch, so switching adds no entry", () => {
    // This is the entire basis of "Back means the previous page in this tab".
    // A push here would make Back mean "the previous tab" instead.
    expect(historyOpFor("tab_switch")).toBe("replace");
  });

  it("PUSHES on navigation and on opening a tab", () => {
    expect(historyOpFor("navigate")).toBe("push");
    expect(historyOpFor("tab_open")).toBe("push");
  });

  it("REPLACES on close, so Back does not return to the tab just closed", () => {
    expect(historyOpFor("tab_close")).toBe("replace");
  });
});

describe("a realistic sequence", () => {
  it("walks two tabs the way the chosen semantics promise", () => {
    // Tab A: customers → one customer → their quote
    let a = emptyHistory;
    for (const u of ["/customers", "/customers/1", "/quotes/9"]) a = pushUrl(a, u);

    // Tab B: invoices → one invoice
    let b = emptyHistory;
    for (const u of ["/invoices", "/invoices/7"]) b = pushUrl(b, u);

    const histories = { "/tabA": a, "/tabB": b };

    // In B, Back walks B's own history.
    const first = resolvePopState("/invoices", "/tabB", histories);
    expect(first).toMatchObject({ kind: "within_tab", tabId: "/tabB" });

    // B is now exhausted. The next Back lands in A — and is followed, not fought.
    const second = resolvePopState("/quotes/9", "/tabB", histories);
    expect(second).toMatchObject({ kind: "switch_tab", tabId: "/tabA" });

    // And within A it behaves normally again.
    expect(currentUrl(goBack(a))).toBe("/customers/1");
  });
});
