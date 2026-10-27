/**
 * R-1860 (epic R-1841, Phase 5) — "What do you sell?": the one answer that decides what the
 * app puts up front. Stored on tenants.sell_mode (migration 20261024204624_r1860_tenant_sell_mode.sql).
 *
 *   subscriptions — recurring licences / plans (renewals, MRR)
 *   one_time      — one-time products & services (projects, invoices)
 *   both          — the default, and what every workspace had before this setting
 *
 * The answer only changes what is SHOWN first — it never blocks a page or deletes data
 * (R-1841 decision 4). Pages still open by URL and Ctrl+K; the role guard (nav.ts
 * allowedRoutesForRole → middleware) does not read it. Hidden menu rows come back on their
 * own once the workspace has that kind of data, and each user can turn on "Show all modules".
 *
 * Pure: no imports, so nav.ts, the dashboard and tests can all share it.
 */

export type SellMode = "subscriptions" | "one_time" | "both";

export const SELL_MODES: readonly SellMode[] = ["subscriptions", "one_time", "both"];

/** New workspaces, workspaces from before the setting, and any unreadable value. */
export const DEFAULT_SELL_MODE: SellMode = "both";

export const SELL_MODE_LABEL: Record<SellMode, string> = {
  subscriptions: "Subscriptions",
  one_time: "One-time products & services",
  both: "Both",
};

export const SELL_MODE_HINT: Record<SellMode, string> = {
  subscriptions: "Licences or plans that renew. Renewals and monthly revenue come first.",
  one_time: "Products and services sold once. Projects and invoices come first; renewal screens stay out of the menu.",
  both: "Subscriptions and one-time sales. Everything is shown.",
};

export function isSellMode(v: unknown): v is SellMode {
  return typeof v === "string" && (SELL_MODES as readonly string[]).includes(v);
}

/** Anything not a known answer (null, missing column, typo) reads as the default. */
export function parseSellMode(v: unknown): SellMode {
  return isSellMode(v) ? v : DEFAULT_SELL_MODE;
}

/** True when subscription screens (Subscriptions, Renewals, MRR, Trials) belong up front. */
export function sellsSubscriptions(mode: SellMode): boolean {
  return mode !== "one_time";
}
