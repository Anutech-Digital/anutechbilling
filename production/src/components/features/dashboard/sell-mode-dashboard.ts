/**
 * R-1862 — what the Dashboard puts up front for each "What do you sell?" answer (lib/sell-mode.ts).
 *
 * A one-time business sees ₹0 MRR, an empty Renewals panel and an empty Trials panel, which is
 * noise. For that answer — and only while the workspace has no subscription — the MRR tile
 * becomes an Open projects tile, Renewals · 30d becomes Active projects, and the Renewals /
 * Trials panels leave the default layout. Both / Subscriptions: exactly as before.
 *
 * Hide, never block (R-1841): a subscription on file brings every subscription tile back by
 * itself, and every page still opens from the menu's "Show all modules", its link or Ctrl+K.
 * Pure — the page renders it, the tests pin it.
 */
import { sellsSubscriptions, type SellMode } from "@/lib/sell-mode";

/** Dashboard panels that only mean something to a business with subscriptions. */
export const SUBSCRIPTION_PANELS: readonly string[] = ["renewals", "trials"];

/**
 * True when the dashboard should lead with projects instead of subscriptions. `hasSubscriptions`
 * undefined (still loading) counts as none — the page waits for the subscription list anyway.
 */
export function leadsWithProjects(mode: SellMode, hasSubscriptions: boolean | undefined): boolean {
  return !sellsSubscriptions(mode) && hasSubscriptions !== true;
}

/** Panels the dashboard may show for this answer. The user's own drag order is kept as it is. */
export function panelAvailable(id: string, projectsFirst: boolean): boolean {
  return !(projectsFirst && SUBSCRIPTION_PANELS.includes(id));
}

export interface OpenProjectsSummary {
  /** Active (not draft / quoted / completed / cancelled) project sales. */
  count: number;
  /** Their contract value, GST-inclusive, whole rupees. */
  value: number;
}

/** Sum the active project sales — the Open projects tile. Status 'active' only. */
export function summarizeOpenProjects(rows: { status: string | null; total_amount: number | null }[]): OpenProjectsSummary {
  let count = 0;
  let value = 0;
  for (const r of rows) {
    if (r.status !== "active") continue;
    count += 1;
    value += Math.round(r.total_amount ?? 0);
  }
  return { count, value };
}

/**
 * Getting started "first product" step: a one-time business adds a one-time product
 * (Products → One-time products tab); everyone else keeps the subscription price list.
 */
export function firstProductStep(mode: SellMode): { label: string; hint: string; href: string; cta: string } {
  if (!sellsSubscriptions(mode)) {
    return {
      label: "Add your first one-time item",
      hint: "A product or service you sell once — price, GST rate and HSN/SAC.",
      href: "/items/products",
      cta: "Add one-time item",
    };
  }
  return {
    label: "Load your price list",
    hint: "One click seeds 7 products + 8 add-ons — edit rates anytime.",
    href: "/items",
    cta: "Load catalog",
  };
}

/** /items opened without a tab: a one-time business lands on its One-time products tab. */
export function defaultCatalogType(pathname: string | null, mode: SellMode): "subscription" | "one_time" {
  if (pathname?.startsWith("/items/products")) return "one_time";
  if (pathname?.startsWith("/items/subscriptions")) return "subscription";
  return sellsSubscriptions(mode) ? "subscription" : "one_time";
}
