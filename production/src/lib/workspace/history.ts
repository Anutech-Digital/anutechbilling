/**
 * Per-tab navigation history, and what to do when the browser's Back button fires.
 *
 * ─── THE SEMANTICS CHOSEN, AND WHY IT CANNOT BE PERFECT ──────────────────────
 * Decision: **Back means "the previous page inside this tab"**, and switching
 * tabs does NOT create a history entry.
 *
 * The brief asked for back/forward to work "100% seamlessly". It cannot, and
 * saying so is more useful than pretending. The browser has ONE history stack and
 * this app now has two notions of "previous": the previous page within a tab, and
 * the previously-active tab. Both cannot occupy one stack.
 *
 * So switching tabs uses `replaceState` (no new entry) and navigating within a tab
 * uses `pushState` (a real entry). That gives the chosen behaviour for as long as
 * the current tab has history left.
 *
 * WHAT HAPPENS WHEN IT RUNS OUT, stated because it will happen daily: tab A pushes
 * three pages, you switch to tab B and push two. Back twice walks B's history
 * correctly. A third Back lands on an entry that belongs to A — the single stack
 * leaves nowhere else for it to go.
 *
 * Two ways to handle that. Cancelling it by pushing forward again makes Back
 * silently do nothing, and a dead Back button is the kind of thing people stop
 * trusting the whole app over. Instead the owning tab is activated and the page is
 * shown: Back walks out of this tab and into the one you were in before. That is
 * the honest reading of one shared stack, and it is at least predictable.
 *
 * Every function here is pure so the sequence can be tested without a browser.
 */

export interface TabHistory {
  /** Oldest first. */
  stack: string[];
  /** Index of the currently displayed entry. */
  cursor: number;
}

export const emptyHistory: TabHistory = { stack: [], cursor: -1 };

export function currentUrl(h: TabHistory): string | null {
  return h.stack[h.cursor] ?? null;
}

export function canGoBack(h: TabHistory): boolean {
  return h.cursor > 0;
}

export function canGoForward(h: TabHistory): boolean {
  return h.cursor >= 0 && h.cursor < h.stack.length - 1;
}

/**
 * Navigate to a URL within this tab.
 *
 * Truncates anything ahead of the cursor, exactly as a browser does: once you go
 * back and then navigate somewhere new, the old forward path is gone.
 *
 * Navigating to the page you are already on is a no-op rather than a duplicate
 * entry. Duplicates are how Back appears to do nothing — you press it, the URL
 * does not change, and the app looks frozen.
 */
export function pushUrl(h: TabHistory, url: string): TabHistory {
  const next = (url ?? "").trim();
  if (!next) return h;
  if (currentUrl(h) === next) return h;
  const kept = h.stack.slice(0, h.cursor + 1);
  return { stack: [...kept, next], cursor: kept.length };
}

export function goBack(h: TabHistory): TabHistory {
  return canGoBack(h) ? { ...h, cursor: h.cursor - 1 } : h;
}

export function goForward(h: TabHistory): TabHistory {
  return canGoForward(h) ? { ...h, cursor: h.cursor + 1 } : h;
}

/**
 * Move the cursor to a URL already in this tab's stack.
 *
 * Searches BACKWARD from the cursor first. A URL can legitimately appear more
 * than once — open a customer, open a quote, come back to the customer — and when
 * Back fires, the entry meant is the nearer one behind, not the first match from
 * the start of the stack.
 */
export function seekTo(h: TabHistory, url: string): TabHistory | null {
  for (let i = h.cursor - 1; i >= 0; i--) if (h.stack[i] === url) return { ...h, cursor: i };
  for (let i = h.cursor + 1; i < h.stack.length; i++) if (h.stack[i] === url) return { ...h, cursor: i };
  return h.stack[h.cursor] === url ? h : null;
}

export type PopStateOutcome =
  /** The URL belongs to the active tab — move its cursor and render. */
  | { kind: "within_tab"; tabId: string; url: string }
  /**
   * The URL belongs to a DIFFERENT open tab. The active tab has run out of
   * history and Back has walked into the previous tab's. Activate that tab.
   */
  | { kind: "switch_tab"; tabId: string; url: string }
  /**
   * No open tab owns it — Back has left the workspace entirely (the page before
   * any tab was opened). Let the browser have it.
   */
  | { kind: "left_workspace"; url: string };

/**
 * Is this `popstate` a step between pages the App Router made — or only the browser moving to
 * a `#section` on the same page?
 *
 * R-1506 (17 Oct 2026, Pawan on staging): "See how migration works" (`<a href="#move">` on
 * /hosting) made the page flicker and go nowhere. A plain `#anchor` click is a same-document
 * fragment navigation: the browser scrolls to the section and fires `popstate` with a NULL
 * history state. The popstate handler treated that like Back and called
 * `router.replace("/hosting")` — the hash was dropped, the page went back to the top and
 * re-fetched. Measured on staging: click → popstate(/hosting#move) → replaceState(/hosting),
 * scrollY 0.
 *
 * Every entry the App Router creates carries `__NA: true` in its state (next/dist app-router,
 * HistoryUpdater); Next's own popstate handler ignores the rest, and so must ours.
 */
export function isRouterHistoryEntry(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as { __NA?: unknown }).__NA === true;
}

/**
 * Decide what a `popstate` means.
 *
 * @param url        Where the browser just navigated.
 * @param activeId   The currently active tab.
 * @param histories  Every open tab's history, keyed by tab id.
 */
export function resolvePopState(
  url: string,
  activeId: string | null,
  histories: Record<string, TabHistory>,
): PopStateOutcome {
  const target = (url ?? "").trim();

  // The active tab is checked first: when a URL appears in more than one tab's
  // history, staying put is far less surprising than being thrown sideways.
  if (activeId && histories[activeId]?.stack.includes(target)) {
    return { kind: "within_tab", tabId: activeId, url: target };
  }

  for (const [tabId, h] of Object.entries(histories)) {
    if (tabId === activeId) continue;
    if (h.stack.includes(target)) return { kind: "switch_tab", tabId, url: target };
  }

  return { kind: "left_workspace", url: target };
}

/**
 * How the browser history should be updated for a navigation.
 *
 * Separated out because getting it backwards is invisible until someone presses
 * Back: `push` where `replace` was meant leaves a phantom entry that goes nowhere,
 * and `replace` where `push` was meant loses a step silently.
 */
export function historyOpFor(
  reason: "tab_switch" | "navigate" | "tab_open" | "tab_close",
): "push" | "replace" | "none" {
  switch (reason) {
    // Switching tabs must NOT add an entry — that is the whole basis of the
    // chosen semantics. The URL still changes so the address bar and copy-link
    // stay correct, which is what replaceState is for.
    case "tab_switch": return "replace";
    // Opening a tab is a navigation to somewhere new, so it earns an entry.
    case "tab_open":   return "push";
    case "navigate":   return "push";
    // Closing reveals whichever tab takes over; that tab's page was already
    // visited, so a new entry would mean Back returns to the tab just closed.
    case "tab_close":  return "replace";
  }
}
