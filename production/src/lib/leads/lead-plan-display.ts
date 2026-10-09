/**
 * What a lead card says about the plan and the money (R-490 / R-456).
 *
 * Website leads store the buy-page slug ("google-workspace", "google-workspace-starter"),
 * so the Kanban card read "12 seats · google-workspace" and "—" for value even though 12
 * seats were known. This names the plan from the tenant's own catalogue — the same match
 * the quote builder uses (lib/quotes/lead-plan-match.ts), so the card and the first quote
 * line agree — and estimates the deal as seats × that plan's yearly rate (ex-GST) when the
 * lead has no value of its own. A value someone typed always wins.
 */
import type { Item } from "@/lib/supabase/database.types";
import { matchCatalogItemForPlan } from "@/lib/quotes/lead-plan-match";
import { slabPricing } from "@/lib/quotes/volume-tiers";
import { floorWorkspaceRow } from "@/lib/catalog/workspace-floor";

type CatalogRow = Pick<Item, "name" | "msrp" | "wholesale" | "prices" | "item_type">;

export interface LeadPlanDisplay {
  /** Catalogue name, else the stored plan made readable, else null. */
  name: string | null;
  /** ₹ per seat per year from the catalogue, or null when no row matched. */
  ratePerSeatYear: number | null;
  /** Lead value, else seats × rate. Whole rupees. Null when neither is known. */
  value: number | null;
  /** True when `value` is our seats × rate estimate, not a number someone entered. */
  estimated: boolean;
}

/** "google-workspace-starter" → "Google Workspace Starter"; a real name is left alone. */
export function readablePlan(plan: string | null | undefined): string | null {
  const p = (plan ?? "").trim();
  if (!p) return null;
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(p)) return p;
  return p
    .split(/[-_]/)
    .map((w) => (w === "365" ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function leadPlanDisplay(
  lead: { plan?: string | null; seats?: number | null; value?: number | null },
  catalog: readonly CatalogRow[] | null | undefined,
): LeadPlanDisplay {
  const recurring = (catalog ?? []).filter((c) => c.item_type !== "one_time").map((c) => floorWorkspaceRow(c));
  const row = matchCatalogItemForPlan(recurring, lead.plan);
  const seats = lead.seats ?? 0;

  let ratePerSeatYear: number | null = null;
  if (row) {
    const perMonth = slabPricing(row, Math.max(seats, 1)).msrpPerSeatMonth;
    if (perMonth > 0) ratePerSeatYear = Math.round(perMonth * 12);
  }

  const name = row?.name?.trim() || readablePlan(lead.plan);

  if (lead.value != null) return { name, ratePerSeatYear, value: lead.value, estimated: false };
  if (ratePerSeatYear && seats > 0) {
    return { name, ratePerSeatYear, value: ratePerSeatYear * seats, estimated: true };
  }
  return { name, ratePerSeatYear, value: null, estimated: false };
}
