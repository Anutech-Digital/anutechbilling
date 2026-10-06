/**
 * R-105 — the Quotes list paints 50 at a time (R-024 rule, same as Payments R-104).
 *
 * Every filter that changes WHICH quotes are in the list goes into the reset key, so a new
 * tab, money-tile focus, search, team view or "awaiting my approval" toggle starts again at
 * one page. Search is trimmed and lower-cased the way the page's filter reads it, so typing a
 * trailing space does not throw away the rows already loaded.
 */
export const QUOTES_PAGE_SIZE = 50;

export function quotesPagingKey(f: {
  tab: string;
  focus: string;
  search: string;
  teamMode: string;
  onlyMyApprovals: boolean;
}): string {
  return [f.tab, f.focus, f.search.trim().toLowerCase(), f.teamMode, f.onlyMyApprovals ? "mine" : ""].join("|");
}
