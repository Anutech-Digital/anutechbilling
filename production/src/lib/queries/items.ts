/**
 * Items — TanStack Query hooks for product catalog (read + CRUD + load defaults).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { Item, Database } from "@/lib/supabase/database.types";
import { TIER_FALLBACK_MONTHLY } from "@/lib/pricing/workspace";
import type { BillingUnit } from "@/lib/catalog/billing-unit";

type ItemInsert = Database["public"]["Tables"]["items"]["Insert"];
type ItemUpdate = Database["public"]["Tables"]["items"]["Update"];

// ============================================================
// Read all items in current tenant
// ============================================================
export function useItems(opts?: { vendor?: Item["vendor"]; includeInactive?: boolean }) {
  return useQuery({
    queryKey: ["items", opts?.vendor ?? "all", opts?.includeInactive ?? false],
    queryFn: async (): Promise<Item[]> => {
      const supabase = createClient();
      let q = supabase.from("items").select("*").order("vendor").order("msrp");
      if (!opts?.includeInactive) q = q.eq("is_active", true);
      if (opts?.vendor) q = q.eq("vendor", opts.vendor);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ============================================================
// Helper: fetch current tenant_id
// ============================================================
async function currentTenantId() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) throw new Error("Not authenticated");
  const { data: me, error } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (error || !me) throw new Error("User not linked to a tenant");
  return me.tenant_id;
}

// ============================================================
// Create
// ============================================================
export function useCreateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<ItemInsert, "tenant_id">) => {
      const supabase = createClient();
      const tenantId = await currentTenantId();
      const { data, error } = await supabase
        .from("items")
        .insert({ ...input, tenant_id: tenantId })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      toast.success("Item added to catalog");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Update
// ============================================================
export function useUpdateItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: ItemUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("items")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      toast.success("Item updated");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Delete (soft — sets is_active = false)
// ============================================================
export function useDeleteItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("items").update({ is_active: false }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["items"] });
      toast("Item deactivated");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Load default Indian reseller catalog
// ============================================================
type CatalogEntry = {
  id: string;
  name: string;
  vendor: Item["vendor"];
  kind: "main" | "addon";
  /** Default price (typically annual — used by quote line items) */
  msrp: number;
  wholesale: number;
  hsn?: string;
  /** Per-commitment pricing — 2 underlying prices, billing variations derived in UI */
  prices: {
    monthly?: { msrp: number; wholesale: number };  // ₹/seat/mo, no commit
    annual?:  { msrp: number; wholesale: number };  // ₹/seat/mo, 1-yr commit (same whether billed monthly or yearly)
    /** R-526: how the price is billed — absent = per seat per month (lib/catalog/billing-unit.ts). */
    billing_unit?: BillingUnit;
  };
};

/**
 * Google Workspace list price (₹/seat/month, annual) — read from the single source in
 * lib/pricing/workspace.ts, never copied here. R-207: this seed used to say Starter 136 /
 * Standard 736 (an old promo), so every new tenant's catalogue quoted below list.
 */
const GW_LIST = {
  starter:  TIER_FALLBACK_MONTHLY.starter,
  standard: TIER_FALLBACK_MONTHLY.standard,
  plus:     TIER_FALLBACK_MONTHLY.plus,
} as const;

const DEFAULT_CATALOG: CatalogEntry[] = [
  // ─── Main items (7 core plans) — pricing matrix per Indian reseller market norms ───
  {
    id: "GW-STR", name: "Google Workspace Business Starter", vendor: "google", kind: "main",
    msrp: GW_LIST.starter, wholesale: 110,
    prices: {
      monthly: { msrp: 170, wholesale: 138 },  // No commit, ~25% premium for flex
      annual:  { msrp: GW_LIST.starter, wholesale: 110 },  // 1-yr commit, list price
    },
  },
  {
    id: "GW-STD", name: "Google Workspace Business Standard", vendor: "google", kind: "main",
    msrp: GW_LIST.standard, wholesale: 620,
    prices: {
      monthly: { msrp: 920, wholesale: 780 },
      annual:  { msrp: GW_LIST.standard, wholesale: 620 },
    },
  },
  {
    id: "GW-PLS", name: "Google Workspace Business Plus", vendor: "google", kind: "main",
    msrp: GW_LIST.plus, wholesale: 1150,
    prices: {
      monthly: { msrp: 1725, wholesale: 1450 },
      annual:  { msrp: GW_LIST.plus, wholesale: 1150 },
    },
  },
  {
    id: "M365-BB", name: "Microsoft 365 Business Basic", vendor: "microsoft", kind: "main",
    msrp: 200, wholesale: 165,
    prices: {
      monthly: { msrp: 235, wholesale: 195 },
      annual:  { msrp: 200, wholesale: 165 },
    },
  },
  {
    id: "M365-BS", name: "Microsoft 365 Business Standard", vendor: "microsoft", kind: "main",
    msrp: 990, wholesale: 820,
    prices: {
      monthly: { msrp: 1180, wholesale: 985 },
      annual:  { msrp: 990,  wholesale: 820 },
    },
  },
  {
    id: "M365-BP", name: "Microsoft 365 Business Premium", vendor: "microsoft", kind: "main",
    msrp: 1900, wholesale: 1620,
    prices: {
      monthly: { msrp: 2280, wholesale: 1950 },
      annual:  { msrp: 1900, wholesale: 1620 },
    },
  },
  {
    id: "ZW-STD", name: "Zoho Workplace Standard", vendor: "zoho", kind: "main",
    msrp: 120, wholesale: 95,
    prices: {
      monthly: { msrp: 150, wholesale: 120 },
      annual:  { msrp: 120, wholesale: 95 },
    },
  },

  // ─── Add-ons ───
  {
    id: "GW-ENT", name: "Google Workspace Enterprise (upgrade)", vendor: "google", kind: "addon",
    msrp: 2400, wholesale: 2050,
    prices: { annual: { msrp: 2400, wholesale: 2050 } },
  },
  {
    id: "GV-STD", name: "Google Voice Standard", vendor: "google", kind: "addon",
    msrp: 800, wholesale: 680,
    prices: { annual: { msrp: 800, wholesale: 680 } },
  },
  {
    id: "GV-PRM", name: "Google Voice Premier", vendor: "google", kind: "addon",
    msrp: 1600, wholesale: 1380,
    prices: { annual: { msrp: 1600, wholesale: 1380 } },
  },
  {
    id: "GW-APP-C", name: "AppSheet Core", vendor: "google", kind: "addon",
    msrp: 830, wholesale: 720,
    prices: { annual: { msrp: 830, wholesale: 720 } },
  },
  {
    id: "GW-STR-1TB", name: "+ 1TB Drive storage", vendor: "google", kind: "addon",
    msrp: 300, wholesale: 240,
    prices: { annual: { msrp: 300, wholesale: 240 } },
  },
  {
    id: "ZW-PRO", name: "Zoho Workplace Professional (upgrade)", vendor: "zoho", kind: "addon",
    msrp: 280, wholesale: 220,
    prices: { annual: { msrp: 280, wholesale: 220 } },
  },
  {
    id: "M365-EM", name: "M365 Email migration (one-time)", vendor: "microsoft", kind: "addon",
    msrp: 199, wholesale: 80, hsn: "998314",
    prices: { billing_unit: "one_time" },  // R-526: ₹199 once — never ×12 (owner, 9 Oct)
  },
  {
    id: "DOM-IN", name: "Domain registration (.in / .com / yr)", vendor: "other", kind: "addon",
    msrp: 999, wholesale: 650, hsn: "998399",
    prices: { billing_unit: "unit_year" },  // R-526: ₹999 per year per domain (owner, 9 Oct)
  },
];

export function useLoadDefaultCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const tenantId = await currentTenantId();

      // Generate tenant-scoped IDs so they don't collide with seeded tenant
      const tenantSuffix = tenantId.slice(0, 8);
      const rows: ItemInsert[] = DEFAULT_CATALOG.map((p) => ({
        id: `${p.id}-${tenantSuffix}`,
        tenant_id: tenantId,
        name: p.name,
        vendor: p.vendor,
        kind: p.kind,
        hsn: p.hsn ?? "998313",
        msrp: p.msrp,
        wholesale: p.wholesale,
        prices: p.prices,
      }));

      // Use insert with onConflict (idempotent — won't duplicate)
      const { data, error } = await supabase
        .from("items")
        .upsert(rows, { onConflict: "id", ignoreDuplicates: true })
        .select();
      if (error) throw error;
      return data ?? [];
    },
    onSuccess: (added) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      if (added && added.length > 0) {
        toast.success(`${added.length} default items added to catalog`);
      } else {
        toast.info("Catalog already loaded");
      }
    },
    onError: (err) => toastError(err),
  });
}

/**
 * Seed/refresh the hosting catalogue via POST /api/catalog/sync-hosting → the
 * owner-only, atomic `sync_hosting_catalog` RPC. Rewired 2 Sep 2026 to the two
 * directly-connected sources: SPECS (disk/bandwidth) from DirectAdmin live, and
 * PRICE/name/features from our own config (hosting-landing.ts). No longer needs
 * the DMS engine. A cost you set by hand on an item survives a re-sync.
 */
export function useSyncHostingCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<number> => {
      const res = await fetch("/api/catalog/sync-hosting", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { synced?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Hosting sync failed");
      return body.synced ?? 0;
    },
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      toast.success(
        n > 0
          ? `${n} hosting plan${n === 1 ? "" : "s"} catalogue me sync ho gaye (specs DirectAdmin se)`
          : "Koi DirectAdmin package priced plan se match nahi hua",
      );
    },
    onError: (err) =>
      toastError(err, {
        description: "DirectAdmin connection zaroori hai. Setup > Integrations me creds check karo.",
      }),
  });
}

/**
 * Pull the domain rate card from the DMS engine into this tenant's catalogue via
 * POST /api/catalog/sync-domains → the owner-only, atomic sync_domain_catalog
 * RPC. Each priced TLD becomes a one-time item. Same auto-sync rule as hosting;
 * live once app.anutech.in is deployed.
 */
export function useSyncDomainCatalog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<number> => {
      const res = await fetch("/api/catalog/sync-domains", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { synced?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Domain sync failed");
      return body.synced ?? 0;
    },
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      toast.success(
        n > 0
          ? `${n} domain (TLD) catalogue me sync ho gaye`
          : "Engine par abhi koi domain price nahi hai",
      );
    },
    onError: (err) =>
      toastError(err, {
        description: "app.anutech.in deploy hone ke baad hi ye chalega. Tab tak catalogue waise hi rahega.",
      }),
  });
}

export { DEFAULT_CATALOG };
