/**
 * R-251 — what the Settings "Reseller tier" card shows, from the tenant's OWN hierarchy row
 * (get_my_tenant_with_parent), never from hard-coded names.
 *
 * Before: every new owner saw "Master Distributor: Anutech Digital" and "Managed Subsidiary:
 * Excel Technologies" — our own two companies, printed for strangers. The fetched row was
 * read only for the badge.
 *
 * Rules:
 *   - independent reseller (no parent, not a distributor) → null: the card is hidden, there
 *     is nothing to say (most signups);
 *   - reseller with a parent → its parent's name (+ GSTIN when the RPC returns it);
 *   - distributor → this account named as the distributor.
 */
import type { TenantWithParent } from "@/lib/supabase/database.types";

export interface ResellerTierView {
  isDistributor: boolean;
  badge: "Distributor" | "Reseller";
  rows: { label: string; value: string }[];
}

export function resellerTierView(
  row: Pick<TenantWithParent, "name" | "tier" | "parent_tenant_id" | "parent_name" | "parent_gstin"> | null | undefined,
): ResellerTierView | null {
  if (!row) return null;
  const isDistributor = row.tier === "distributor";
  const hasParent = Boolean(row.parent_tenant_id);
  if (!isDistributor && !hasParent) return null;

  const self = row.name?.trim() || "This account";
  const rows: { label: string; value: string }[] = [];
  if (hasParent) {
    rows.push({ label: "Parent distributor", value: row.parent_name?.trim() || "Linked distributor" });
    if (row.parent_gstin?.trim()) rows.push({ label: "Parent GSTIN", value: row.parent_gstin.trim() });
  }
  rows.push({ label: isDistributor ? "Distributor" : "This account", value: self });
  return { isDistributor, badge: isDistributor ? "Distributor" : "Reseller", rows };
}
