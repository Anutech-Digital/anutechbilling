/**
 * Items Catalog — list with vendor filter + CRUD + load-default-catalog action.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useItems, useDeleteItem, useLoadDefaultCatalog, useSyncHostingCatalog, useSyncDomainCatalog } from "@/lib/queries/items";
import { productCount } from "@/lib/items/catalog-state";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { OneTimeItemForm } from "@/components/features/items/one-time-item-form";
import { ItemForm } from "@/components/features/items/item-form";
import { CatalogUnitCheck } from "@/components/features/items/catalog-unit-check";
import { FAB } from "@/components/ui/fab";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { catalogCostCoverage } from "@/lib/catalog/cost-coverage";
import { workspaceListPriceGap, type ListPriceGap } from "@/lib/catalog/workspace-floor";
import { headlinePrice, headlineSuffix, isOwnService } from "@/lib/catalog/headline-price";
import { displaySku, avgMarginPerSeat } from "@/lib/catalog/item-display";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/providers/confirm-provider";
import { rupee } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { Item, PartnerCatalogRow, TenantWithParent } from "@/lib/supabase/database.types";
import { newestFirst } from "@/lib/sort/newest-first";

const VENDOR_TABS: TabBarItem[] = [
  { id: "all",       label: "All" },
  { id: "google",    label: "Google",    dot: "indigo" },
  { id: "microsoft", label: "Microsoft", dot: "indigo" },
  { id: "zoho",      label: "Zoho",      dot: "emerald" },
  { id: "other",     label: "Other",     dot: "slate" },
];

const KIND_TABS: TabBarItem[] = [
  { id: "all",   label: "All" },
  { id: "main",  label: "Main plans", dot: "amber" },
  { id: "addon", label: "Add-ons",    dot: "indigo" },
];

/** Compact rounded-pill filter chip — used for the vendor + type filter rows.
 *  No overflow container (unlike TabBar), so it never spawns a stray scrollbar. */
function FilterChip({
  label, count, active, dot, onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  dot?: "emerald" | "amber" | "rose" | "indigo" | "slate";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
        active
          ? "border-amber bg-amber-soft text-amber-ink"
          : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2",
      )}
    >
      {dot && (
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            dot === "emerald" && "bg-emerald",
            dot === "amber" && "bg-amber",
            dot === "rose" && "bg-rose",
            dot === "indigo" && "bg-indigo",
            dot === "slate" && "bg-slate",
          )}
        />
      )}
      <span>{label}</span>
      {count !== undefined && (
        <span className={cn("tabular-nums", active ? "text-amber-ink" : "text-ink-3")}>{count}</span>
      )}
    </button>
  );
}

export default function ItemsPage() {
  const { data: items, isLoading, error, refetch } = useItems({ includeInactive: true });
  const me = useCurrentUser().data;
  const syncHosting = useSyncHostingCatalog();
  const syncDomains = useSyncDomainCatalog();
  const deleteItem = useDeleteItem();
  const loadDefaults = useLoadDefaultCatalog();
  const confirm = useConfirm();

  /* /items and /items/subscriptions = subscription catalog, /items/products = product
     catalog — one page, three addresses; the menu row "Products" opens /items (R-384) and the tab keeps the URL in step. */
  const pathname = usePathname();
  const router = useRouter();
  const catalogType: "subscription" | "one_time" = pathname?.startsWith("/items/products") ? "one_time" : "subscription";
  const setCatalogType = (v: "subscription" | "one_time") => router.replace(v === "one_time" ? "/items/products" : "/items/subscriptions");
  const [vendor, setVendor] = React.useState("all");
  const [kind,   setKind]   = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Item | null>(null);
  const [oneTimeOpen, setOneTimeOpen] = React.useState(false);
  const [oneTimeEditing, setOneTimeEditing] = React.useState<Item | null>(null);

  // Two catalogs: subscription (recurring per-seat/mo) vs one-time products/services.
  const subItems     = (items ?? []).filter((it) => it.item_type !== "one_time");
  const oneTimeItems = (items ?? []).filter((it) => it.item_type === "one_time");

  const matchesSearch = (it: Item) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return it.name.toLowerCase().includes(s) || it.id.toLowerCase().includes(s);
  };

  /* Newest first, like every other table (Abhishek, 18 Sep 2026). `useItems` still
     fetches by vendor then price, because the SAME hook fills the plan dropdown in the
     Add Subscription dialog — there you are looking for a plan you already have in mind,
     and cheapest-to-dearest within a vendor is the order that helps. Reordering the
     query would have fixed this page and quietly damaged that picker. */
  // Filter (subscription catalog)
  const filtered = newestFirst(subItems.filter((it) => {
    if (vendor !== "all" && it.vendor !== vendor) return false;
    if (kind   !== "all" && it.kind   !== kind)   return false;
    return matchesSearch(it);
  }));

  const filteredOneTime = newestFirst(oneTimeItems.filter(matchesSearch));

  // Tab counts (subscription only)
  const counts: Record<string, number> = { all: subItems.length };
  for (const it of subItems) {
    counts[it.vendor] = (counts[it.vendor] ?? 0) + 1;
  }
  const tabsWithCounts = VENDOR_TABS.map((t) => ({ ...t, count: counts[t.id] ?? 0 }));

  // Kind tab counts
  const kindCounts: Record<string, number> = { all: subItems.length, main: 0, addon: 0 };
  for (const it of subItems) {
    kindCounts[it.kind] = (kindCounts[it.kind] ?? 0) + 1;
  }
  const kindTabsWithCounts = KIND_TABS.map((t) => ({ ...t, count: kindCounts[t.id] ?? 0 }));

  const CATALOG_TABS: TabBarItem[] = [
    { id: "subscription", label: "Subscriptions",     count: subItems.length },
    { id: "one_time",     label: "One-time products", count: oneTimeItems.length },
  ];

  // Aggregates (subscription)
  const active = subItems.filter((i) => i.is_active);

  /* ── Items with NO vendor cost recorded ────────────────────────────────────
     A wholesale of 0 is not a free product — it is a product nobody has told the
     app the cost of. Reported 12 Sep 2026 from the other end: /subscriptions says
     "10 subscriptions cannot be checked — no wholesale price in the catalog", and
     THIS page, the one you come to in order to fix that, showed a plain "₹0" with
     nothing marking it.

     It also silently corrupted the headline: margin_pct on a zero-cost row is 100%,
     so the average below counted those rows as perfect and read healthy while the
     margin engine was blind. They are excluded from the average now and counted
     separately — an average over the rows we actually know is a real number; an
     average that quietly includes invented ones is not. */
  const { priced, unpriced, avgMarginPct: avgMargin } = catalogCostCoverage(active);
  /* R-387: a Google Workspace row stored under the list price. Quotes, the lead form and the
     website already use the list price (the R-205 floor), so this page was the one place still
     showing ₹736 for a product every quote prices at ₹1,080. Named, with both numbers, so the
     owner fixes the row — the app never rewrites a stored price itself. */
  const listGaps = active.map((i) => workspaceListPriceGap(i)).filter((g): g is ListPriceGap => g !== null);
  /* R-472: over the same priced rows as "Avg margin %" — support (₹/yr, own service)
     used to be averaged in as ₹0 and halved this. */
  const totalMrr = avgMarginPerSeat(priced);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Products</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">
            {catalogType === "subscription" ? "Subscriptions" : "One-time products"}
          </h1>
          <p className="text-sm text-ink-3 mt-1">
            {catalogType === "subscription"
              ? "Recurring products (per-seat/month) · used in subscription quotes"
              : "One-time products & services · used in project quotes"}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Link href="/items/packages" className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper-2">
            <Icon name="package" size={14} /> Packages
          </Link>
          <div className="w-56">
            <Input
              prefix={<Icon name="search" size={14} />}
              aria-label="Search items"
              placeholder="Search items…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {catalogType === "subscription" && me?.role === "owner" && (
            <Button
              variant="outline"
              icon="refresh"
              loading={syncHosting.isPending}
              onClick={() => syncHosting.mutate()}
              title="Seed hosting plans into this catalogue — specs live from DirectAdmin, price from config"
            >
              Sync hosting
            </Button>
          )}
          {catalogType === "one_time" && me?.role === "owner" && (
            <Button
              variant="outline"
              icon="refresh"
              loading={syncDomains.isPending}
              onClick={() => syncDomains.mutate()}
              title="Pull the domain rate card from the engine (app.anutech.in) into this catalogue"
            >
              Sync domains
            </Button>
          )}
          {catalogType === "subscription" ? (
            <Button variant="primary" icon="plus" onClick={() => { setEditing(null); setAddOpen(true); }}>
              Add item
            </Button>
          ) : (
            <Button variant="primary" icon="plus" onClick={() => { setOneTimeEditing(null); setOneTimeOpen(true); }}>
              Add one-time item
            </Button>
          )}
        </div>
      </div>

      {/* Catalog switcher — two separate catalogs */}
      <TabBar value={catalogType} onChange={(v) => setCatalogType(v as "subscription" | "one_time")} items={CATALOG_TABS} />

      {catalogType === "one_time" ? (
        <OneTimeCatalog
          items={filteredOneTime}
          allCount={oneTimeItems.length}
          isLoading={isLoading}
          onAdd={() => { setOneTimeEditing(null); setOneTimeOpen(true); }}
          onEdit={(it) => { setOneTimeEditing(it); setOneTimeOpen(true); }}
          onDeactivate={async (it) => { if (await confirm({ title: `Deactivate ${it.name}?`, danger: true, confirmLabel: "Deactivate" })) deleteItem.mutate(it.id); }}
        />
      ) : (
      <>

      {/* Compact money-first stats — replaces the tall KPI grid so the list sits higher */}
      {!isLoading && items && items.length > 0 && (
        <StatStrip
          items={[
            { label: "Items", value: subItems.length },
            { label: "Active", value: active.length, tone: "emerald" },
            /* Says what it is an average OF. "Avg margin 58%" over a set that silently
               excluded a third of the catalogue would be the same lie in a new place. */
            {
              label: unpriced.length > 0 ? `Avg margin (${priced.length} priced)` : "Avg margin",
              value: `${avgMargin}%`,
              tone: avgMargin >= 18 ? "emerald" : avgMargin >= 14 ? "default" : "rose",
            },
            { label: "Avg margin ₹/seat", value: rupee(totalMrr) },
          ]}
        />
      )}

      {/* ── No cost price = no margin, anywhere in the app ─────────────────────
          Not a nag: this is the page that fixes the warning /subscriptions shows, and
          until 12 Sep 2026 there was nothing here connecting the two. Named products,
          because "some items are missing costs" sends the operator hunting. */}
      {!isLoading && unpriced.length > 0 && (
        <div className="rounded-xl border border-amber/40 bg-amber-soft/40 p-4">
          <p className="text-sm font-semibold text-amber-ink flex items-center gap-1.5">
            <Icon name="alert" size={15} />
            {unpriced.length} {unpriced.length === 1 ? "product has" : "products have"} no cost price
          </p>
          <p className="mt-1 text-xs text-ink-2 leading-relaxed">
            {unpriced.slice(0, 4).map((i) => i.name).join(", ")}
            {unpriced.length > 4 ? ` and ${unpriced.length - 4} more` : ""}
            {" — "}shown as ₹0 below. Their margin cannot be calculated, so the app cannot warn
            you when one is sold below cost, and they are left out of the average above.
            Edit each one and enter what your vendor charges you.
          </p>
        </div>
      )}

      {/* R-387 — catalogue price under the Google Workspace list price. */}
      {!isLoading && listGaps.length > 0 && (
        <div className="rounded-xl border border-amber/40 bg-amber-soft/40 p-4" role="status" data-testid="list-price-gap">
          <p className="text-sm font-semibold text-amber-ink flex items-center gap-1.5">
            <Icon name="alert" size={15} />
            {listGaps.length} {listGaps.length === 1 ? "price is" : "prices are"} below the list price
          </p>
          <ul className="mt-1 text-xs text-ink-2 leading-relaxed list-disc pl-5">
            {listGaps.map((g) => (
              <li key={g.itemId}>
                {g.name}: catalogue {rupee(g.catalogPm)}/seat/mo, list {rupee(g.listPm)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-2 leading-relaxed">
            Quotes, leads and the website use the list price. Edit these rows so this page shows
            what customers are charged.
          </p>
        </div>
      )}

      {/* R-526 — rows whose billing unit and name disagree (a domain billed per seat per month). */}
      {!isLoading && <CatalogUnitCheck items={subItems} onEdit={(it) => { setEditing(it); setAddOpen(true); }} />}

      {/* Filters — vendor + type as compact labelled chip rows (clear which is which) */}
      {!isLoading && items && items.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-14 shrink-0 text-3xs uppercase tracking-wider text-ink-3 font-semibold">Vendor</span>
            {tabsWithCounts.map((t) => (
              <FilterChip key={t.id} active={vendor === t.id} onClick={() => setVendor(t.id)} label={t.label} count={t.count} dot={t.dot} />
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="w-14 shrink-0 text-3xs uppercase tracking-wider text-ink-3 font-semibold">Type</span>
            {kindTabsWithCounts.map((t) => (
              <FilterChip key={t.id} active={kind === t.id} onClick={() => setKind(t.id)} label={t.label} count={t.count} dot={t.dot} />
            ))}
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load items"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1,2,3,4,5].map((i) => (
                <tr key={i} className="border-b border-hairline">
                  {[1,2,3,4,5].map((j) => (
                    <td key={j} className="p-3"><Skeleton className="h-3 w-full" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Only the seeded support tiers, no products yet — the empty state below never shows
          for such a tenant, so offer the default catalog here (lib/items/catalog-state.ts). */}
      {!isLoading && !error && items && items.length > 0 && productCount(items) === 0 && (
        <Card className="mb-4 p-4 flex flex-wrap items-center justify-between gap-3 border-amber/40 bg-amber-soft/20">
          <div>
            <p className="text-sm font-semibold text-ink">No products yet</p>
            <p className="text-xs text-ink-3">Only support plans (add-ons) are here. Load Google Workspace, Microsoft 365, Zoho and add-ons, then edit rates anytime.</p>
          </div>
          <Button variant="primary" icon="package" loading={loadDefaults.isPending} onClick={() => loadDefaults.mutate()}>
            Load default catalog
          </Button>
        </Card>
      )}

      {/* Empty — show load-default-catalog CTA */}
      {!isLoading && !error && items && items.length === 0 && (
        <EmptyState
          icon="package"
          title="No items in catalog yet"
          body="Load the default Indian reseller catalog (Google Workspace, Microsoft 365, Zoho) or add your own items manually."
          action={
            <Button
              variant="primary"
              icon="package"
              loading={loadDefaults.isPending}
              onClick={() => loadDefaults.mutate()}
            >
              Load default catalog (7 main + 8 add-ons)
            </Button>
          }
          secondary={
            <Button icon="plus" onClick={() => { setEditing(null); setAddOpen(true); }}>
              Add custom item
            </Button>
          }
        />
      )}

      {/* Filtered empty */}
      {!isLoading && !error && items && items.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon="search"
          title="No items match"
          body={search ? `No results for "${search}".` : `No ${kind !== "all" ? `${kind === "main" ? "main plans" : "add-ons"} ` : ""}items in ${vendor === "all" ? "this catalog" : vendor}.`}
          action={<Button icon="x" onClick={() => { setVendor("all"); setKind("all"); setSearch(""); }}>Clear filters</Button>}
        />
      )}

      {/* Mobile card list — phones only */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="md:hidden space-y-2 mb-3">
          {filtered.map((it) => (
            <li key={it.id}>
              <button
                type="button"
                onClick={() => { setEditing(it); setAddOpen(true); }}
                className={cn(
                  "block w-full text-left bg-paper border border-hairline rounded-lg p-3 active:bg-paper-2/50",
                  !it.is_active && "opacity-60"
                )}
              >
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink truncate">{it.name}</p>
                    <p className="font-mono text-2xs text-ink-3 mt-0.5" title={it.id}>{displaySku(it.id)}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-serif text-base tabular-nums text-ink">
                      {rupee(headlinePrice(it).amount)}<span className="text-3xs text-ink-3 font-sans">{headlineSuffix(it)}</span>
                    </p>
                    <p className="text-3xs text-ink-3">{isOwnService(it) ? "Own service" : `${it.margin_pct}% margin`}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-2 pt-2 border-t border-hairline/60">
                  <Badge kind={it.kind === "main" ? "warning" : "info"} size="sm" dot>
                    {it.kind === "main" ? "Main" : "Add-on"}
                  </Badge>
                  <Badge kind={it.vendor === "google" ? "info" : it.vendor === "microsoft" ? "info" : "success"} size="sm">
                    {it.vendor}
                  </Badge>
                  {!it.is_active && <Badge kind="muted" size="sm">Inactive</Badge>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Desktop table */}
      {!isLoading && !error && filtered.length > 0 && (
        <Card flush className="hidden md:block">
          <table className="w-full">
            <thead className="bg-paper-2 border-b border-hairline">
              <tr>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">ID</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Item</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Type</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Vendor</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">HSN</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Price</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Cost <span className="font-normal text-ink-3 normal-case">(/seat/mo)</span></th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Margin</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => {
                const margin = it.msrp - it.wholesale;
                const tone: "emerald" | "amber-ink" | "rose" =
                  it.margin_pct >= 18 ? "emerald" : it.margin_pct >= 14 ? "amber-ink" : "rose";
                return (
                  <tr
                    key={it.id}
                    onClick={() => { setEditing(it); setAddOpen(true); }}
                    className={cn(
                      "border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer transition-colors",
                      !it.is_active && "opacity-50"
                    )}
                  >
                    <td className="p-3 font-mono text-xs" title={it.id}>{displaySku(it.id)}</td>
                    <td className="p-3 font-medium text-sm">{it.name}</td>
                    <td className="p-3 text-sm">
                      {it.kind === "main" ? (
                        <Badge kind="warning" dot>Main</Badge>
                      ) : (
                        <Badge kind="info" dot>Add-on</Badge>
                      )}
                    </td>
                    <td className="p-3 text-sm capitalize">
                      <Badge kind={it.vendor === "google" ? "info" : it.vendor === "microsoft" ? "info" : "success"}>
                        {it.vendor}
                      </Badge>
                    </td>
                    <td className="p-3 font-mono text-xs text-ink-2">{it.hsn ?? "—"}</td>
                    <td className="p-3 text-right tabular-nums text-sm">
                      {rupee(headlinePrice(it).amount)}
                      {/* R-472: the unit sits on each row — support is priced per year. */}
                      <span className="text-3xs text-ink-3">{headlineSuffix(it)}</span>
                    </td>
                    <td className="p-3 text-right tabular-nums text-sm text-ink-3">
                      {/* "₹0" reads as a free product. It almost always means nobody has
                          entered the vendor's price — and that is what blinds the margin
                          check, so the cell has to say which of the two it is. Support is
                          our own service, so its ₹0 is real. */}
                      {it.wholesale > 0
                        ? rupee(it.wholesale)
                        : isOwnService(it)
                          ? "—"
                          : <span className="text-amber-ink font-medium">Not set</span>}
                    </td>
                    <td className="p-3 text-right">
                      {isOwnService(it) ? <span className="text-xs text-ink-3">Own service</span> : (
                      <div className={cn(
                        "tabular-nums text-sm font-medium",
                        tone === "emerald" && "text-emerald",
                        tone === "amber-ink" && "text-amber-ink",
                        tone === "rose" && "text-rose"
                      )}>
                        {rupee(margin)}
                        <div className="text-3xs">{it.margin_pct}%</div>
                      </div>
                      )}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                      {it.is_partner_visible && (
                        <Badge kind="warning" size="sm" title={`Partner wholesale: ${rupee(it.partner_price ?? 0)}/seat/mo`}>
                          Partner
                        </Badge>
                      )}
                      {it.synced_from_partner_id && (
                        <Badge kind="info" size="sm" title="Synced from your distributor">
                          Synced
                        </Badge>
                      )}
                      {it.is_active ? (
                        <Badge kind="success" dot>Active</Badge>
                      ) : (
                        <Badge kind="muted">Inactive</Badge>
                      )}
                      </div>
                    </td>
                    <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton icon="more_h" aria-label="More actions" size="sm" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => { setEditing(it); setAddOpen(true); }}>
                            <Icon name="edit" size={14} /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {it.is_active && (
                            <DropdownMenuItem
                              destructive
                              onClick={async () => {
                                if (await confirm({ title: `Deactivate ${it.name}?`, danger: true, confirmLabel: "Deactivate" })) {
                                  deleteItem.mutate(it.id);
                                }
                              }}
                            >
                              <Icon name="trash" size={14} /> Deactivate
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── Secondary reference — kept BELOW the list so the catalog stays primary ── */}
      {!isLoading && items && items.length > 0 && (
        <div className="pt-4 mt-2 border-t border-hairline space-y-4">
          {(() => {
            const lowMargin = (items ?? []).filter((i) => !isOwnService(i) && i.margin_pct < 14).length;
            return (
              <GeminiCard title="Catalog intelligence" compact>
                <b>{lowMargin} {lowMargin === 1 ? "item has" : "items have"} margin below 14%.</b>{" "}
                Negotiate better wholesale rates with vendors or consider deprioritizing these products.
              </GeminiCard>
            );
          })()}
          <PublicBuyPagesCard items={items} />
        </div>
      )}

      {/* From your distributor — only shows when this tenant has a parent
          (i.e. it's a sub-reseller of another tenant). Slice 1 — migration 0041. */}
      <PartnerCatalogSection />

      </>
      )}

      {/* Modals */}
      <ItemForm open={addOpen} onOpenChange={setAddOpen} item={editing ?? undefined} />
      <OneTimeItemForm open={oneTimeOpen} onOpenChange={setOneTimeOpen} item={oneTimeEditing} />

      {/* Mobile thumb-zone add — desktop uses the header button. */}
      <FAB
        icon="plus"
        label={catalogType === "subscription" ? "Add item" : "Add one-time item"}
        onClick={() =>
          catalogType === "subscription"
            ? (setEditing(null), setAddOpen(true))
            : (setOneTimeEditing(null), setOneTimeOpen(true))
        }
      />
    </div>
  );
}

/**
 * OneTimeCatalog — the "Items Catalog" view: one-off products/services.
 * Flat sale price + cost + HSN/SAC. No per-seat pricing, vendors, or margins grid.
 */
function OneTimeCatalog({
  items, allCount, isLoading, onAdd, onEdit, onDeactivate,
}: {
  items: Item[];
  allCount: number;
  isLoading: boolean;
  onAdd: () => void;
  onEdit: (it: Item) => void;
  onDeactivate: (it: Item) => void;
}) {
  if (isLoading) {
    return (
      <Card flush>
        <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-4 w-full" />)}</div>
      </Card>
    );
  }
  if (allCount === 0) {
    return (
      <EmptyState
        icon="package"
        title="No one-time items yet"
        body="Add one-off products or services you sell — custom software, setup, data migration, AMC, hardware. Use these in project quotes."
        action={<Button variant="primary" icon="plus" onClick={onAdd}>Add one-time item</Button>}
      />
    );
  }
  if (items.length === 0) {
    return <EmptyState icon="search" title="No items match" body="Try a different search." />;
  }
  return (
    <>
      {/* Mobile cards */}
      <ul className="md:hidden space-y-2">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => onEdit(it)}
              className={cn("block w-full text-left bg-paper border border-hairline rounded-lg p-3 active:bg-paper-2/50", !it.is_active && "opacity-60")}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink truncate">{it.name}</p>
                  <p className="font-mono text-2xs text-ink-3 mt-0.5">HSN/SAC {it.hsn ?? "—"}</p>
                </div>
                <p className="font-serif text-base tabular-nums text-ink shrink-0">{rupee(it.msrp)}</p>
              </div>
              {!it.is_active && <Badge kind="muted" size="sm" >Inactive</Badge>}
            </button>
          </li>
        ))}
      </ul>

      {/* Desktop table */}
      <Card flush className="hidden md:block">
        <table className="w-full">
          <thead className="bg-paper-2 border-b border-hairline">
            <tr>
              <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Item</th>
              <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">HSN / SAC</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Sale price</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Cost</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Margin</th>
              <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
              <th className="w-12"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const margin = it.msrp - it.wholesale;
              return (
                <tr
                  key={it.id}
                  onClick={() => onEdit(it)}
                  className={cn("border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer transition-colors", !it.is_active && "opacity-50")}
                >
                  <td className="p-3 font-medium text-sm">{it.name}</td>
                  <td className="p-3 font-mono text-xs text-ink-2">{it.hsn ?? "—"}</td>
                  <td className="p-3 text-right tabular-nums text-sm">{rupee(it.msrp)}</td>
                  <td className="p-3 text-right tabular-nums text-sm text-ink-3">
                      {/* "₹0" reads as a free product. It almost always means nobody has
                          entered the vendor's price — and that is what blinds the margin
                          check, so the cell has to say which of the two it is. */}
                      {it.wholesale > 0
                        ? rupee(it.wholesale)
                        : <span className="text-amber-ink font-medium">Not set</span>}
                    </td>
                  <td className="p-3 text-right tabular-nums text-sm text-emerald">{rupee(margin)}</td>
                  <td className="p-3">{it.is_active ? <Badge kind="success" dot>Active</Badge> : <Badge kind="muted">Inactive</Badge>}</td>
                  <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton icon="more_h" aria-label="More actions" size="sm" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onEdit(it)}><Icon name="edit" size={14} /> Edit</DropdownMenuItem>
                        {it.is_active && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive onClick={() => onDeactivate(it)}>
                              <Icon name="trash" size={14} /> Deactivate
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Public buy pages — quick-link card showing each vendor's landing
// ────────────────────────────────────────────────────────────────

interface BuyPageSpec {
  vendor:     "google" | "microsoft" | "zoho";
  href:       string;                            // for display only
  label:      string;
  status:     "live" | "soon";
  brandColor: string;
}

const BUY_PAGES: BuyPageSpec[] = [
  { vendor: "google",    href: "/buy/workspace", label: "Google Workspace", status: "live", brandColor: "#4285F4" },
  { vendor: "microsoft", href: "/buy/m365",      label: "Microsoft 365",    status: "soon", brandColor: "#0078D4" },
  { vendor: "zoho",      href: "/buy/zoho",      label: "Zoho",             status: "soon", brandColor: "#E42527" },
];

function PublicBuyPagesCard({ items }: { items: Item[] }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">
            Public buy pages
          </div>
          <h2 className="font-serif text-lg text-ink leading-tight">
            Where these items live online
          </h2>
          <p className="text-xs text-ink-3 mt-0.5 max-w-xl">
            These public landing pages pull pricing from this catalog automatically.
            Toggle an item&apos;s Active flag here → it appears / disappears on the buy page within seconds.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {BUY_PAGES.map((bp) => {
          const vendorItems = items.filter((it) => it.vendor === bp.vendor && it.kind === "main");
          const activeOnPage = vendorItems.filter((it) => it.is_active).length;
          return (
            <div
              key={bp.vendor}
              className="rounded-lg border border-hairline p-4 bg-paper-2/30 relative overflow-hidden"
            >
              {/* Brand accent stripe */}
              <div
                className="absolute top-0 left-0 right-0 h-1"
                style={{ background: bp.brandColor }}
              />
              <div className="flex items-start justify-between gap-2 mb-2">
                <div>
                  <div className="font-serif text-base text-ink leading-tight">{bp.label}</div>
                  <div className="text-2xs text-ink-3 font-mono mt-0.5">{bp.href}</div>
                </div>
                {bp.status === "live" ? (
                  <Badge kind="success" size="sm">Live</Badge>
                ) : (
                  <Badge kind="muted" size="sm">Coming soon</Badge>
                )}
              </div>
              <div className="text-xs text-ink-3 mb-3">
                <b className="text-ink">{activeOnPage}</b> of {vendorItems.length} {vendorItems.length === 1 ? "SKU" : "SKUs"} visible
                {activeOnPage === 0 && vendorItems.length > 0 && (
                  <span className="ml-1 text-amber-ink">· activate items below to show them</span>
                )}
              </div>
              {bp.status === "live" && bp.vendor === "google" ? (
                <div className="flex gap-2">
                  <Button asChild variant="default" size="sm" className="flex-1 justify-center">
                    <Link href="/buy/workspace" target="_blank" rel="noopener noreferrer">
                      <Icon name="external" size={12} className="mr-1.5" />
                      Open page
                    </Link>
                  </Button>
                </div>
              ) : (
                /* R-472: was a developer to-do note shown to the tenant; now a next step. */
                <div className="space-y-2">
                  <p className="text-2xs text-ink-3">
                    This buy page is not ready yet. Until it is, send these customers your enquiry form.
                  </p>
                  <Button asChild variant="default" size="sm" className="w-full justify-center">
                    <Link href="/enquiry" target="_blank" rel="noopener noreferrer">
                      <Icon name="external" size={12} className="mr-1.5" />
                      Open enquiry form
                    </Link>
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── Partner Catalog (Slice 1 — migration 0041) ──────────────────────────────

/**
 * PartnerCatalogSection — shows the parent distributor's partner-visible
 * items to a sub-reseller child tenant. One-click "Add to my catalog"
 * clones the row into the caller's items table with wholesale = parent's
 * partner_price.
 *
 * Renders nothing for tenants without a parent (i.e. peer / distributor
 * tenants). All RLS-safe — fetches via get_partner_catalog() RPC + writes
 * via sync_partner_item() RPC, both SECURITY DEFINER.
 */
function PartnerCatalogSection() {
  const qc = useQueryClient();

  // Pull caller's own catalog so we can detect name-matches (Slice 1E — avoid
  // creating "GW Plus" twice when the child already has it).
  const { data: ownItems } = useItems({ includeInactive: true });

  const { data: hierarchy } = useQuery({
    queryKey: ["tenant", "hierarchy", "items-page"],
    queryFn: async (): Promise<TenantWithParent | null> => {
      const supabase = createClient();
      const { data } = await supabase.rpc("get_my_tenant_with_parent");
      const row = Array.isArray(data) ? data[0] : data;
      return (row as TenantWithParent | undefined) ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });

  const hasParent = Boolean(hierarchy?.parent_tenant_id);

  const { data: catalog, isLoading } = useQuery({
    enabled: hasParent,
    queryKey: ["partner-catalog", hierarchy?.parent_tenant_id],
    queryFn: async (): Promise<PartnerCatalogRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("get_partner_catalog");
      if (error) throw error;
      return (data ?? []) as PartnerCatalogRow[];
    },
  });

  // Slice 1E — match-by-name lookup. We only flag existing rows that are
  // NOT already synced from a partner (otherwise it's just the idempotent
  // re-sync case, no confirmation needed).
  type DupState = { partnerRow: PartnerCatalogRow; existing: Item } | null;
  const [duplicate, setDuplicate] = React.useState<DupState>(null);

  const findExisting = React.useCallback((row: PartnerCatalogRow): Item | null => {
    if (!ownItems) return null;
    const target = row.name.trim().toLowerCase();
    return (
      ownItems.find(
        (i) =>
          i.synced_from_partner_id == null &&
          i.vendor === row.vendor &&
          i.kind === row.kind &&
          i.name.trim().toLowerCase() === target,
      ) ?? null
    );
  }, [ownItems]);

  const sync = useMutation({
    mutationFn: async (args: { partnerItemId: string; linkExistingId?: string | null }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("sync_partner_item", {
        p_partner_item_id:   args.partnerItemId,
        p_link_existing_id:  args.linkExistingId ?? null,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_id, vars) => {
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["partner-catalog"] });
      toast.success(
        vars.linkExistingId
          ? "Linked existing row · wholesale price synced from distributor"
          : "Added to your catalog · wholesale price synced",
      );
      setDuplicate(null);
    },
    onError: (err) => {
      toast.error((err as Error).message);
      setDuplicate(null);
    },
  });

  const handleAdd = (row: PartnerCatalogRow) => {
    const existing = findExisting(row);
    if (existing) {
      setDuplicate({ partnerRow: row, existing });
      return;
    }
    sync.mutate({ partnerItemId: row.id });
  };

  if (!hasParent) return null;

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink inline-flex items-center gap-2">
            <Icon name="link" size={14} className="text-ink-3" />
            From your distributor · {hierarchy?.parent_name ?? "Parent"}
            <Badge kind="info" size="sm">{catalog?.length ?? 0} SKUs</Badge>
          </p>
          <p className="text-xs text-ink-3 mt-1">
            Wholesale rates set by your distributor. One-click "Add" clones the SKU into your catalog —
            you set your own retail price (MSRP) later.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : !catalog || catalog.length === 0 ? (
        <p className="text-xs text-ink-3 italic">
          Your distributor hasn't made any SKUs partner-visible yet. Ask them to mark a few items &ldquo;Make visible to my sub-resellers&rdquo;.
        </p>
      ) : (
        <ul className="divide-y divide-hairline border border-hairline rounded-md overflow-hidden">
          {catalog.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-paper-2/40">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-ink truncate">{row.name}</span>
                  <Badge kind={row.vendor === "google" ? "info" : row.vendor === "microsoft" ? "info" : "success"} size="sm">
                    {row.vendor}
                  </Badge>
                  <Badge kind={row.kind === "main" ? "warning" : "info"} size="sm" dot>
                    {row.kind === "main" ? "Main" : "Add-on"}
                  </Badge>
                </div>
                <p className="text-2xs text-ink-3 mt-0.5 font-mono">{row.id}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-medium tabular-nums text-ink">
                  {rupee(row.partner_price ?? 0)}<span className="text-3xs text-ink-3 font-normal">/seat/mo</span>
                </p>
                <p className="text-3xs text-ink-3 tabular-nums">
                  = {rupee((row.partner_price ?? 0) * 12)}/yr
                </p>
              </div>
              <div className="shrink-0">
                {row.already_synced ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="refresh"
                    loading={sync.isPending && sync.variables?.partnerItemId === row.id}
                    onClick={() => sync.mutate({ partnerItemId: row.id })}
                    title="Re-sync wholesale price from distributor"
                  >
                    Re-sync
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    icon="plus"
                    loading={sync.isPending && sync.variables?.partnerItemId === row.id}
                    onClick={() => handleAdd(row)}
                  >
                    Add to my catalog
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Slice 1E — duplicate-name confirmation. Shown when the child clicks
          "Add to my catalog" on a partner item that visibly matches one they
          already have. Three outcomes: link, clone, cancel. */}
      {duplicate && (
        <DuplicateConfirmDialog
          state={duplicate}
          loading={sync.isPending}
          onLink={() =>
            sync.mutate({ partnerItemId: duplicate.partnerRow.id, linkExistingId: duplicate.existing.id })
          }
          onClone={() => sync.mutate({ partnerItemId: duplicate.partnerRow.id })}
          onCancel={() => setDuplicate(null)}
        />
      )}
    </Card>
  );
}

/** Confirmation dialog for the duplicate-name case in PartnerCatalogSection. */
function DuplicateConfirmDialog(props: {
  state: { partnerRow: PartnerCatalogRow; existing: Item };
  loading: boolean;
  onLink: () => void;
  onClone: () => void;
  onCancel: () => void;
}) {
  const { state: { partnerRow, existing }, loading, onLink, onClone, onCancel } = props;
  const newWholesale  = partnerRow.partner_price ?? 0;
  const wholesaleDiff = newWholesale - existing.wholesale;
  const diffTone =
    wholesaleDiff > 0 ? "text-rose"    :
    wholesaleDiff < 0 ? "text-emerald" : "text-ink-3";

  return (
    // Radix Dialog gives the focus trap, Escape-to-close and click-outside-to-close
    // (the old hand-made overlay closed on outside click too).
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent hideClose className="md:!max-w-md">
        <DialogHeader className="gap-0">
          <p className="text-xs uppercase tracking-wider text-amber-ink font-semibold mb-1 inline-flex items-center gap-1.5">
            <Icon name="alert" size={11} /> Duplicate detected
          </p>
          <DialogTitle className="font-serif text-lg text-ink mb-2">
            You already have "{existing.name}"
          </DialogTitle>
          <DialogDescription className="text-xs text-ink-3 mb-4 leading-relaxed">
            Your catalog already has a SKU that matches the distributor's
            ({existing.vendor} · {existing.kind}). What would you like to do?
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md bg-paper-2 p-3 text-xs space-y-1.5 mb-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-3">Existing wholesale</span>
            <span className="font-mono tabular-nums text-ink">{rupee(existing.wholesale)}/seat/mo</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-3">Distributor partner price</span>
            <span className="font-mono tabular-nums text-ink">{rupee(newWholesale)}/seat/mo</span>
          </div>
          <div className="flex items-center justify-between gap-3 pt-1.5 border-t border-hairline">
            <span className="text-ink-3">Change on link</span>
            <span className={cn("font-mono tabular-nums font-medium", diffTone)}>
              {wholesaleDiff > 0 ? "+" : ""}{rupee(wholesaleDiff)}/seat/mo
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Button variant="primary" icon="link" loading={loading} onClick={onLink}>
            Link existing row · use distributor pricing
          </Button>
          <Button variant="default" icon="plus" loading={loading} onClick={onClone}>
            Create a new (separate) row anyway
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
