/**
 * R-2942 (20 Nov 2026) — "the page already showing was opened again at its bare address".
 *
 * The URL hooks (lib/hooks/use-url-state.ts, use-url-choice.ts, use-url-list.ts) read the
 * address when a page mounts and on Back / Forward (popstate). A LINK to the page you are
 * already on — the "List" tab or the sidebar "Tasks" row while on /tasks?priority=high — is
 * neither: Next keeps the page mounted and only pushes a new history entry. The address went
 * clean and the list stayed filtered.
 *
 * The browser has no event for pushState, and Next's own answer (useSearchParams) opts a page
 * out of prerendering (see use-url-choice.ts). So history.pushState is wrapped ONCE and, when a
 * push leaves the path as it was and the new address has NO query, the listeners are told to
 * read the address again — every filter goes back to its default, as the address says.
 *
 *   • Only pushState — the hooks write with replaceState, so their own writes never come back
 *     here, and typing in a search box costs nothing extra.
 *   • Only when the path is unchanged: on a move to another page the old page unmounts and the
 *     new one reads the address as it mounts.
 *   • Only to the bare address. A push that ADDS a param to the page it is on names one thing
 *     and says nothing about the rest: /leads?stage=trial → `${pathname}?projectQuote=<id>`
 *     (leads/page.tsx, lead-detail-sheet.tsx) opens a sheet over the list and must not empty
 *     the list's filters. "No query" is the one address that plainly means "no filters".
 *   • Told a moment later (microtask): Next pushes from inside a React commit, where a
 *     listener must not set state.
 */
const EVENT = "app:same-page-nav";
const INSTALLED = "__appSamePageNavInstalled";

type Flagged = Window & { [INSTALLED]?: boolean };

function install(): void {
  const w = window as Flagged;
  if (w[INSTALLED]) return; // the flag is on window, so a hot reload of this module does not wrap twice
  w[INSTALLED] = true;
  const history = window.history;
  const push = history.pushState;
  history.pushState = function pushState(this: History, ...args: Parameters<History["pushState"]>): void {
    const { pathname, search } = window.location;
    push.apply(this, args);
    if (window.location.pathname === pathname && search !== "" && window.location.search === "") {
      queueMicrotask(() => window.dispatchEvent(new Event(EVENT)));
    }
  };
}

/** Call `listener` when a navigation opens the page already showing at its bare address
 *  (same path, the query gone). Returns the function that stops it. */
export function onSamePageNav(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  install();
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
