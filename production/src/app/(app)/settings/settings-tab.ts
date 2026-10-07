/**
 * R-252 — the Settings tab lives in the URL (?tab=), not in component state.
 *
 * Before: `useState("company")`, so every deep link — purchases inbox, contacts, enquiry
 * chips, money-readiness, the Google OAuth callbacks, AI Help — that pointed at
 * /settings?tab=integrations opened Company instead. Switching tabs also unmounted the
 * Company form, silently dropping up to 19 half-typed fields (the page now asks first).
 */

export const DEFAULT_SETTINGS_TAB = "company";

/** A known tab id from the URL, else Company. */
export function resolveSettingsTab(param: string | null | undefined, valid: readonly string[]): string {
  const t = (param ?? "").trim().toLowerCase();
  return valid.includes(t) ? t : DEFAULT_SETTINGS_TAB;
}

/**
 * The URL for a tab, keeping any other query params. Company is the default, so its URL
 * carries no ?tab= at all.
 */
export function settingsTabHref(pathname: string, currentQuery: string, tab: string): string {
  const q = new URLSearchParams(currentQuery);
  if (tab === DEFAULT_SETTINGS_TAB) q.delete("tab");
  else q.set("tab", tab);
  const qs = q.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
